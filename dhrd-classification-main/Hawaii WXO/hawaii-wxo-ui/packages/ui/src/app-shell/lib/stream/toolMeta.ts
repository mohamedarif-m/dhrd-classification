/**
 * Meta readers for the tools' `_meta` blocks. The tools emit Form Contract v1
 * at the contract key below, with `submitTool` carried ON the contract. The
 * legacy wxO FormWidget meta ("com.ibm.orchestrate/widget") is GONE from the
 * converted tools (payload diet, 2026-07-30) and is no longer read anywhere.
 */

import type { DownloadAttachment, FormContract } from '../../../form-engine';
import type { ActiveForm } from '../chat/liveTypes';

export const CONTRACT_META_KEY = 'tko/form-contract@v1';
export const VERDICT_META_KEY = 'tko/verify-verdict@v1';
export const RECEIPT_META_KEY = 'tko/receipt@v1';
export const DOWNLOAD_META_KEY = 'tko/file-download@v1';
export const AUTO_CONTINUE_META_KEY = 'tko/auto-continue@v1';

/**
 * A tool's instruction to send ONE more envelope by itself once the surface it
 * arrived with has rendered - the long-running-job case, where a "Continue"
 * button between every chunk is a click that adds nothing but latency.
 *
 * The shell owns none of the policy. The tool decides whether a turn
 * auto-continues, what the next envelope is, and how long to wait; the shell
 * only sends what it was handed, exactly once per arrival. That is why the
 * whole payload - tool AND args - is authored server-side: a client that
 * synthesized the follow-up would be guessing at a tool's parameters, and this
 * mechanism is used by tools that create things.
 *
 * A tool that offers it MUST be safe to re-enter: the fire happens after the
 * stream closes, with no user in the loop, and a duplicated turn has to resume
 * rather than repeat.
 */
export interface AutoContinue {
  tool: string;
  args: Record<string, unknown>;
  /** Pause before firing, so each update is read rather than flashed past. */
  delayMs?: number;
}

export function extractAutoContinue(
  meta: Record<string, unknown> | null | undefined,
): AutoContinue | null {
  if (!meta) return null;
  const payload = meta[AUTO_CONTINUE_META_KEY] as Record<string, unknown> | undefined;
  if (!payload || typeof payload !== 'object') return null;
  const { tool, args, delayMs } = payload as Record<string, unknown>;
  if (typeof tool !== 'string' || !tool.trim()) return null;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  return {
    tool,
    args: args as Record<string, unknown>,
    ...(typeof delayMs === 'number' && delayMs >= 0 ? { delayMs } : {}),
  };
}

/**
 * Pull a renderable form out of a tool/message `_meta` block. Accepts either a
 * bare FormContract at the contract key or a {contract, submit_tool} wrapper;
 * contract.submitTool is the authoritative envelope receiver either way.
 */
export function extractMeta(meta: Record<string, unknown> | null | undefined): ActiveForm | null {
  if (!meta) return null;
  const payload = meta[CONTRACT_META_KEY] as Record<string, unknown> | undefined;
  if (!payload) return null;
  const wrapped = payload.contract as FormContract | undefined;
  const contract = wrapped ?? (payload as unknown as FormContract);
  if (!contract || !Array.isArray((contract as FormContract).sections)) return null;
  const wrapperTool = (payload.submit_tool ?? payload.submitTool) as string | undefined;
  return { contract, submitTool: contract.submitTool ?? wrapperTool };
}

/**
 * A file the tool hands back inline (base64) on its own meta key, next to the
 * contract. Nothing is decoded here: the bytes stay a string until the render
 * turns them into a data URI, so a malformed payload can never throw on read.
 */
export function extractAttachment(
  meta: Record<string, unknown> | null | undefined,
): DownloadAttachment | undefined {
  if (!meta) return undefined;
  const payload = meta[DOWNLOAD_META_KEY] as Record<string, unknown> | undefined;
  if (!payload || typeof payload !== 'object') return undefined;
  const { filename, base64, mimeType, note } = payload as Record<string, unknown>;
  if (typeof filename !== 'string' || !filename) return undefined;
  if (typeof base64 !== 'string' || !base64) return undefined;
  return {
    filename,
    base64,
    ...(typeof mimeType === 'string' && mimeType ? { mimeType } : {}),
    ...(typeof note === 'string' && note ? { note } : {}),
  };
}

/** Verifier verdict / receipt ride their own meta keys next to the contract. */
export function extractSignals(meta: Record<string, unknown> | null | undefined): {
  verdict?: import('../../../form-engine').VerifyVerdict;
  receipt?: import('../../../form-engine').Receipt;
} {
  if (!meta) return {};
  return {
    verdict: meta[VERDICT_META_KEY] as never,
    receipt: meta[RECEIPT_META_KEY] as never,
  };
}
