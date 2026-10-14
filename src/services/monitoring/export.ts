import JSZip from "jszip";
import { getResult, getRows, resultId } from "../results-db";
import { buildTaskforceCsv, monitoringFilename } from ".";

export interface MonitoringExportItem {
  path: string;
  title: string;
  kode: number;
}

export interface MonitoringExportSummary {
  files: number;
  rows: number;
  /** Human-readable notes for queries that were left out or lost rows. */
  notes: string[];
}

/**
 * Exports the last complete result of each query as a taskforce CSV for the
 * monitoring app. Partial runs are never exported: the importer deletes rows
 * of the same kode that are missing from the file, so a truncated file would
 * remove valid anomalies.
 */
export async function exportMonitoring(items: MonitoringExportItem[], wilayahKey: string, archiveName: string): Promise<MonitoringExportSummary> {
  const outputs: { filename: string; csv: string }[] = [];
  const notes: string[] = [];
  let rows = 0;
  for (const item of items) {
    const record = await getResult(resultId(item.path, wilayahKey));
    const name = `T${item.kode} ${item.path}`;
    if (!record?.completeRunId || !record.completeAt) {
      notes.push(`${name}: belum ada run lengkap untuk wilayah ini.`);
      continue;
    }
    if (!record.completeRowCount) {
      notes.push(`${name}: 0 record, tidak diekspor.`);
      continue;
    }
    const result = buildTaskforceCsv({
      kode: item.kode,
      title: item.title,
      columns: record.columns ?? [],
      rows: await getRows(record.completeRunId),
      completedAt: record.completeAt,
    });
    if (result.skippedNoSls) {
      notes.push(result.mapping.kode_sls
        ? `${name}: ${result.skippedNoSls} baris dilewati, ${result.mapping.kode_sls} bukan kode SLS 16 digit.`
        : `${name}: ${result.skippedNoSls} baris dilewati, tidak ada kolom kode SLS (tambahkan level_6_full_code ke SELECT).`);
    }
    if (result.skippedNoId) notes.push(`${name}: ${result.skippedNoId} baris tanpa assignment_id dilewati.`);
    if (!result.exportedRows) continue;
    outputs.push({ filename: monitoringFilename(item.kode, item.title), csv: result.csv });
    rows += result.exportedRows;
  }

  if (outputs.length === 1) {
    const [only] = outputs;
    await download(only!.filename, new Blob([only!.csv], { type: "text/csv;charset=utf-8" }));
  } else if (outputs.length > 1) {
    const zip = new JSZip();
    for (const output of outputs) zip.file(output.filename, output.csv);
    const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    await download(`${archiveName}.zip`, new Blob([new Uint8Array(bytes)], { type: "application/zip" }));
  }
  return { files: outputs.length, rows, notes };
}

async function download(filename: string, blob: Blob): Promise<void> {
  const url = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({ url, filename: `QueryFlow-monitoring/${filename}`, saveAs: false, conflictAction: "uniquify" });
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
