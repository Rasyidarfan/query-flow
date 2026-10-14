import type { WilayahConfig } from "../../types";

/**
 * Taskforce CSV accepted by the monitoring app (rekap-muatan `/anomali`,
 * `anomali.parse_csv`). Every listed column must exist in the header; any
 * extra column is stored as `detail` by the importer.
 */
export const TASKFORCE_COLUMNS = [
  "kode_anomali", "nama_anomali", "assignment_id", "kode_sls", "nama_sls",
  "nama_objek", "no_objek", "status", "email_pencacah", "email_pengawas",
  "updated_at",
] as const;

type TaskforceColumn = (typeof TASKFORCE_COLUMNS)[number];

/** Source column candidates per taskforce column, in priority order (case-insensitive). */
const SOURCE_CANDIDATES: Partial<Record<TaskforceColumn, string[]>> = {
  assignment_id: ["assignment_id"],
  kode_sls: ["kode_sls", "kode_subsls", "idsubsls", "level_6_full_code"],
  nama_sls: ["nama_sls", "nama_subsls", "level_6_name"],
  nama_objek: ["nama_objek", "nama_usaha", "nama_kk", "nama_kepala_keluarga", "nama_dtsen", "nama"],
  no_objek: ["no_objek", "index1", "no_urut_kk", "no_urut"],
  status: ["status", "assignment_status_alias"],
  email_pencacah: ["email_pencacah", "email_petugas", "pencacah"],
  email_pengawas: ["email_pengawas", "pengawas"],
  updated_at: ["updated_at", "assignment_date_modified", "date_modified"],
};

/** Default first taskforce number for new queries; T1/T2 are already used by manual uploads. */
export const DEFAULT_KODE_START = 10;

export function wilayahKey(config: WilayahConfig): string {
  if (config.level2.length) return `L2:${[...config.level2].sort().join("|")}`;
  if (config.level1.length) return `L1:${[...config.level1].sort().join("|")}`;
  return "ALL";
}

export interface QueryStats {
  sqlHash: string;
  completeRuns: number;
  everRows: boolean;
}

/** Skip only when the same SQL has completed before and never returned a record. */
export function shouldSkipQuery(stats: QueryStats | undefined, sqlHash: string): boolean {
  return Boolean(stats && stats.sqlHash === sqlHash && stats.completeRuns > 0 && !stats.everRows);
}

/** Keeps existing codes and gives every new path the next free number >= start. */
export function assignKode(existing: Record<string, number>, paths: string[], start = DEFAULT_KODE_START): Record<string, number> {
  const next = { ...existing };
  const used = new Set(Object.values(next));
  let candidate = start;
  for (const path of paths) {
    if (next[path] !== undefined) continue;
    while (used.has(candidate)) candidate++;
    next[path] = candidate;
    used.add(candidate);
  }
  return next;
}

export interface TaskforceInput {
  kode: number;
  title: string;
  columns: string[];
  rows: unknown[][];
  /** Fallback for `updated_at` when the query has no timestamp column. */
  completedAt: string;
}

export interface TaskforceCsv {
  csv: string;
  totalRows: number;
  exportedRows: number;
  skippedNoId: number;
  skippedNoSls: number;
  /** Source column used for each taskforce column (undefined = not available). */
  mapping: Partial<Record<TaskforceColumn, string>>;
}

export function buildTaskforceCsv(input: TaskforceInput): TaskforceCsv {
  const lower = input.columns.map((column) => column.trim().toLowerCase());
  const mapping: Partial<Record<TaskforceColumn, string>> = {};
  const sourceIndex: Partial<Record<TaskforceColumn, number>> = {};
  for (const [target, candidates] of Object.entries(SOURCE_CANDIDATES) as [TaskforceColumn, string[]][]) {
    for (const candidate of candidates) {
      const index = lower.indexOf(candidate);
      if (index >= 0) {
        sourceIndex[target] = index;
        mapping[target] = input.columns[index];
        break;
      }
    }
  }
  const consumed = new Set(Object.values(sourceIndex));
  // Extra columns go to the importer's `detail`; skip names that would collide with the fixed header.
  const fixed = new Set<string>(TASKFORCE_COLUMNS);
  const extras = input.columns
    .map((name, index) => ({ name, index }))
    .filter(({ name, index }) => !consumed.has(index) && !fixed.has(name.trim().toLowerCase()));

  const lines = [toCsvLine([...TASKFORCE_COLUMNS, ...extras.map(({ name }) => name)])];
  let exportedRows = 0;
  let skippedNoId = 0;
  let skippedNoSls = 0;
  const kode = `T${input.kode}`;
  for (const row of input.rows) {
    const read = (target: TaskforceColumn): string => {
      const index = sourceIndex[target];
      return index === undefined ? "" : formatValue(row[index]);
    };
    const assignmentId = read("assignment_id");
    if (!assignmentId) {
      skippedNoId++;
      continue;
    }
    const kodeSls = read("kode_sls");
    if (!/^\d{16}$/.test(kodeSls)) {
      skippedNoSls++;
      continue;
    }
    lines.push(toCsvLine([
      kode,
      input.title,
      assignmentId,
      kodeSls,
      read("nama_sls"),
      read("nama_objek"),
      read("no_objek"),
      read("status"),
      read("email_pencacah"),
      read("email_pengawas"),
      read("updated_at") || input.completedAt,
      ...extras.map(({ index }) => formatValue(row[index])),
    ]));
    exportedRows++;
  }
  return {
    csv: `\uFEFF${lines.join("\r\n")}\r\n`,
    totalRows: input.rows.length,
    exportedRows,
    skippedNoId,
    skippedNoSls,
    mapping,
  };
}

export function monitoringFilename(kode: number, title: string): string {
  const slug = title.normalize("NFKD").replace(/[^\w]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "query";
  return `T${kode}_${slug}.csv`;
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value);
  return String(value).trim();
}

function toCsvLine(values: string[]): string {
  return values.map((value) => (/[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value)).join(",");
}
