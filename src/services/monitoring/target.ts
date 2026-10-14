/** Monitoring app that receives pushed taskforce results (rekap-muatan `/api/...`). */
export interface MonitoringTarget {
  /** Base URL of the app, e.g. `https://se-meira.bps9702.com`. Empty = not configured. */
  url: string;
  /** Bearer token matching `REKAP_API_TOKEN` on the server. */
  token: string;
  /** Push each query right after a complete run. */
  autoPush: boolean;
}

export const DEFAULT_TARGET: MonitoringTarget = { url: "", token: "", autoPush: false };

const TARGET_KEY = "monitoringTarget";

/**
 * Accepts what users paste (with or without scheme, `/anomali` page, trailing
 * slash) and returns the app base URL. Throws on anything that is not http(s).
 */
export function normalizeBaseUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  const url = new URL(/^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("URL harus diawali https:// atau http://.");
  const path = url.pathname.replace(/\/+$/, "").replace(/\/(anomali|api)(\/.*)?$/i, "");
  return `${url.origin}${path}`;
}

/** Strips what tends to come along when copying a token: whitespace, quotes, a `Bearer ` prefix. */
export function normalizeToken(input: string): string {
  return input.replace(/\s+/g, "").replace(/^["'`]+|["'`]+$/g, "").replace(/^Bearer/i, "");
}

/** Host permission pattern Chrome needs before the side panel may call the app. */
export function originPattern(baseUrl: string): string {
  return `${new URL(baseUrl).origin}/*`;
}

export function isTargetReady(target: MonitoringTarget): boolean {
  return Boolean(target.url && target.token);
}

export async function loadTarget(): Promise<MonitoringTarget> {
  const stored = await chrome.storage.local.get(TARGET_KEY);
  const value = stored[TARGET_KEY] as Partial<MonitoringTarget> | undefined;
  return {
    url: typeof value?.url === "string" ? value.url : DEFAULT_TARGET.url,
    token: typeof value?.token === "string" ? value.token : DEFAULT_TARGET.token,
    autoPush: value?.autoPush === true,
  };
}

export async function saveTarget(target: MonitoringTarget): Promise<void> {
  await chrome.storage.local.set({ [TARGET_KEY]: target });
}
