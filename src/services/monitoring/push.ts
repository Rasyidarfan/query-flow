import type { WilayahConfig } from "../../types";
import { getResult, getRows, resultId } from "../results-db";
import { buildTaskforceCsv, monitoringFilename, wilayahKey } from ".";
import type { MonitoringExportItem } from "./export";
import type { MonitoringTarget } from "./target";

const REQUEST_TIMEOUT_MS = 120_000;

export interface PushSummary {
  pushed: number;
  rows: number;
  added: number;
  removed: number;
  /** Human-readable notes for queries that were left out, lost rows or failed. */
  notes: string[];
}

interface PushResponse {
  ok: boolean;
  error?: string;
  n_baris?: number;
  n_baru?: number;
  n_berubah?: number;
  n_hapus?: number;
}

async function callApi(target: MonitoringTarget, path: string, init: RequestInit = {}): Promise<PushResponse> {
  let response: Response;
  try {
    response = await fetch(`${target.url}${path}`, {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${target.token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`Tidak bisa menghubungi ${target.url}: ${error instanceof Error ? error.message : "network error"}`);
  }
  let body: PushResponse;
  try {
    body = await response.json() as PushResponse;
  } catch {
    throw new Error(`Respons ${response.status} dari ${target.url} bukan JSON — periksa URL target (aplikasi belum mendukung push?).`);
  }
  if (!response.ok || !body.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}

export async function pingTarget(target: MonitoringTarget): Promise<void> {
  await callApi(target, "/api/ping");
}

/**
 * Pushes the last complete result of each query to the monitoring app. Unlike
 * the CSV export, a 0-record result is pushed too: it tells the app that the
 * anomaly no longer has any rows, so the old rows of that kode are removed.
 * Partial runs are never pushed, and the app only removes rows inside the
 * pushed wilayah filter.
 */
export async function pushMonitoring(target: MonitoringTarget, items: MonitoringExportItem[], wilayah: WilayahConfig): Promise<PushSummary> {
  const summary: PushSummary = { pushed: 0, rows: 0, added: 0, removed: 0, notes: [] };
  const key = wilayahKey(wilayah);
  for (const item of items) {
    const name = `T${item.kode} ${item.path}`;
    const record = await getResult(resultId(item.path, key));
    if (!record?.completeRunId || !record.completeAt) {
      summary.notes.push(`${name}: belum ada run lengkap untuk wilayah ini, tidak dikirim.`);
      continue;
    }
    const result = buildTaskforceCsv({
      kode: item.kode,
      title: item.title,
      columns: record.columns ?? [],
      rows: record.completeRowCount ? await getRows(record.completeRunId) : [],
      completedAt: record.completeAt,
    });
    if (result.totalRows > 0 && result.exportedRows === 0) {
      // Sending an empty file here would wipe the kode on the server although the query did find rows.
      summary.notes.push(result.mapping.kode_sls
        ? `${name}: tidak dikirim, ${result.mapping.kode_sls} bukan kode SLS 16 digit.`
        : `${name}: tidak dikirim, tidak ada kolom kode SLS (tambahkan level_6_full_code ke SELECT).`);
      continue;
    }
    if (result.skippedNoSls) summary.notes.push(`${name}: ${result.skippedNoSls} baris tanpa kode SLS 16 digit dilewati.`);
    if (result.skippedNoId) summary.notes.push(`${name}: ${result.skippedNoId} baris tanpa assignment_id dilewati.`);
    try {
      const response = await callApi(target, "/api/anomali/taskforce", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kode: `T${item.kode}`,
          csv: result.csv,
          filename: monitoringFilename(item.kode, item.title),
          wilayah,
        }),
      });
      summary.pushed++;
      summary.rows += response.n_baris ?? result.exportedRows;
      summary.added += response.n_baru ?? 0;
      summary.removed += response.n_hapus ?? 0;
    } catch (error) {
      summary.notes.push(`${name}: gagal dikirim — ${error instanceof Error ? error.message : "error"}`);
    }
  }
  return summary;
}

export function formatPushSummary(summary: PushSummary): string {
  const head = summary.pushed
    ? `Push monitoring: ${summary.pushed} query · ${summary.rows.toLocaleString("id-ID")} baris (${summary.added.toLocaleString("id-ID")} baru, ${summary.removed.toLocaleString("id-ID")} dihapus).`
    : "Tidak ada hasil yang dikirim ke monitoring.";
  return [head, ...summary.notes].join("\n");
}
