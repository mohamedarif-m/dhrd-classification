/**
 * Proxy API client. The browser only ever talks to the proxy - no credentials
 * here. A package must not read a host's build env, so the base URL is explicit
 * config: the host calls configureApi() once at boot (reading its own env) and
 * everything below uses whatever it set.
 */

import type { RemoteOptions, UploadResult } from '../../../form-engine';
import type { LiveRegistry, SlimMessage, ThreadRow, WireEvent } from './liveTypes';
import { createSseParser } from '../stream/streamNormalizer';

/** Same-origin proxy mount point; overridden by configureApi. */
const DEFAULT_BASE = '/api';

let BASE = DEFAULT_BASE;

/** Point the client at the proxy. Call once, before rendering. */
export function configureApi(config: { base: string }): void {
  BASE = config.base.replace(/\/$/, '');
}

/** The base every request below is built on (diagnostics). */
export function apiBase(): string {
  return BASE;
}

/** Anonymous per-browser identity; the proxy scopes threads to it. */
export function anonId(): string {
  const KEY = 'tko-anon-id';
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(KEY, id);
  }
  return id;
}

function headers(json = false): HeadersInit {
  const h: Record<string, string> = { 'X-TKO-Client': anonId() };
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

async function checkOk(resp: Response): Promise<Response> {
  if (!resp.ok) {
    let detail = `HTTP ${resp.status}`;
    try {
      detail = ((await resp.json()) as { detail?: string }).detail ?? detail;
    } catch { /* keep the status text */ }
    throw new Error(detail);
  }
  return resp;
}

export async function getRegistry(): Promise<LiveRegistry> {
  return (await checkOk(await fetch(`${BASE}/registry`))).json();
}

export async function listThreads(agentKey?: string): Promise<ThreadRow[]> {
  const q = agentKey ? `?agent_key=${encodeURIComponent(agentKey)}` : '';
  const body = await (await checkOk(
    await fetch(`${BASE}/threads${q}`, { headers: headers() }))).json();
  return body.threads as ThreadRow[];
}

export async function getMessages(threadId: string): Promise<SlimMessage[]> {
  const body = await (await checkOk(
    await fetch(`${BASE}/threads/${threadId}/messages`, { headers: headers() }))).json();
  return body.messages as SlimMessage[];
}

export async function renameThread(threadId: string, title: string): Promise<void> {
  await checkOk(await fetch(`${BASE}/threads/${threadId}`, {
    method: 'PATCH', headers: headers(true), body: JSON.stringify({ title }),
  }));
}

/** Poll interval and total budget for an options fetch the proxy warms lazily. */
export const OPTIONS_POLL_MS = 3000;
export const OPTIONS_TIMEOUT_MS = 120000;
/**
 * Wait after a transient failure when the server did not say how long. Longer
 * than the poll interval on purpose: the usual cause is a burst of sibling
 * sources tripping the proxy's per-minute window, and retrying sooner just
 * spends the budget again.
 */
const OPTIONS_RETRY_MS = 5000;
/** Cap on a server-supplied Retry-After, so one bad header cannot stall a form. */
const OPTIONS_RETRY_MAX_MS = 20000;
/**
 * A form declares up to ~6 option sources and mounts them in the same tick.
 * Starting each fetch at a random offset inside this window keeps them off the
 * same 3s boundary, which spreads the same request count across the minute.
 */
const OPTIONS_START_JITTER_MS = 1200;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * `Retry-After` in ms: the header is either delta-seconds or an HTTP date.
 * Anything else (absent, malformed) is null.
 */
export function parseRetryAfter(header: string | null | undefined): number | null {
  if (!header) return null;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds)) return Math.max(0, seconds) * 1000;
  const when = Date.parse(header);
  if (Number.isNaN(when)) return null;
  return Math.max(0, when - Date.now());
}

/**
 * How long to wait before retrying a failed options request, or null when the
 * failure is terminal and the caller should give up.
 *
 * Transient (worth retrying): 429, any 5xx, and status 0, which this module
 * uses for "fetch threw" - offline, DNS, a dropped connection. 429 is the one
 * that matters in practice: N option sources polling in parallel can trip the
 * proxy's per-minute window, and treating that as fatal is what left the user
 * staring at "the full list could not be loaded".
 *
 * Terminal: every other 4xx. An unknown agent or source (404) or a malformed
 * request (400) will not become right by asking again.
 */
export function optionsRetryDelayMs(
  status: number,
  retryAfter?: string | null,
): number | null {
  if (!(status === 0 || status === 429 || status >= 500)) return null;
  const honored = parseRetryAfter(retryAfter);
  return honored === null ? OPTIONS_RETRY_MS : Math.min(honored, OPTIONS_RETRY_MAX_MS);
}

/**
 * Full option set for a field's optionsSource. The proxy answers "loading"
 * while it warms the set in the background, so this polls until ready, and
 * retries with backoff through a rate limit or a server blip. Only a terminal
 * failure (a non-429 4xx, an unrecognized status body) or running out of the
 * OPTIONS_TIMEOUT_MS budget resolves null: the form then keeps the contract's
 * starter rows, and the field offers the user a retry.
 *
 * CACHE BUST. The proxy caches a warmed row set for hours, so a row set built
 * against an older column list outlives the deploy that changed the columns.
 * `opts.refresh` sends `refresh=1`, which the engine sets after it has REFUSED
 * a payload for not matching the contract (see `verifyRows`). The parameter
 * also makes the URL distinct, so an intermediary that caches by URL cannot
 * answer the bust from the same stale entry.
 */
export async function fetchOptions(
  agentKey: string,
  source: string,
  opts?: { refresh?: boolean },
): Promise<RemoteOptions | null> {
  const url = `${BASE}/options?agent_key=${encodeURIComponent(agentKey)}`
    + `&source=${encodeURIComponent(source)}`
    + (opts?.refresh ? '&refresh=1' : '');
  const deadline = Date.now() + OPTIONS_TIMEOUT_MS;
  await sleep(Math.round(Math.random() * OPTIONS_START_JITTER_MS));
  for (;;) {
    let wait: number | null;
    try {
      const resp = await fetch(url, { headers: headers() });
      if (resp.ok) {
        const body = await resp.json() as
          { status?: string; rows?: unknown; total?: number; columns?: unknown };
        if (body.status === 'ready' && Array.isArray(body.rows)) {
          // `columns` is passed through when the tool stamped its row set with
          // the column ids it built for; the engine then matches cells by id.
          const columns = Array.isArray(body.columns)
            && body.columns.every((c) => typeof c === 'string')
            ? body.columns as string[]
            : undefined;
          return {
            rows: body.rows as RemoteOptions['rows'],
            total: body.total ?? body.rows.length,
            ...(columns ? { columns } : {}),
          };
        }
        if (body.status !== 'loading') return null;
        wait = OPTIONS_POLL_MS;
      } else {
        wait = optionsRetryDelayMs(resp.status, resp.headers.get('Retry-After'));
      }
    } catch {
      wait = optionsRetryDelayMs(0);
    }
    if (wait === null) return null;
    if (Date.now() + wait > deadline) return null;
    await sleep(wait);
  }
}

/** One entry of the proxy's `POST /uploads` response. */
export interface UploadedFileRow {
  fileName?: string;
  id?: string;
  url?: string;
  statusCode?: number;
  invalid?: boolean;
  errorBody?: string;
  errorSubject?: string;
}

const UPLOAD_FAILED = 'Upload failed. Try again.';

/**
 * Read the proxy's upload response into the engine's UploadResult.
 *
 * Success is narrow ON PURPOSE: HTTP 200, not flagged invalid, and a url
 * present. Anything else is a failure with the platform's own words when it
 * gave any (errorSubject, then errorBody), otherwise one generic line. Pure and
 * exported so the mapping is testable without a network.
 */
export function mapUploadResponse(body: unknown, fallbackName?: string): UploadResult {
  const rows = (body as { files?: UploadedFileRow[] } | null)?.files;
  const row = Array.isArray(rows) ? rows[0] : undefined;
  if (!row) return { error: UPLOAD_FAILED };
  if (row.statusCode === 200 && !row.invalid && row.url) {
    return { name: row.fileName || fallbackName || '', url: row.url, id: row.id };
  }
  return { error: row.errorSubject || row.errorBody || UPLOAD_FAILED };
}

/**
 * Send one file through the proxy and get back the platform file URL a tool can
 * fetch. Never throws: every failure mode resolves as an { error } the chip
 * renders. Content-Type is deliberately NOT set - the browser must write the
 * multipart boundary itself.
 */
export async function uploadFile(file: File): Promise<UploadResult> {
  const form = new FormData();
  form.append('file', file);
  try {
    const resp = await fetch(`${BASE}/uploads`, {
      method: 'POST', headers: headers(), body: form,
    });
    if (!resp.ok) return { error: `${UPLOAD_FAILED} (HTTP ${resp.status})` };
    return mapUploadResponse(await resp.json(), file.name);
  } catch {
    return { error: UPLOAD_FAILED };
  }
}

/** POST a chat turn and feed each relayed stream event to onEvent. */
export async function streamChat(
  body: { agent_key: string; content: string; thread_id?: string },
  onEvent: (ev: WireEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const resp = await checkOk(await fetch(`${BASE}/chat`, {
    method: 'POST', headers: headers(true), body: JSON.stringify(body), signal,
  }));
  const reader = resp.body?.getReader();
  if (!reader) throw new Error('Streaming not supported by this browser');
  const decoder = new TextDecoder();
  const parser = createSseParser(onEvent);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parser.push(decoder.decode(value, { stream: true }));
  }
}
