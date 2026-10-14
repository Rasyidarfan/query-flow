import "./style.css";
import packageJson from "../../package.json";
import { ChunkedExport, collectQuery, EXPORT_CHECKPOINT_ROWS } from "../services/chunked-export";
import { SplitChunkedExport, validateSplitColumnInputs, type FolderExportOutput } from "../services/split-export";
import { applyWilayahConfig, extractSqlTitle } from "../services/sql";

let folderRunning = false;
import { loadFolderConfigs, loadSnapshot, loadWilayah, saveFolderConfigs, saveSnapshot, saveWilayah, type StoredFolderConfig } from "../services/storage";
import { groupSqlFiles, isSqlPath } from "../services/repository-sync/files";
import { addWilayahCode, validateWilayah } from "../services/wilayah";
import { assignKode, shouldSkipQuery, wilayahKey } from "../services/monitoring";
import { exportMonitoring } from "../services/monitoring/export";
import { formatPushSummary, pingTarget, pushMonitoring } from "../services/monitoring/push";
import { DEFAULT_TARGET, isTargetReady, loadTarget, normalizeBaseUrl, normalizeToken, originPattern, saveTarget, type MonitoringTarget } from "../services/monitoring/target";
import { RateLimiter } from "../services/rate-limit";
import { clearResults, countRuns, getAllResults, getKodeMap, resultId, ResultRecorder, saveKodeMap, sha256Hex, type ResultRecord, type RunStatus } from "../services/results-db";
import { TARGET, type ExtensionMessage, type RepositorySnapshot, type ScanResult, type SqlFile, type SqlRunProgress, type SqlChunkResponse, type SyncProgress, type WilayahConfig } from "../types";

/** SQL Lab executions allowed per rolling minute, shared by every Run and Run Folder. */
const SQL_REQUESTS_PER_MINUTE = 30;
const sqlLimiter = new RateLimiter(SQL_REQUESTS_PER_MINUTE, 60_000);

let snapshot: RepositorySnapshot | null = null;
let kodeMap: Record<string, number> = {};
let resultIndex = new Map<string, ResultRecord>();
let target: MonitoringTarget = { ...DEFAULT_TARGET };
const kodeBadges = new Map<string, HTMLButtonElement>();

type FolderOutcome = "done" | "stopped" | "failed" | "invalid";
/** Run Folder of each folder, so one button can run queries across every folder. */
const folderRunners = new Map<string, { run: (files: SqlFile[]) => Promise<FolderOutcome>; stop: () => void }>();
let everRunActive: { stop: () => void } | null = null;
let wilayah: WilayahConfig = { level1: [], level2: [] };
let folderConfigs: Record<string, StoredFolderConfig> = {};
let progress: SyncProgress = { phase: "idle", message: "Not synced" };
let wilayahError = "";
const runProgressTargets = new Map<string, (progress: SqlRunProgress) => void>();

function isContextInvalidated(error: unknown): boolean {
  return error instanceof Error && /extension context invalidated/i.test(error.message);
}

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("App container is missing.");

app.innerHTML = `
  <main class="panel">
    <header class="app-header">
      <div class="app-brandline">
        <span class="eyebrow">Chrome Extension</span>
        <span class="version-badge">v${packageJson.version}</span>
      </div>
      <h1>QueryFlow</h1>
      <p class="field-note">Integrasi · FASIH SQL Lab</p>
      <p class="field-note">Case 1 · SE2026 — Sensus Ekonomi 2026</p>
    </header>
    <section class="section" aria-labelledby="source-title">
      <div class="section-heading"><span>01</span><h2 id="source-title">Sumber SQL</h2></div>
      <div class="source-card">
        <p id="source-name" class="source-name">Belum ada folder SQL</p>
        <dl class="metadata">
          <div><dt>Branch</dt><dd id="branch">main</dd></div>
          <div><dt>Status</dt><dd id="status" class="status">Belum diimpor</dd></div>
          <div><dt>Commit</dt><dd id="commit">—</dd></div>
          <div><dt>File</dt><dd id="counts">0 SQL · 0 folder</dd></div>
          <div class="wide"><dt>Terakhir diperbarui</dt><dd id="synced-at">—</dd></div>
        </dl>
        <div id="progress" class="progress" aria-live="polite"></div>
        <div class="source-actions">
          <!-- Sync from GitLab sengaja dinonaktifkan. Sumber query aktif berasal dari impor folder lokal. -->
          <button id="import-folder" class="secondary-button" type="button">Import Folder SQL</button>
          <input id="folder-input" type="file" webkitdirectory multiple hidden />
        </div>
      </div>
    </section>
    <section class="section" aria-labelledby="wilayah-title">
      <div class="section-heading"><span>02</span><h2 id="wilayah-title">Filter Wilayah</h2></div>
      <div class="field">
        <label>Level 1 <span>/ Provinsi · kosong berarti semua</span></label>
        <div id="level1-list" class="code-list"></div>
        <div id="add-level1-row" class="add-row" hidden>
          <input id="new-level1" inputmode="numeric" autocomplete="off" placeholder="kode wilayah (PP)" />
          <button id="confirm-level1" type="button">Tambah</button>
        </div>
        <button id="show-level1-add" class="text-button" type="button">＋ Tambah Provinsi</button>
      </div>
      <div class="field">
        <label>Level 2 <span>/ Kabupaten/Kota · kosong berarti semua</span></label>
        <div id="level2-list" class="code-list"></div>
        <div id="add-level2-row" class="add-row" hidden>
          <input id="new-level2" inputmode="numeric" autocomplete="off" placeholder="kode wilayah (PPKK)" />
          <button id="confirm-level2" type="button">Tambah</button>
        </div>
        <button id="show-level2-add" class="text-button" type="button">＋ Tambah Kabupaten/Kota</button>
      </div>
      <p id="wilayah-error" class="error" aria-live="polite"></p>
      <p id="wilayah-mode" class="field-note"></p>
      <p id="wilayah-saved" class="saved" aria-live="polite"></p>
    </section>
    <section class="section groups-section" aria-labelledby="groups-title">
      <div class="section-heading"><span>03</span><h2 id="groups-title">Folder SQL</h2></div>
      <details class="run-guide">
        <summary><span class="help-icon">?</span><span>Panduan Run &amp; auto-loop</span></summary>
        <div class="run-guide-content">
          <p>Sekali Run, data diambil bertahap sampai selesai. Hasil besar otomatis diunduh menjadi beberapa file Excel bernomor.</p>
          <ul>
            <li>Tombol <strong>Run</strong> berubah menjadi <strong>Stop</strong> selama query berjalan.</li>
            <li>Editor SQL aktif akan diganti. Tetap buka tab SQL Lab dan side panel ini.</li>
            <li><strong>Stop</strong> atau error tetap mengunduh hasil yang sudah terkumpul sebagai Excel parsial.</li>
            <li>Opsi folder: atur baris awal (offset), batas total baris, dan pilih query yang ingin dijalankan.</li>
            <li><strong>Run Folder</strong> tetap mengunduh Excel parsial jika terjadi error atau dihentikan di tengah proses.</li>
          </ul>
        </div>
      </details>
      <div id="run-ever-box" class="run-ever" hidden>
        <button id="run-ever" class="secondary-button" type="button"></button>
        <p id="run-ever-status" class="progress" role="status"></p>
      </div>
      <div id="empty-groups" class="empty-state">Import folder SQL untuk melihat daftar query dan menjalankannya di FASIH SQL Lab.</div>
      <div id="groups" class="groups"></div>
    </section>
    <section class="section" aria-labelledby="db-title">
      <div class="section-heading"><span>04</span><h2 id="db-title">Database Hasil</h2></div>
      <div class="source-card">
        <p id="db-summary" class="db-summary">Memuat…</p>
        <p class="field-note">Hasil run lengkap terakhir per query &amp; wilayah disimpan di browser ini (IndexedDB) dan menjadi sumber Export Monitoring. Eksekusi SQL dibatasi ${SQL_REQUESTS_PER_MINUTE} request/menit.</p>
        <p id="db-status" class="progress" role="status"></p>
        <div class="source-actions">
          <button id="db-clear" class="secondary-button" type="button">Kosongkan Database Hasil</button>
        </div>
      </div>
    </section>
    <section class="section" aria-labelledby="target-title">
      <div class="section-heading"><span>05</span><h2 id="target-title">Aplikasi Monitoring</h2></div>
      <div class="source-card">
        <div class="config-field target-field">
          <label for="target-url">URL target</label>
          <input id="target-url" type="url" autocomplete="off" placeholder="https://se-meira.bps9702.com" />
        </div>
        <div class="config-field target-field">
          <label for="target-token">Token API</label>
          <input id="target-token" class="secret-input" type="text" autocomplete="off" spellcheck="false" data-1p-ignore data-lpignore="true" placeholder="Salin dari tombol Token API di halaman Anomali" />
        </div>
        <label class="advanced-settings-toggle">
          <input id="target-auto" type="checkbox" />
          <span>Push otomatis setelah run lengkap</span>
        </label>
        <p class="field-note">Hasil lengkap terakhir dikirim sebagai anomali taskforce (kode T…) ke halaman Anomali. Hasil 0 record menghapus anomali kode itu di wilayah yang sama.</p>
        <p id="target-status" class="progress" role="status"></p>
        <div class="source-actions">
          <button id="target-save" class="secondary-button" type="button">Simpan &amp; Tes Koneksi</button>
        </div>
      </div>
    </section>
    <footer class="author-credit">
      Initiated by <a href="https://github.com/d-agung-sungkono" target="_blank" rel="noopener">D. Agung Sungkono</a>
      · Fork by <a href="https://github.com/Rasyidarfan" target="_blank" rel="noopener">Ahmad Arfan</a>
    </footer>
  </main>
  <dialog id="preview-dialog">
    <div class="dialog-header"><div><span id="preview-path"></span><h3 id="preview-name"></h3></div><button id="close-preview" aria-label="Tutup">×</button></div>
    <pre id="preview-content"></pre>
  </dialog>
`;

const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
};

const syncButton = document.querySelector<HTMLButtonElement>("#sync");
const importButton = byId<HTMLButtonElement>("import-folder");
const folderInput = byId<HTMLInputElement>("folder-input");
const newLevel1Input = byId<HTMLInputElement>("new-level1");
const newLevel2Input = byId<HTMLInputElement>("new-level2");

async function initialize(): Promise<void> {
  [snapshot, wilayah, folderConfigs] = await Promise.all([loadSnapshot(), loadWilayah(), loadFolderConfigs()]);
  progress = snapshot
    ? { phase: "success", message: snapshot.repository.namespace === "local-folder" ? "Imported" : "Synced" }
    : { phase: "idle", message: "Belum diimpor" };
  try {
    await loadResultDatabase();
  } catch (error) {
    byId("db-status").textContent = error instanceof Error ? `Database hasil tidak tersedia: ${error.message}` : "Database hasil tidak tersedia.";
  }
  target = await loadTarget();
  renderTarget();
  render();
}

function renderTarget(): void {
  byId<HTMLInputElement>("target-url").value = target.url;
  byId<HTMLInputElement>("target-token").value = target.token;
  byId<HTMLInputElement>("target-auto").checked = target.autoPush;
  for (const button of document.querySelectorAll<HTMLButtonElement>(".push-monitoring-button")) {
    button.title = isTargetReady(target) ? `Kirim ke ${target.url}` : "Atur URL target & token di bagian 05 Aplikasi Monitoring.";
  }
}

/**
 * Pushes one query right after a complete run when auto-push is on. Returns a
 * note for the status line; push failures never fail the SQL run itself.
 */
async function autoPush(file: SqlFile, runWilayah: WilayahConfig): Promise<{ pushed: boolean; note: string }> {
  const kode = kodeMap[file.path];
  if (!target.autoPush || !isTargetReady(target) || kode === undefined) return { pushed: false, note: "" };
  if (resultIndex.get(resultId(file.path, wilayahKey(runWilayah)))?.lastStatus !== "complete") return { pushed: false, note: "" };
  try {
    const summary = await pushMonitoring(target, [{ path: file.path, title: extractSqlTitle(file.content, file.name), kode }], runWilayah);
    return { pushed: summary.pushed > 0, note: summary.notes.join(" ") };
  } catch (error) {
    return { pushed: false, note: `Push monitoring gagal: ${error instanceof Error ? error.message : "error"}` };
  }
}

async function loadResultDatabase(): Promise<void> {
  const [kode, results] = await Promise.all([getKodeMap(), getAllResults()]);
  resultIndex = new Map(results.map((record) => [record.id, record]));
  kodeMap = kode;
  await ensureKodeAssigned();
}

/** Every imported query gets a stable taskforce code; existing codes never change. */
async function ensureKodeAssigned(): Promise<void> {
  const paths = (snapshot?.groups ?? []).flatMap((group) => group.files.map((file) => file.path));
  const next = assignKode(kodeMap, paths);
  if (Object.keys(next).length !== Object.keys(kodeMap).length) {
    kodeMap = next;
    await saveKodeMap(kodeMap);
  }
}

async function renderDatabase(): Promise<void> {
  const records = [...resultIndex.values()];
  const complete = records.filter((record) => record.completeRunId);
  const rows = complete.reduce((sum, record) => sum + (record.completeRowCount ?? 0), 0);
  const withRows = complete.filter((record) => (record.completeRowCount ?? 0) > 0).length;
  let runs = 0;
  try {
    runs = await countRuns();
  } catch {
    // The summary stays usable without the run count.
  }
  byId("db-summary").textContent = records.length
    ? `${complete.length} hasil lengkap (${withRows} berisi record) · ${rows.toLocaleString("id-ID")} baris · ${runs.toLocaleString("id-ID")} run tercatat`
    : "Belum ada hasil tersimpan.";
}

function badgeText(path: string): { text: string; title: string } {
  const kode = kodeMap[path];
  const record = resultIndex.get(resultId(path, wilayahKey(wilayah)));
  const prefix = kode === undefined ? "T?" : `T${kode}`;
  if (!record) return { text: `${prefix} · —`, title: "Belum pernah dijalankan untuk filter wilayah ini." };
  const completed = record.completeAt ? `Run lengkap terakhir: ${formatDate(record.completeAt)} · ${record.completeRowCount ?? 0} record.` : "Belum ada run lengkap.";
  const last = record.lastStatus === "complete" ? "" : ` Run terakhir ${record.lastStatus === "partial" ? "dihentikan" : "gagal"}: ${record.lastMessage ?? ""}`;
  const text = record.completeRunId
    ? `${prefix} · ${(record.completeRowCount ?? 0).toLocaleString("id-ID")} rec`
    : `${prefix} · ${record.lastStatus === "partial" ? "parsial" : "gagal"}`;
  return { text, title: `${completed}${last} Klik untuk mengganti kode anomali.` };
}

function refreshBadge(path: string): void {
  const badge = kodeBadges.get(path);
  if (!badge) return;
  const { text, title } = badgeText(path);
  badge.textContent = text;
  badge.title = title;
  badge.classList.toggle("is-empty", resultIndex.get(resultId(path, wilayahKey(wilayah)))?.completeRowCount === 0);
}

async function editKode(path: string): Promise<void> {
  const current = kodeMap[path];
  const input = window.prompt(`Kode anomali taskforce untuk\n${path}\n\nMasukkan angka (tanpa huruf T):`, current === undefined ? "" : String(current));
  if (input === null) return;
  const value = Number(input.trim().replace(/^T/i, ""));
  if (!Number.isInteger(value) || value < 1 || value > 9999) {
    window.alert("Kode harus bilangan bulat 1–9999.");
    return;
  }
  const owner = Object.entries(kodeMap).find(([other, kode]) => kode === value && other !== path)?.[0];
  if (owner) {
    window.alert(`T${value} sudah dipakai oleh ${owner}.`);
    return;
  }
  kodeMap = { ...kodeMap, [path]: value };
  await saveKodeMap(kodeMap);
  refreshBadge(path);
}

/** Records rows in the result database without letting a storage failure abort the SQL run. */
function createRecorder(runId: string, file: SqlFile, folder: string, sqlHash: string, warn: (message: string) => void) {
  const recorder = new ResultRecorder(runId, {
    path: file.path,
    folder,
    title: extractSqlTitle(file.content, file.name),
    wilayahKey: wilayahKey(wilayah),
    sqlHash,
  });
  let failed = false;
  let finished = false;
  const report = (error: unknown): void => {
    failed = true;
    warn(`Database hasil gagal menyimpan: ${error instanceof Error ? error.message : "error"}`);
  };
  return {
    append: async (columns: string[], rows: unknown[][]): Promise<void> => {
      if (failed) return;
      try {
        await recorder.append(columns, rows);
      } catch (error) {
        report(error);
      }
    },
    finish: async (status: RunStatus, message?: string): Promise<void> => {
      // Later failures (e.g. the Excel download) must not overwrite a recorded run.
      if (finished) return;
      finished = true;
      // A run whose rows were not all stored must not become the "complete" result.
      const finalStatus = failed && status === "complete" ? "error" : status;
      try {
        const record = await recorder.finish(finalStatus, failed ? "Sebagian baris gagal disimpan ke database." : message);
        resultIndex.set(record.id, record);
        refreshBadge(file.path);
        updateRunEverButton();
        void renderDatabase();
      } catch (error) {
        report(error);
      }
    },
  };
}

/**
 * Wraps a chunk request with the shared SQL Lab rate limit. Continuation
 * chunks only read rows already held by SQL Lab, so they are not counted.
 */
function rateLimited(
  send: (offset: number, limit: number, iteration: number) => Promise<SqlChunkResponse>,
  report: (message: string) => void,
  signal: AbortSignal,
): (offset: number, limit: number, iteration: number) => Promise<SqlChunkResponse> {
  let continuation = false;
  return async (offset, limit, iteration) => {
    if (!continuation) {
      await sqlLimiter.acquire(signal, (ms) => report(`Batas ${SQL_REQUESTS_PER_MINUTE} request/menit tercapai — lanjut dalam ${Math.ceil(ms / 1000)} detik…`));
    }
    const response = await send(offset, limit, iteration);
    continuation = response.ok && Boolean(response.continuation);
    return response;
  };
}

function render(): void {
  renderSource();
  renderWilayah();
  renderGroups();
  void renderDatabase();
}

function renderSource(): void {
  byId("source-name").textContent = snapshot?.repository.name ?? "Belum ada folder SQL";
  byId("branch").textContent = snapshot?.repository.branch ?? TARGET.defaultBranch;
  const status = byId("status");
  status.textContent = progress.phase === "success" ? `✓ ${progress.message}` : progress.message;
  status.className = `status status-${progress.phase}`;
  byId("commit").textContent = snapshot?.repository.commit?.slice(0, 8) ?? "—";
  byId("counts").textContent = `${snapshot?.repository.sqlCount ?? 0} SQL · ${snapshot?.groups.length ?? 0} folder`;
  byId("synced-at").textContent = snapshot ? formatDate(snapshot.repository.syncedAt) : "—";
  const progressElement = byId("progress");
  const showDetail = !["idle", "success"].includes(progress.phase);
  progressElement.textContent = showDetail
    ? `${progress.message}${progress.phase === "error" && snapshot ? " Last successful snapshot preserved." : ""}`
    : "";
  progressElement.classList.toggle("progress-error", progress.phase === "error");
  const busy = ["connecting", "scanning", "reading", "saving"].includes(progress.phase);
  if (syncButton) syncButton.disabled = busy;
  importButton.disabled = busy;
}

function renderWilayah(): void {
  renderCodeList("level1-list", "Level 1", wilayah.level1, (index, code) => updateCode("level1", index, code), (index) => removeCode("level1", index));
  renderCodeList("level2-list", "Level 2", wilayah.level2, (index, code) => updateCode("level2", index, code), (index) => removeCode("level2", index));
  byId("wilayah-error").textContent = wilayahError;
  byId("wilayah-mode").textContent = wilayah.level2.length > 0 && wilayah.level1.length > 0
    ? "Filter aktif: Kabupaten/Kota. Daftar provinsi diabaikan selama Level 2 terisi."
    : wilayah.level2.length > 0
      ? "Filter aktif: Kabupaten/Kota."
      : wilayah.level1.length > 0
        ? "Filter aktif: seluruh Kabupaten/Kota dalam provinsi terpilih."
        : "Filter wilayah kosong: semua wilayah akan dijalankan.";
}

function renderCodeList(
  elementId: string,
  label: string,
  codes: string[],
  update: (index: number, code: string) => void,
  removeCodeAt: (index: number) => void,
): void {
  const list = byId(elementId);
  list.replaceChildren();
  codes.forEach((code, index) => {
    const row = document.createElement("div");
    row.className = "code-row";
    const input = document.createElement("input");
    input.inputMode = "numeric";
    input.value = code;
    input.placeholder = label === "Level 1" ? "kode wilayah (PP)" : "kode wilayah (PPKK)";
    input.setAttribute("aria-label", `Kode ${label} ${index + 1}`);
    input.addEventListener("change", () => update(index, input.value));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `Hapus ${code}`);
    remove.addEventListener("click", () => removeCodeAt(index));
    row.append(input, remove);
    list.append(row);
  });
}

function renderGroups(): void {
  const groupsElement = byId("groups");
  groupsElement.replaceChildren();
  kodeBadges.clear();
  folderRunners.clear();
  byId("empty-groups").hidden = Boolean(snapshot?.groups.length);
  for (const group of snapshot?.groups ?? []) {
    const currentConfig = folderConfigs[group.path] ?? {};
    const allPaths = group.files.map((file) => file.path);
    const selectedPaths = new Set<string>(
      currentConfig.selectedPaths !== undefined
        ? currentConfig.selectedPaths.filter((path) => allPaths.includes(path))
        : allPaths
    );
    const configuredStartRow = typeof currentConfig.startRow === "number" && currentConfig.startRow >= 1 ? currentConfig.startRow : 1;
    const configuredMaxRows = typeof currentConfig.maxRows === "number" && currentConfig.maxRows > 0 ? currentConfig.maxRows : undefined;
    const configuredCheckpointRows = typeof currentConfig.checkpointRows === "number" && currentConfig.checkpointRows > 0
      ? Math.floor(currentConfig.checkpointRows)
      : EXPORT_CHECKPOINT_ROWS;
    let advancedSettings = typeof currentConfig.advancedSettings === "boolean"
      ? currentConfig.advancedSettings
      : configuredStartRow !== 1 || configuredMaxRows !== undefined || configuredCheckpointRows !== EXPORT_CHECKPOINT_ROWS;
    let startRow = advancedSettings ? configuredStartRow : 1;
    let maxRows = advancedSettings ? configuredMaxRows : undefined;
    let checkpointRows = advancedSettings ? configuredCheckpointRows : EXPORT_CHECKPOINT_ROWS;
    const configuredSplitColumns = Array.isArray(currentConfig.splitColumns) ? currentConfig.splitColumns : [];
    let splitColumn1 = typeof configuredSplitColumns[0] === "string" ? configuredSplitColumns[0] : "";
    let splitColumn2 = typeof configuredSplitColumns[1] === "string" ? configuredSplitColumns[1] : "";
    let splitEnabled = typeof currentConfig.splitEnabled === "boolean" ? currentConfig.splitEnabled : Boolean(splitColumn1);
    let skipEmpty = currentConfig.skipEmpty === true;

    const details = document.createElement("details");
    details.className = "group";
    const summary = document.createElement("summary");
    const heading = document.createElement("span");
    heading.className = "group-name";
    const repeatedName = (snapshot?.groups ?? []).filter((candidate) => candidate.name === group.name).length > 1;
    heading.textContent = repeatedName ? group.path.replaceAll("/", " / ") : group.name;
    const meta = document.createElement("span");
    meta.className = "group-count";
    meta.textContent = `${group.path} · ${group.files.length} SQL file${group.files.length === 1 ? "" : "s"}`;
    summary.append(heading, meta);

    const files = document.createElement("div");
    files.className = "file-list";

    // Folder Options: Start Row & Max Rows, Query Selection
    const configBox = document.createElement("div");
    configBox.className = "folder-config-box";

    const advancedSettingsLabel = document.createElement("label");
    advancedSettingsLabel.className = "advanced-settings-toggle";
    const advancedSettingsInput = document.createElement("input");
    advancedSettingsInput.type = "checkbox";
    advancedSettingsInput.checked = advancedSettings;
    const advancedSettingsText = document.createElement("span");
    advancedSettingsText.textContent = "Advanced settings";
    advancedSettingsLabel.append(advancedSettingsInput, advancedSettingsText);

    const rowGroup = document.createElement("div");
    rowGroup.className = "config-row-group";
    const advancedSettingsContent = document.createElement("div");
    advancedSettingsContent.className = "advanced-settings-content";

    const startRowField = document.createElement("div");
    startRowField.className = "config-field";
    const startRowLabel = document.createElement("label");
    startRowLabel.textContent = "Mulai baris";
    const startRowInput = document.createElement("input");
    startRowInput.type = "number";
    startRowInput.min = "1";
    startRowInput.placeholder = "1 (awal)";
    startRowInput.value = String(startRow);
    startRowInput.title = "Baris awal pengambilan data (1-based offset)";
    startRowField.append(startRowLabel, startRowInput);

    const maxRowsField = document.createElement("div");
    maxRowsField.className = "config-field";
    const maxRowsLabel = document.createElement("label");
    maxRowsLabel.textContent = "Batas baris";
    const maxRowsInput = document.createElement("input");
    maxRowsInput.type = "number";
    maxRowsInput.min = "1";
    maxRowsInput.placeholder = "Semua (tanpa batas)";
    maxRowsInput.value = maxRows !== undefined ? String(maxRows) : "";
    maxRowsInput.title = "Total maksimal baris sebelum berhenti mengambil data";
    maxRowsField.append(maxRowsLabel, maxRowsInput);

    const checkpointRowsField = document.createElement("div");
    checkpointRowsField.className = "config-field";
    const checkpointRowsLabel = document.createElement("label");
    checkpointRowsLabel.textContent = "Unduh tiap X baris";
    const checkpointRowsInput = document.createElement("input");
    checkpointRowsInput.type = "number";
    checkpointRowsInput.min = "1";
    checkpointRowsInput.step = "10000";
    checkpointRowsInput.value = String(checkpointRows);
    checkpointRowsInput.title = "Unduh bagian Excel setelah jumlah baris ini terkumpul di folder";
    checkpointRowsField.append(checkpointRowsLabel, checkpointRowsInput);

    rowGroup.append(startRowField, maxRowsField, checkpointRowsField);

    const splitSettings = document.createElement("div");
    splitSettings.className = "split-settings";
    const splitSettingsLabel = document.createElement("label");
    splitSettingsLabel.className = "advanced-settings-toggle split-settings-toggle";
    const splitSettingsInput = document.createElement("input");
    splitSettingsInput.type = "checkbox";
    splitSettingsInput.checked = splitEnabled;
    const splitSettingsText = document.createElement("span");
    splitSettingsText.textContent = "Split Excel by column";
    splitSettingsLabel.append(splitSettingsInput, splitSettingsText);

    const splitColumnFields = document.createElement("div");
    splitColumnFields.className = "split-column-fields";
    const splitColumn1Field = document.createElement("div");
    splitColumn1Field.className = "config-field";
    const splitColumn1Label = document.createElement("label");
    splitColumn1Label.textContent = "Pisahkan berdasarkan kolom";
    const splitColumn1Input = document.createElement("input");
    splitColumn1Input.type = "text";
    splitColumn1Input.value = splitColumn1;
    splitColumn1Input.placeholder = "Contoh: kode_kabupaten";
    splitColumn1Input.autocomplete = "off";
    splitColumn1Input.setAttribute("aria-label", "Kolom pertama untuk memisahkan hasil Excel");
    splitColumn1Field.append(splitColumn1Label, splitColumn1Input);

    const splitColumn2Field = document.createElement("div");
    splitColumn2Field.className = "config-field split-column-field";
    const splitColumn2Label = document.createElement("label");
    splitColumn2Label.textContent = "Kolom kedua (opsional)";
    const splitColumn2Input = document.createElement("input");
    splitColumn2Input.type = "text";
    splitColumn2Input.value = splitColumn2;
    splitColumn2Input.placeholder = "Contoh: kategori";
    splitColumn2Input.autocomplete = "off";
    splitColumn2Input.setAttribute("aria-label", "Kolom kedua untuk memisahkan hasil Excel");
    splitColumn2Field.append(splitColumn2Label, splitColumn2Input);
    splitColumnFields.append(splitColumn1Field, splitColumn2Field);

    const splitColumnNote = document.createElement("p");
    splitColumnNote.className = "split-column-note";
    splitColumnNote.textContent = "Kolom pertama wajib; kolom kedua opsional. Nama kolom divalidasi dari hasil SQL.";
    splitSettings.append(splitSettingsLabel, splitColumnFields, splitColumnNote);
    advancedSettingsContent.append(rowGroup, splitSettings);

    const toolbar = document.createElement("div");
    toolbar.className = "config-selection-toolbar";
    const selectionBadge = document.createElement("span");
    selectionBadge.className = "selection-badge";

    const selectionActions = document.createElement("div");
    selectionActions.className = "selection-actions";
    const selectAllBtn = document.createElement("button");
    selectAllBtn.type = "button";
    selectAllBtn.className = "micro-btn";
    selectAllBtn.textContent = "Pilih Semua";
    const deselectAllBtn = document.createElement("button");
    deselectAllBtn.type = "button";
    deselectAllBtn.className = "micro-btn";
    deselectAllBtn.textContent = "Batal Semua";
    selectionActions.append(selectAllBtn, deselectAllBtn);

    toolbar.append(selectionBadge, selectionActions);

    const skipEmptyLabel = document.createElement("label");
    skipEmptyLabel.className = "advanced-settings-toggle";
    skipEmptyLabel.title = "Run Folder melewati query yang sudah pernah selesai dijalankan (SQL & wilayah sama) tetapi tidak pernah menghasilkan record. Query yang belum pernah dijalankan atau SQL-nya berubah tetap dijalankan.";
    const skipEmptyInput = document.createElement("input");
    skipEmptyInput.type = "checkbox";
    skipEmptyInput.checked = skipEmpty;
    const skipEmptyText = document.createElement("span");
    skipEmptyText.textContent = "Hanya query yang pernah menghasilkan record";
    skipEmptyLabel.append(skipEmptyInput, skipEmptyText);

    configBox.append(advancedSettingsLabel, advancedSettingsContent, skipEmptyLabel, toolbar);

    const batch = document.createElement("button");
    batch.className = "secondary-button";
    const batchStatus = document.createElement("p");
    batchStatus.className = "progress";
    batchStatus.setAttribute("role", "status");

    const checkboxMap = new Map<string, { checkbox: HTMLInputElement; row: HTMLDivElement }>();

    const persistCurrentFolderConfig = async (): Promise<void> => {
      folderConfigs[group.path] = {
        selectedPaths: [...selectedPaths],
        advancedSettings,
        startRow,
        maxRows,
        checkpointRows,
        splitColumns: [splitColumn1.trim(), splitColumn2.trim()],
        splitEnabled,
        skipEmpty,
      };
      try {
        await saveFolderConfigs(folderConfigs);
      } catch (error) {
        if (!isContextInvalidated(error)) {
          batchStatus.textContent = error instanceof Error ? error.message : "Konfigurasi folder gagal disimpan.";
        }
      }
    };

    const updateAdvancedSettingsState = (): void => {
      startRowInput.disabled = !advancedSettings;
      maxRowsInput.disabled = !advancedSettings;
      checkpointRowsInput.disabled = !advancedSettings;
      rowGroup.classList.toggle("is-disabled", !advancedSettings);
      advancedSettingsContent.hidden = !advancedSettings;
    };

    const updateSplitSettingsState = (): void => {
      splitColumnFields.hidden = !splitEnabled;
      splitColumn1Input.disabled = !splitEnabled;
      splitColumn2Input.disabled = !splitEnabled || !splitColumn1.trim();
      splitColumn2Field.classList.toggle("is-disabled", splitColumn2Input.disabled);
    };

    updateAdvancedSettingsState();
    updateSplitSettingsState();

    const updateSelectionDisplay = (): void => {
      const count = selectedPaths.size;
      selectionBadge.textContent = `${count} / ${group.files.length} query dipilih`;
      batch.textContent = `▶ Run Folder (${count}/${group.files.length}) → Excel`;
      batch.disabled = count === 0;
    };

    startRowInput.addEventListener("change", () => {
      const val = parseInt(startRowInput.value, 10);
      startRow = !isNaN(val) && val >= 1 ? val : 1;
      startRowInput.value = String(startRow);
      void persistCurrentFolderConfig();
    });

    maxRowsInput.addEventListener("change", () => {
      const val = parseInt(maxRowsInput.value, 10);
      maxRows = !isNaN(val) && val > 0 ? val : undefined;
      maxRowsInput.value = maxRows !== undefined ? String(maxRows) : "";
      void persistCurrentFolderConfig();
    });

    checkpointRowsInput.addEventListener("change", () => {
      const val = parseInt(checkpointRowsInput.value, 10);
      checkpointRows = !isNaN(val) && val > 0 ? val : EXPORT_CHECKPOINT_ROWS;
      checkpointRowsInput.value = String(checkpointRows);
      void persistCurrentFolderConfig();
    });

    splitColumn1Input.addEventListener("change", () => {
      splitColumn1 = splitColumn1Input.value.trim();
      updateSplitSettingsState();
      void persistCurrentFolderConfig();
    });
    splitColumn2Input.addEventListener("change", () => {
      splitColumn2 = splitColumn2Input.value.trim();
      void persistCurrentFolderConfig();
    });
    splitSettingsInput.addEventListener("change", () => {
      splitEnabled = splitSettingsInput.checked;
      updateSplitSettingsState();
      void persistCurrentFolderConfig();
    });
    skipEmptyInput.addEventListener("change", () => {
      skipEmpty = skipEmptyInput.checked;
      void persistCurrentFolderConfig();
    });

    advancedSettingsInput.addEventListener("change", () => {
      advancedSettings = advancedSettingsInput.checked;
      if (!advancedSettings) {
        startRow = 1;
        maxRows = undefined;
        checkpointRows = EXPORT_CHECKPOINT_ROWS;
        startRowInput.value = String(startRow);
        maxRowsInput.value = "";
        checkpointRowsInput.value = String(checkpointRows);
      }
      updateAdvancedSettingsState();
      void persistCurrentFolderConfig();
    });

    selectAllBtn.addEventListener("click", () => {
      for (const file of group.files) {
        selectedPaths.add(file.path);
        const item = checkboxMap.get(file.path);
        if (item) {
          item.checkbox.checked = true;
          item.row.classList.remove("is-unselected");
        }
      }
      updateSelectionDisplay();
      void persistCurrentFolderConfig();
    });

    deselectAllBtn.addEventListener("click", () => {
      selectedPaths.clear();
      for (const file of group.files) {
        const item = checkboxMap.get(file.path);
        if (item) {
          item.checkbox.checked = false;
          item.row.classList.add("is-unselected");
        }
      }
      updateSelectionDisplay();
      void persistCurrentFolderConfig();
    });

    updateSelectionDisplay();

    let batchRunId: string | null = null;
    let batchTabId: number | null = null;
    let batchStopRequested = false;
    let batchController = new AbortController();
    let batchActive = false;
    const stopFolder = (): void => {
      if (!batchActive) return;
      batchStopRequested = true;
      batchController.abort();
      batch.disabled = true;
      batch.textContent = "■ Stopping…";
      if (batchRunId && batchTabId !== null) void stopRun(batchRunId, batchTabId);
    };
    batch.addEventListener("click", async () => {
      if (folderRunning) {
        if (!batchActive) {
          batchStatus.textContent = "Run Folder lain masih berjalan.";
          return;
        }
        stopFolder();
        return;
      }

      const filesToRun = group.files.filter((file) => selectedPaths.has(file.path));
      if (filesToRun.length === 0) {
        batchStatus.textContent = "Pilih minimal 1 file SQL untuk dijalankan.";
        return;
      }
      await runFolder(filesToRun);
    });

    const runFolder = async (filesToRun: SqlFile[]): Promise<FolderOutcome> => {
      let outcome: FolderOutcome = "done";
      splitColumn1 = splitColumn1Input.value.trim();
      splitColumn2 = splitColumn2Input.value.trim();
      const useSplitColumns = advancedSettings && splitEnabled;
      if (useSplitColumns) {
        const splitColumnsError = validateSplitColumnInputs(splitColumn1, splitColumn2);
        if (splitColumnsError) {
          batchStatus.textContent = splitColumnsError;
          return "invalid";
        }
      }
      const splitColumns = useSplitColumns ? [splitColumn1, splitColumn2].filter(Boolean) : [];
      await persistCurrentFolderConfig();

      folderRunning = true;
      batchActive = true;
      batchStopRequested = false;
      batchController = new AbortController();
      batch.textContent = "■ Stop";
      batch.classList.add("stop-button");
      const output: FolderExportOutput = splitColumns.length
        ? new SplitChunkedExport(group.path, createRunId(), splitColumns, { checkpointRows })
        : new ChunkedExport(group.path, undefined, undefined, undefined, checkpointRows);
      batchStatus.classList.remove("progress-error", "progress-warning");
      const runWilayah = structuredClone(wilayah);
      const runWilayahKey = wilayahKey(runWilayah);
      const pushNotes: string[] = [];
      let pushedCount = 0;
      // Only full-range runs are stored as complete results; an offset or row cap yields a subset.
      const fullRange = startRow === 1 && maxRows === undefined;
      let skipped = 0;
      let dbWarning = "";
      try {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (tab?.id === undefined) throw new Error("Aktifkan tab FASIH SQL Lab.");
        batchTabId = tab.id;

        for (const [index, file] of filesToRun.entries()) {
          if (batchStopRequested) throw new Error("Run Folder dihentikan oleh pengguna.");
          const sqlHash = await sha256Hex(file.content);
          if (skipEmpty && shouldSkipQuery(resultIndex.get(resultId(file.path, runWilayahKey)), sqlHash)) {
            skipped++;
            continue;
          }
          batchStatus.textContent = `${index + 1}/${filesToRun.length}: ${file.name} — menunggu hasil. Tetap buka panel dan tab query ini.`;
          const runId = createRunId();
          batchRunId = runId;
          runProgressTargets.set(runId, (runProgress) => {
            batchStatus.textContent = `${index + 1}/${filesToRun.length}: ${file.name} — ${formatRunProgress(runProgress)}`;
          });
          const recorder = fullRange ? createRecorder(runId, file, group.path, sqlHash, (message) => { dbWarning = message; }) : null;
          let pending: Promise<SqlChunkResponse> | undefined;
          try {
            await collectQuery(
              rateLimited(
                (offset, _limit, iteration) => {
                  batchStatus.textContent = `${index + 1}/${filesToRun.length}: ${file.name} — ${formatRunProgress({
                    runId,
                    path: file.path,
                    iteration,
                    state: "running",
                    rowsCollected: Math.max(0, offset - (startRow - 1)),
                  })}`;
                  pending = chrome.runtime.sendMessage({ type: "RUN_SQL_FILE", path: file.path, tabId: tab.id!, runId, offset, limit: _limit, iteration } satisfies ExtensionMessage) as Promise<SqlChunkResponse>;
                  return pending;
                },
                (message) => { batchStatus.textContent = `${index + 1}/${filesToRun.length}: ${file.name} — ${message}`; },
                batchController.signal,
              ),
              async (columns, rows) => {
                await output.append({ filename: file.path, title: extractSqlTitle(file.content, file.name), columns, rows });
                await recorder?.append(columns, rows);
              },
              () => batchStopRequested,
              (message) => { batchStatus.textContent = message; },
              batchController.signal,
              {
                startRow,
                maxRows,
                onColumns: (columns) => {
                  if (output instanceof SplitChunkedExport) output.validateHeaders(file.path, columns);
                },
              },
            );
            await recorder?.finish("complete");
            if (recorder) {
              const pushed = await autoPush(file, runWilayah);
              if (pushed.pushed) pushedCount++;
              if (pushed.note) pushNotes.push(`${file.name}: ${pushed.note}`);
            }
          } catch (error) {
            await recorder?.finish(batchStopRequested ? "partial" : "error", error instanceof Error ? error.message : "Run gagal.");
            throw error;
          } finally {
            runProgressTargets.delete(runId);
            // Keep cancellation active until the outstanding request settles.
            void (pending ?? Promise.resolve()).then(() => clearRun(runId, tab.id!), () => clearRun(runId, tab.id!));
            // Keep the Stop action available between files and while exporting.
          }
        }
        await output.flush(true);
        const outputType = output instanceof SplitChunkedExport ? "file ZIP" : "file Excel";
        batchStatus.textContent = `Selesai: ${output.totalRows.toLocaleString("id-ID")} baris · ${output.parts} ${outputType} diunduh.`
          + (skipped ? ` ${skipped} query dilewati (tidak pernah menghasilkan record).` : "")
          + (fullRange ? "" : " Rentang baris dibatasi, hasil tidak disimpan ke database.")
          + (dbWarning ? ` ${dbWarning}` : "")
          + (pushedCount ? ` ${pushedCount} query dikirim ke monitoring.` : "")
          + (pushNotes.length ? `\n${pushNotes.join("\n")}` : "");
        if (pushNotes.length) batchStatus.classList.add("progress-warning");
      } catch (error) {
        outcome = batchStopRequested ? "stopped" : "failed";
        batchStatus.textContent = await finishPartial(output, error) + (dbWarning ? ` ${dbWarning}` : "")
          + (pushNotes.length ? `\n${pushNotes.join("\n")}` : "");
      } finally {
        folderRunning = false;
        batchActive = false;
        batchRunId = null;
        batchTabId = null;
        batchStopRequested = false;
        batch.disabled = false;
        updateSelectionDisplay();
        batch.classList.remove("stop-button");
      }
      return outcome;
    };
    folderRunners.set(group.path, { run: runFolder, stop: stopFolder });

    const exportButton = document.createElement("button");
    exportButton.type = "button";
    exportButton.className = "secondary-button export-monitoring-button";
    exportButton.textContent = "⇩ Export Monitoring (CSV)";
    exportButton.title = "Unduh hasil lengkap terakhir dari query terpilih (wilayah aktif) sebagai CSV taskforce untuk diunggah di halaman Anomali aplikasi monitoring.";
    exportButton.addEventListener("click", async () => {
      const items = group.files
        .filter((file) => selectedPaths.has(file.path) && kodeMap[file.path] !== undefined)
        .map((file) => ({ path: file.path, title: extractSqlTitle(file.content, file.name), kode: kodeMap[file.path]! }));
      if (!items.length) {
        batchStatus.textContent = "Pilih minimal 1 query untuk diekspor.";
        return;
      }
      exportButton.disabled = true;
      batchStatus.classList.remove("progress-error", "progress-warning");
      batchStatus.textContent = "Menyiapkan CSV monitoring…";
      try {
        const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
        const summary = await exportMonitoring(items, wilayahKey(wilayah), `monitoring_${group.path.replace(/[^\w-]+/g, "_")}_${stamp}`);
        const head = summary.files
          ? `Export monitoring: ${summary.files} CSV · ${summary.rows.toLocaleString("id-ID")} baris diunduh ke Downloads/QueryFlow-monitoring.`
          : "Tidak ada hasil yang bisa diekspor.";
        batchStatus.textContent = [head, ...summary.notes].join("\n");
        if (summary.notes.length) batchStatus.classList.add("progress-warning");
      } catch (error) {
        batchStatus.textContent = error instanceof Error ? error.message : "Export monitoring gagal.";
        batchStatus.classList.add("progress-error");
      } finally {
        exportButton.disabled = false;
      }
    });

    const pushButton = document.createElement("button");
    pushButton.type = "button";
    pushButton.className = "secondary-button export-monitoring-button push-monitoring-button";
    pushButton.textContent = "⇪ Push ke Monitoring";
    pushButton.title = isTargetReady(target) ? `Kirim ke ${target.url}` : "Atur URL target & token di bagian 05 Aplikasi Monitoring.";
    pushButton.addEventListener("click", async () => {
      if (!isTargetReady(target)) {
        batchStatus.textContent = "Atur URL target & token di bagian 05 Aplikasi Monitoring dulu.";
        batchStatus.classList.add("progress-warning");
        return;
      }
      const items = group.files
        .filter((file) => selectedPaths.has(file.path) && kodeMap[file.path] !== undefined)
        .map((file) => ({ path: file.path, title: extractSqlTitle(file.content, file.name), kode: kodeMap[file.path]! }));
      if (!items.length) {
        batchStatus.textContent = "Pilih minimal 1 query untuk dikirim.";
        return;
      }
      pushButton.disabled = true;
      batchStatus.classList.remove("progress-error", "progress-warning");
      batchStatus.textContent = `Mengirim ${items.length} query ke ${target.url}…`;
      try {
        const summary = await pushMonitoring(target, items, structuredClone(wilayah));
        batchStatus.textContent = formatPushSummary(summary);
        if (summary.notes.length) batchStatus.classList.add(summary.pushed ? "progress-warning" : "progress-error");
      } catch (error) {
        batchStatus.textContent = error instanceof Error ? error.message : "Push monitoring gagal.";
        batchStatus.classList.add("progress-error");
      } finally {
        pushButton.disabled = false;
      }
    });

    files.append(configBox, batch, exportButton, pushButton, batchStatus);

    for (const file of group.files) {
      const isSelected = selectedPaths.has(file.path);
      const row = document.createElement("div");
      row.className = `file-row ${isSelected ? "" : "is-unselected"}`;

      const checkTitle = document.createElement("div");
      checkTitle.className = "file-check-title";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "file-select-check";
      checkbox.checked = isSelected;
      checkbox.setAttribute("aria-label", `Pilih ${file.name}`);
      checkbox.title = "Pilih query ini untuk dijalankan pada Run Folder";

      checkbox.addEventListener("change", () => {
        if (checkbox.checked) {
          selectedPaths.add(file.path);
          row.classList.remove("is-unselected");
        } else {
          selectedPaths.delete(file.path);
          row.classList.add("is-unselected");
        }
        updateSelectionDisplay();
        void persistCurrentFolderConfig();
      });

      checkboxMap.set(file.path, { checkbox, row });

      const nameBtn = document.createElement("button");
      nameBtn.type = "button";
      nameBtn.className = "file-title-btn";
      nameBtn.textContent = file.name;
      nameBtn.addEventListener("click", () => showPreview(file.name, file.path, file.content));

      const kodeBadge = document.createElement("button");
      kodeBadge.type = "button";
      kodeBadge.className = "kode-badge";
      kodeBadge.addEventListener("click", () => void editKode(file.path));
      kodeBadges.set(file.path, kodeBadge);
      refreshBadge(file.path);

      checkTitle.append(checkbox, nameBtn, kodeBadge);

      const actions = document.createElement("div");
      actions.className = "file-actions";

      const copy = document.createElement("button");
      copy.type = "button";
      copy.textContent = "⧉ Copy";
      copy.title = "Salin SQL dengan filter wilayah aktif";

      const run = document.createElement("button");
      run.type = "button";
      run.textContent = "▶ Run";
      run.title = "Jalankan query dengan rentang baris yang dikonfigurasi; Stop mengunduh hasil parsial";
      const status = document.createElement("p");
      status.className = "progress";
      status.setAttribute("role", "status");

      let activeRun: { runId: string; tabId: number } | null = null;
      let stopRequested = false;
      let controller = new AbortController();
      copy.addEventListener("click", async () => {
        try {
          await copyText(applyWilayahConfig(file.content, wilayah));
          status.textContent = "SQL tersalin ke clipboard.";
        } catch (error) {
          status.textContent = error instanceof Error ? error.message : "SQL gagal disalin.";
        }
      });

      run.addEventListener("click", async () => {
        if (activeRun) {
          stopRequested = true;
          controller.abort();
          run.disabled = true;
          run.textContent = "■ Stopping…";
          void stopRun(activeRun.runId, activeRun.tabId);
          return;
        }
        if (folderRunning) { status.textContent = "Tunggu Run Folder selesai."; return; }
        folderRunning = true;
        stopRequested = false;
        controller = new AbortController();
        const output = new ChunkedExport(file.path.replace(/\.sql$/i, ""), undefined, undefined, undefined, checkpointRows);
        status.textContent = "Mengirim SQL ke editor aktif...";
        const runId = createRunId();
        let tabId: number | undefined;
        let pending: Promise<SqlChunkResponse> | undefined;
        runProgressTargets.set(runId, (runProgress) => {
          status.textContent = formatRunProgress(runProgress);
        });
        let dbWarning = "";
        let recorder: ReturnType<typeof createRecorder> | null = null;
        const runWilayah = structuredClone(wilayah);
        try {
          const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
          if (tab?.id === undefined) throw new Error("Aktifkan tab FASIH SQL Lab.");
          tabId = tab.id;
          activeRun = { runId, tabId };
          run.textContent = "■ Stop";
          run.classList.add("stop-button");
          if (startRow === 1 && maxRows === undefined) {
            recorder = createRecorder(runId, file, group.path, await sha256Hex(file.content), (message) => { dbWarning = message; });
          }
          await collectQuery(
            rateLimited(
              (offset, _limit, iteration) => {
                status.textContent = formatRunProgress({
                  runId,
                  path: file.path,
                  iteration,
                  state: "running",
                  rowsCollected: Math.max(0, offset - (startRow - 1)),
                });
                pending = chrome.runtime.sendMessage({ type: "RUN_SQL_FILE", path: file.path, tabId: tab.id!, runId, offset, limit: _limit, iteration } satisfies ExtensionMessage) as Promise<SqlChunkResponse>;
                return pending;
              },
              (message) => { status.textContent = message; },
              controller.signal,
            ),
            async (columns, rows) => {
              await output.append({ filename: file.path, title: extractSqlTitle(file.content, file.name), columns, rows });
              await recorder?.append(columns, rows);
            },
            () => stopRequested,
            (message) => { status.textContent = message; },
            controller.signal,
            { startRow, maxRows },
          );
          await recorder?.finish("complete");
          const pushNote = recorder ? (await autoPush(file, runWilayah)).note : "";
          await output.flush(true);
          status.textContent = `Selesai: ${output.totalRows.toLocaleString("id-ID")} baris · ${output.parts} file Excel diunduh.${dbWarning ? ` ${dbWarning}` : ""}${pushNote ? `\n${pushNote}` : ""}`;
        } catch (error) {
          await recorder?.finish(stopRequested ? "partial" : "error", error instanceof Error ? error.message : "Run gagal.");
          status.textContent = await finishPartial(output, error) + (dbWarning ? ` ${dbWarning}` : "");
        } finally {
          if (tabId !== undefined) {
            void (pending ?? Promise.resolve()).then(() => clearRun(runId, tabId!), () => clearRun(runId, tabId!));
          }
          folderRunning = false;
          runProgressTargets.delete(runId);
          activeRun = null;
          run.disabled = false;
          run.textContent = "▶ Run";
          run.classList.remove("stop-button");
        }
      });

      actions.append(copy, run);
      row.append(checkTitle, actions);
      files.append(row, status);
    }
    details.append(summary, files);
    groupsElement.append(details);
  }
  updateRunEverButton();
}

/** Queries whose stored results for the active wilayah ever contained a record, per folder. */
function everProducedFiles(): { path: string; files: SqlFile[] }[] {
  const key = wilayahKey(wilayah);
  return (snapshot?.groups ?? [])
    .map((group) => ({ path: group.path, files: group.files.filter((file) => resultIndex.get(resultId(file.path, key))?.everRows) }))
    .filter((entry) => entry.files.length > 0);
}

function updateRunEverButton(): void {
  const button = byId<HTMLButtonElement>("run-ever");
  byId("run-ever-box").hidden = !snapshot?.groups.length;
  if (everRunActive) return;
  const folders = everProducedFiles();
  const count = folders.reduce((sum, entry) => sum + entry.files.length, 0);
  button.textContent = `▶ Run query yang pernah menghasilkan record (${count} query · ${folders.length} folder)`;
  button.disabled = count === 0;
  button.title = count
    ? "Jalankan semua query di semua folder yang pernah menghasilkan record untuk filter wilayah aktif, folder demi folder (pilihan centang diabaikan). Pengaturan dan Excel tiap folder tetap berlaku."
    : "Belum ada query yang pernah menghasilkan record untuk filter wilayah ini.";
}

byId("run-ever").addEventListener("click", async () => {
  const button = byId<HTMLButtonElement>("run-ever");
  const status = byId("run-ever-status");
  if (everRunActive) {
    everRunActive.stop();
    button.disabled = true;
    button.textContent = "■ Stopping…";
    return;
  }
  if (folderRunning) {
    status.textContent = "Tunggu run lain selesai.";
    return;
  }
  const folders = everProducedFiles();
  if (!folders.length) return;
  let stopRequested = false;
  let current: string | null = null;
  everRunActive = {
    stop: () => {
      stopRequested = true;
      if (current) folderRunners.get(current)?.stop();
    },
  };
  button.textContent = "■ Stop";
  button.classList.add("stop-button");
  status.classList.remove("progress-error", "progress-warning");
  const failed: string[] = [];
  let finished = 0;
  try {
    for (const [index, entry] of folders.entries()) {
      if (stopRequested) break;
      const runner = folderRunners.get(entry.path);
      if (!runner) continue;
      current = entry.path;
      status.textContent = `Folder ${index + 1}/${folders.length}: ${entry.path} (${entry.files.length} query) — progres di kartu foldernya.`;
      const outcome = await runner.run(entry.files);
      if (outcome === "stopped") break;
      if (outcome === "done") finished++;
      else failed.push(entry.path);
    }
  } finally {
    current = null;
    everRunActive = null;
    button.classList.remove("stop-button");
    status.textContent = (stopRequested ? `Dihentikan setelah ${finished} folder selesai.` : `Selesai: ${finished}/${folders.length} folder.`)
      + (failed.length ? `\nGagal/terhenti: ${failed.join(", ")} — lihat pesan di kartu folder.` : "");
    if (failed.length) status.classList.add("progress-warning");
    updateRunEverButton();
  }
});

async function persistWilayah(next: WilayahConfig): Promise<boolean> {
  const validation = validateWilayah(next);
  if (!validation.valid) {
    wilayahError = validation.errors[0] ?? "Konfigurasi wilayah tidak valid.";
    byId("wilayah-error").textContent = wilayahError;
    return false;
  }
  wilayah = next;
  wilayahError = "";
  try {
    await saveWilayah(wilayah);
  } catch (error) {
    if (isContextInvalidated(error)) return false;
    wilayahError = error instanceof Error ? error.message : "Konfigurasi wilayah gagal disimpan.";
    byId("wilayah-error").textContent = wilayahError;
    return false;
  }
  byId("wilayah-error").textContent = "";
  // Stored results and skip decisions are per wilayah.
  for (const path of kodeBadges.keys()) refreshBadge(path);
  updateRunEverButton();
  const saved = byId("wilayah-saved");
  saved.textContent = "Tersimpan";
  window.setTimeout(() => (saved.textContent = ""), 1200);
  return true;
}

async function updateCode(level: keyof WilayahConfig, index: number, code: string): Promise<void> {
  const next = [...wilayah[level]];
  next[index] = code.trim();
  await persistWilayah({ ...wilayah, [level]: next });
  renderWilayah();
}

async function removeCode(level: keyof WilayahConfig, index: number): Promise<void> {
  await persistWilayah({ ...wilayah, [level]: wilayah[level].filter((_, candidate) => candidate !== index) });
  renderWilayah();
}

async function confirmAdd(level: keyof WilayahConfig, input: HTMLInputElement, rowId: string): Promise<void> {
  const code = input.value.trim();
  const next = addWilayahCode(wilayah, level, code);
  if (next === wilayah) {
    const label = level === "level1" ? "Level 1" : "Level 2";
    wilayahError = wilayah[level].includes(code) ? `Kode ${label} tidak boleh duplikat.` : `Kode ${label} harus berisi angka.`;
    renderWilayah();
    return;
  }
  await persistWilayah(next);
  input.value = "";
  byId(rowId).hidden = true;
  renderWilayah();
}

function showPreview(name: string, path: string, content: string): void {
  byId("preview-name").textContent = name;
  byId("preview-path").textContent = path;
  byId("preview-content").textContent = content;
  byId<HTMLDialogElement>("preview-dialog").showModal();
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function createRunId(): string {
  return crypto.randomUUID();
}

function formatRunProgress(progress: SqlRunProgress): string {
  const rows = new Intl.NumberFormat("id-ID").format(progress.rowsCollected);
  return progress.state === "running"
    ? `Proses ke-${progress.iteration} sedang berjalan · ${rows} baris terkumpul`
    : `Proses ke-${progress.iteration} selesai · ${rows} baris terkumpul`;
}

async function finishPartial(output: FolderExportOutput, error: unknown): Promise<string> {
  const reason = error instanceof Error ? error.message : "Run gagal.";
  try {
    await output.flush(true, true, reason);
    const outputType = output instanceof SplitChunkedExport ? "file ZIP" : "file Excel";
    return `${reason} ${output.parts ? `Hasil parsial: ${output.totalRows.toLocaleString("id-ID")} baris · ${output.parts} ${outputType} diunduh.` : "Belum ada hasil yang dapat diunduh."}`;
  } catch (exportError) {
    return `${reason} Ekspor sisa hasil gagal: ${exportError instanceof Error ? exportError.message : "Error Excel"}. ${output.parts} bagian sebelumnya sudah diunduh.`;
  }
}

async function clearRun(runId: string, tabId: number): Promise<void> {
  await chrome.runtime.sendMessage({ type: "CLEAR_SQL_RUN", runId, tabId } satisfies ExtensionMessage).catch(() => undefined);
}

async function stopRun(runId: string, tabId: number): Promise<{ ok: boolean; message: string }> {
  try {
    return await chrome.runtime.sendMessage({ type: "STOP_SQL_RUN", runId, tabId } satisfies ExtensionMessage) as { ok: boolean; message: string };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Query gagal dihentikan." };
  }
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textArea = document.createElement("textarea");
  textArea.value = value;
  textArea.style.position = "fixed";
  textArea.style.opacity = "0";
  document.body.append(textArea);
  textArea.select();
  const copied = document.execCommand("copy");
  textArea.remove();
  if (!copied) throw new Error("SQL gagal disalin ke clipboard.");
}

// Handler dipertahankan agar fitur GitLab dapat diaktifkan kembali cukup dengan
// mengembalikan tombol #sync pada template di atas.
syncButton?.addEventListener("click", async () => {
  progress = { phase: "connecting", message: "Connecting to GitLab..." };
  renderSource();
  try {
    const result = (await chrome.runtime.sendMessage({ type: "SYNC_REPOSITORY" } satisfies ExtensionMessage)) as ScanResult;
    if (!result.ok) throw new Error(result.error);
    snapshot = result.snapshot;
    progress = { phase: "success", message: "Synced" };
    render();
  } catch (error) {
    progress = { phase: "error", message: error instanceof Error ? error.message : "Sync failed" };
    renderSource();
  }
});

importButton.addEventListener("click", () => folderInput.click());
folderInput.addEventListener("change", () => void importRepositoryFolder(folderInput.files));

async function importRepositoryFolder(fileList: FileList | null): Promise<void> {
  if (!fileList?.length) return;
  const selected = [...fileList];
  const sqlFiles = selected.filter((file) => isSqlPath(file.name) && file.webkitRelativePath.split("/").length > 2);
  if (sqlFiles.length === 0) {
    progress = { phase: "error", message: "Tidak ada SQL dalam subfolder. SQL di root diabaikan; pilih folder repository yang membungkus query groups." };
    renderSource();
    folderInput.value = "";
    return;
  }

  const firstPath = selected[0]?.webkitRelativePath || selected[0]?.name || "repository";
  const rootFolder = firstPath.split("/")[0] || "repository";
  try {
    const importedFiles: SqlFile[] = [];
    for (const [index, file] of sqlFiles.entries()) {
      progress = {
        phase: "reading",
        message: `Reading ${index + 1} / ${sqlFiles.length} SQL files...`,
        current: index + 1,
        total: sqlFiles.length,
      };
      renderSource();
      const fullPath = file.webkitRelativePath || file.name;
      const relativePath = fullPath.startsWith(`${rootFolder}/`) ? fullPath.slice(rootFolder.length + 1) : fullPath;
      importedFiles.push({ name: file.name, path: relativePath, content: await file.text() });
    }

    const nextSnapshot: RepositorySnapshot = {
      version: 1,
      repository: {
        name: rootFolder,
        namespace: "local-folder",
        branch: "local import",
        syncedAt: new Date().toISOString(),
        sqlCount: importedFiles.length,
      },
      groups: groupSqlFiles(importedFiles),
    };
    progress = { phase: "saving", message: "Mengganti seluruh cache SQL dengan folder impor terbaru..." };
    renderSource();
    await saveSnapshot(nextSnapshot);
    snapshot = nextSnapshot;
    try {
      await ensureKodeAssigned();
    } catch (error) {
      byId("db-status").textContent = error instanceof Error ? `Kode anomali gagal disimpan: ${error.message}` : "Kode anomali gagal disimpan.";
    }
    progress = { phase: "success", message: "Imported — cache lama diganti" };
    render();
  } catch (error) {
    progress = { phase: "error", message: error instanceof Error ? error.message : "Import folder gagal." };
    renderSource();
  } finally {
    folderInput.value = "";
  }
}

chrome.runtime.onMessage.addListener((message: ExtensionMessage) => {
  if (message.type === "SQL_RUN_PROGRESS") {
    runProgressTargets.get(message.progress.runId)?.(message.progress);
    return;
  }
  if (message.type !== "SYNC_PROGRESS") return;
  progress = message.progress;
  renderSource();
});

byId("show-level1-add").addEventListener("click", () => {
  byId("add-level1-row").hidden = false;
  newLevel1Input.focus();
});
byId("confirm-level1").addEventListener("click", () => void confirmAdd("level1", newLevel1Input, "add-level1-row"));
newLevel1Input.addEventListener("keydown", (event) => {
  if (event.key === "Enter") void confirmAdd("level1", newLevel1Input, "add-level1-row");
});
byId("show-level2-add").addEventListener("click", () => {
  byId("add-level2-row").hidden = false;
  newLevel2Input.focus();
});
byId("confirm-level2").addEventListener("click", () => void confirmAdd("level2", newLevel2Input, "add-level2-row"));
newLevel2Input.addEventListener("keydown", (event) => {
  if (event.key === "Enter") void confirmAdd("level2", newLevel2Input, "add-level2-row");
});
byId("close-preview").addEventListener("click", () => byId<HTMLDialogElement>("preview-dialog").close());
byId("target-save").addEventListener("click", async () => {
  const status = byId("target-status");
  status.classList.remove("progress-error", "progress-warning");
  let next: MonitoringTarget;
  try {
    next = {
      url: normalizeBaseUrl(byId<HTMLInputElement>("target-url").value),
      token: normalizeToken(byId<HTMLInputElement>("target-token").value),
      autoPush: byId<HTMLInputElement>("target-auto").checked,
    };
  } catch (error) {
    status.textContent = error instanceof Error ? `URL tidak valid: ${error.message}` : "URL tidak valid.";
    status.classList.add("progress-error");
    return;
  }
  if (next.url) {
    // Must run inside the click gesture: Chrome asks the user to allow access to this host.
    const granted = await chrome.permissions.request({ origins: [originPattern(next.url)] });
    if (!granted) {
      status.textContent = `Izin akses ke ${new URL(next.url).host} ditolak; push tidak bisa dipakai.`;
      status.classList.add("progress-error");
      return;
    }
  }
  target = next;
  await saveTarget(target);
  renderTarget();
  if (!isTargetReady(target)) {
    status.textContent = "Tersimpan. Isi URL dan token untuk mengaktifkan push.";
    return;
  }
  status.textContent = "Tersimpan. Menguji koneksi…";
  try {
    await pingTarget(target);
    status.textContent = `Terhubung ke ${target.url}.`;
  } catch (error) {
    const message = error instanceof Error ? error.message : "error";
    const hint = /token salah/i.test(message)
      ? ` Token terisi ${target.token.length} karakter, berakhiran …${target.token.slice(-4)}. Salin ulang lewat tombol 🔑 Token API di ${target.url}/anomali.`
      : "";
    status.textContent = `Tersimpan, tetapi tes koneksi gagal: ${message}${hint}`;
    status.classList.add("progress-error");
  }
});

byId("db-clear").addEventListener("click", async () => {
  if (folderRunning) {
    byId("db-status").textContent = "Tunggu run selesai sebelum mengosongkan database.";
    return;
  }
  if (!window.confirm("Hapus semua hasil, riwayat run, dan status 0-record yang tersimpan? Kode anomali (T…) tetap disimpan.")) return;
  try {
    await clearResults();
    resultIndex = new Map();
    for (const path of kodeBadges.keys()) refreshBadge(path);
  updateRunEverButton();
    await renderDatabase();
    byId("db-status").textContent = "Database hasil dikosongkan.";
  } catch (error) {
    byId("db-status").textContent = error instanceof Error ? error.message : "Database gagal dikosongkan.";
  }
});

void initialize().catch((error: unknown) => {
  if (isContextInvalidated(error)) {
    const status = document.getElementById("status");
    if (status) status.textContent = "Extension diperbarui. Tutup lalu buka kembali panel QueryFlow.";
    return;
  }
  progress = { phase: "error", message: error instanceof Error ? error.message : "QueryFlow gagal dimuat." };
  renderSource();
});
