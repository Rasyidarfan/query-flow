import type { QueryStats } from "../monitoring";

/**
 * QueryFlow's own result database (IndexedDB, local to the extension).
 *
 * - `results`: one record per query x wilayah with run statistics and a
 *   pointer to the rows of the last complete run.
 * - `chunks`: rows stored per run in page-sized chunks, keyed [runId, seq].
 * - `runs`: append-only run log (complete, partial, error).
 * - `kode`: taskforce code assigned to each query path.
 */
const DB_NAME = "queryflow";
const DB_VERSION = 1;

export interface ResultRecord extends QueryStats {
  id: string;
  path: string;
  folder: string;
  title: string;
  wilayahKey: string;
  lastStatus: RunStatus;
  lastRowCount: number;
  lastRunAt: string;
  lastMessage?: string;
  completeRunId?: string;
  completeRowCount?: number;
  completeAt?: string;
  columns?: string[];
}

export type RunStatus = "complete" | "partial" | "error";

export interface RunLogEntry {
  runId: string;
  resultId: string;
  path: string;
  wilayahKey: string;
  status: RunStatus;
  rowCount: number;
  startedAt: string;
  finishedAt: string;
  message?: string;
}

interface ChunkRecord {
  runId: string;
  seq: number;
  rows: unknown[][];
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("results")) db.createObjectStore("results", { keyPath: "id" });
      if (!db.objectStoreNames.contains("chunks")) db.createObjectStore("chunks", { keyPath: ["runId", "seq"] });
      if (!db.objectStoreNames.contains("runs")) db.createObjectStore("runs", { keyPath: "runId" });
      if (!db.objectStoreNames.contains("kode")) db.createObjectStore("kode", { keyPath: "path" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      dbPromise = null;
      reject(request.error ?? new Error("Database QueryFlow gagal dibuka."));
    };
  });
  return dbPromise;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Operasi database gagal."));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Transaksi database gagal."));
    tx.onabort = () => reject(tx.error ?? new Error("Transaksi database dibatalkan."));
  });
}

function chunkRange(runId: string): IDBKeyRange {
  return IDBKeyRange.bound([runId, 0], [runId, Number.MAX_SAFE_INTEGER]);
}

export function resultId(path: string, wilayahKey: string): string {
  return `${path}|${wilayahKey}`;
}

export async function getResult(id: string): Promise<ResultRecord | undefined> {
  const db = await openDb();
  return requestToPromise(db.transaction("results").objectStore("results").get(id)) as Promise<ResultRecord | undefined>;
}

export async function getAllResults(): Promise<ResultRecord[]> {
  const db = await openDb();
  return requestToPromise(db.transaction("results").objectStore("results").getAll()) as Promise<ResultRecord[]>;
}

export async function getRows(runId: string): Promise<unknown[][]> {
  const db = await openDb();
  const chunks = await requestToPromise(db.transaction("chunks").objectStore("chunks").getAll(chunkRange(runId))) as ChunkRecord[];
  return chunks.sort((a, b) => a.seq - b.seq).flatMap((chunk) => chunk.rows);
}

export async function getKodeMap(): Promise<Record<string, number>> {
  const db = await openDb();
  const entries = await requestToPromise(db.transaction("kode").objectStore("kode").getAll()) as { path: string; kode: number }[];
  return Object.fromEntries(entries.map((entry) => [entry.path, entry.kode]));
}

export async function saveKodeMap(map: Record<string, number>): Promise<void> {
  const db = await openDb();
  const tx = db.transaction("kode", "readwrite");
  const store = tx.objectStore("kode");
  store.clear();
  for (const [path, kode] of Object.entries(map)) store.put({ path, kode });
  await transactionDone(tx);
}

export async function countRuns(): Promise<number> {
  const db = await openDb();
  return requestToPromise(db.transaction("runs").objectStore("runs").count());
}

/** Removes every stored result, row and run log entry. Kode assignments are kept. */
export async function clearResults(): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(["results", "chunks", "runs"], "readwrite");
  for (const name of ["results", "chunks", "runs"]) tx.objectStore(name).clear();
  await transactionDone(tx);
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Records one query run. Rows are written as they arrive; on a complete run
 * the result record switches to the new rows and the previous rows are
 * deleted. Partial/error runs keep the last complete rows untouched.
 */
export class ResultRecorder {
  private seq = 0;
  private rowCount = 0;
  private columns: string[] = [];
  private readonly startedAt = new Date().toISOString();
  private readonly id: string;

  constructor(
    private readonly runId: string,
    private readonly meta: { path: string; folder: string; title: string; wilayahKey: string; sqlHash: string },
  ) {
    this.id = resultId(meta.path, meta.wilayahKey);
  }

  async append(columns: string[], rows: unknown[][]): Promise<void> {
    this.columns = columns;
    if (!rows.length) return;
    const db = await openDb();
    const tx = db.transaction("chunks", "readwrite");
    tx.objectStore("chunks").put({ runId: this.runId, seq: this.seq++, rows } satisfies ChunkRecord);
    await transactionDone(tx);
    this.rowCount += rows.length;
  }

  async finish(status: RunStatus, message?: string): Promise<ResultRecord> {
    const db = await openDb();
    const finishedAt = new Date().toISOString();
    const tx = db.transaction(["results", "chunks", "runs"], "readwrite");
    const results = tx.objectStore("results");
    const chunks = tx.objectStore("chunks");
    const previous = await requestToPromise(results.get(this.id)) as ResultRecord | undefined;
    const sameSql = previous?.sqlHash === this.meta.sqlHash;

    const record: ResultRecord = {
      ...(sameSql ? previous : undefined),
      id: this.id,
      ...this.meta,
      completeRuns: (sameSql ? previous?.completeRuns ?? 0 : 0) + (status === "complete" ? 1 : 0),
      everRows: (sameSql && Boolean(previous?.everRows)) || this.rowCount > 0,
      lastStatus: status,
      lastRowCount: this.rowCount,
      lastRunAt: finishedAt,
      lastMessage: message,
    };
    if (status === "complete") {
      record.completeRunId = this.runId;
      record.completeRowCount = this.rowCount;
      record.completeAt = finishedAt;
      record.columns = this.columns;
    } else {
      chunks.delete(chunkRange(this.runId));
    }
    // Rows of the previous complete run are obsolete once replaced, or once the SQL changed.
    if (previous?.completeRunId && previous.completeRunId !== record.completeRunId) {
      chunks.delete(chunkRange(previous.completeRunId));
    }
    results.put(record);
    tx.objectStore("runs").put({
      runId: this.runId,
      resultId: this.id,
      path: this.meta.path,
      wilayahKey: this.meta.wilayahKey,
      status,
      rowCount: this.rowCount,
      startedAt: this.startedAt,
      finishedAt,
      message,
    } satisfies RunLogEntry);
    await transactionDone(tx);
    return record;
  }
}
