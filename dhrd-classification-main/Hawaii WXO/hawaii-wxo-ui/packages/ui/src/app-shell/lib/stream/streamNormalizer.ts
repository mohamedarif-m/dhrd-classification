/**
 * Normalizes the wxO run stream (as relayed by the proxy) into UI-level
 * events. Built against the LIVE capture of 2026-07-30 on tko-pilot-wxo
 * (docs/fixtures/jrc-start-stream-20260730.ndjson; see the dossier's
 * "verified live" addendum), not against guessed shapes.
 */

import type { Receipt, VerifyVerdict } from '../../../form-engine';
import type { ActiveForm, WireEvent } from '../chat/liveTypes';
import {
  extractAttachment, extractAutoContinue, extractMeta, extractSignals,
} from './toolMeta';
import type { AutoContinue } from './toolMeta';

export type NormalizedEvent =
  | { kind: 'run-started'; runId?: string; threadId?: string }
  | { kind: 'thinking'; text: string; key?: string }
  | { kind: 'tool-call'; tool: string; agent?: string }
  | { kind: 'text'; text: string }
  | { kind: 'form'; form: ActiveForm; announce?: string; autoContinue?: AutoContinue }
  | { kind: 'verdict'; verdict: VerifyVerdict }
  | { kind: 'receipt'; receipt: Receipt }
  | { kind: 'final-message'; text: string; isAsync: boolean; messageId?: string; createdOn?: string }
  | { kind: 'completed' }
  /** The run outlived the transport's poll window: it is still executing on
   * the platform. Synthesized by the proxy (`run.pending`) and followed by an
   * ordinary human-readable message and `done`. */
  | { kind: 'run-pending'; runId?: string }
  | { kind: 'failed'; error: string };

interface StepDetail {
  type?: string;
  tool_calls?: Array<{ name?: string; args?: unknown; id?: string }>;
  agent_display_name?: string;
  name?: string;
  content?: unknown;
}

function stepDetails(data: Record<string, unknown> | undefined): StepDetail[] {
  const delta = data?.delta as { step_details?: StepDetail[] } | undefined;
  return Array.isArray(delta?.step_details) ? delta.step_details : [];
}

function textFromContentList(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c): c is { response_type?: string; text?: string } =>
      typeof c === 'object' && c !== null)
    .filter((c) => (c.response_type ?? 'text') === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('\n\n');
}

interface ParsedToolResponse {
  meta: Record<string, unknown> | null;
  /** The tool's own deterministic user text (MCP TextContent items). The
   * agent is instructed to relay this verbatim, so it can be shown the
   * instant the tool returns — the LLM's later copy reconciles in place. */
  userText: string;
}

function parseToolResponse(detail: StepDetail): ParsedToolResponse | null {
  if (detail.type !== 'tool_response' || typeof detail.content !== 'string') return null;
  try {
    const parsed = JSON.parse(detail.content) as {
      _meta?: Record<string, unknown>;
      content?: Array<{ text?: unknown }>;
    };
    const userText = (Array.isArray(parsed.content) ? parsed.content : [])
      .map((c) => (typeof c?.text === 'string' ? c.text : ''))
      .filter(Boolean)
      .join('\n\n');
    return { meta: parsed._meta ?? null, userText };
  } catch {
    return null;
  }
}

function metaFromToolResponse(detail: StepDetail): Record<string, unknown> | null {
  return parseToolResponse(detail)?.meta ?? null;
}

function eventsFromMeta(
  meta: Record<string, unknown> | null,
  announce?: string,
): NormalizedEvent[] {
  if (!meta) return [];
  const out: NormalizedEvent[] = [];
  const form = extractMeta(meta);
  if (form) {
    // The attachment rides with the form it arrived with, never with a later one.
    const attachment = extractAttachment(meta);
    // Same rule for the auto-continue instruction: it belongs to THIS arrival
    // and is consumed once, so a later contract cannot inherit a stale fire.
    const autoContinue = extractAutoContinue(meta);
    out.push({
      kind: 'form',
      form: attachment ? { ...form, attachment } : form,
      announce: announce || undefined,
      ...(autoContinue ? { autoContinue } : {}),
    });
  }
  const { verdict, receipt } = extractSignals(meta);
  if (verdict) out.push({ kind: 'verdict', verdict });
  if (receipt) out.push({ kind: 'receipt', receipt });
  return out;
}

/** One wire event -> zero or more UI events. Unknown event types yield []. */
export function normalizeEvent(ev: WireEvent): NormalizedEvent[] {
  const data = ev.data ?? {};
  switch (ev.event) {
    case 'run.started':
      return [{ kind: 'run-started',
        runId: data.run_id as string | undefined,
        threadId: data.thread_id as string | undefined }];

    case 'run.step.thinking':
    case 'run.step.intermediate': {
      const message = data.message as { text?: string; key?: string } | undefined;
      return message?.text
        ? [{ kind: 'thinking', text: message.text, key: message.key }]
        : [];
    }

    case 'run.step.delta': {
      const out: NormalizedEvent[] = [];
      for (const detail of stepDetails(data)) {
        if (detail.type === 'tool_calls') {
          for (const call of detail.tool_calls ?? []) {
            if (call.name) {
              out.push({ kind: 'tool-call', tool: call.name,
                agent: detail.agent_display_name });
            }
          }
        }
        const parsed = parseToolResponse(detail);
        if (parsed) out.push(...eventsFromMeta(parsed.meta, parsed.userText));
      }
      return out;
    }

    case 'message.delta': {
      const delta = data.delta as { content?: unknown } | undefined;
      const text = textFromContentList(delta?.content);
      return text ? [{ kind: 'text', text }] : [];
    }

    case 'message.created': {
      const msg = data.message as {
        id?: string; created_on?: string; role?: string; content?: unknown;
        _meta?: Record<string, unknown>;
        additional_properties?: { display_properties?: { is_async?: boolean } };
        step_history?: Array<{ step_details?: StepDetail[] }>;
      } | undefined;
      if (!msg || msg.role !== 'assistant') return [];
      const out: NormalizedEvent[] = [];
      // Meta rides on the message itself (verified live) with the
      // step_history tool_response blocks as a secondary source.
      let metaEvents = eventsFromMeta(msg._meta ?? null);
      if (!metaEvents.length) {
        for (const step of msg.step_history ?? []) {
          for (const detail of step.step_details ?? []) {
            const found = eventsFromMeta(metaFromToolResponse(detail));
            if (found.length) metaEvents = found; // newest wins
          }
        }
      }
      out.push(...metaEvents);
      out.push({
        kind: 'final-message',
        text: textFromContentList(msg.content),
        isAsync: Boolean(msg.additional_properties?.display_properties?.is_async),
        messageId: msg.id,
        createdOn: msg.created_on,
      });
      return out;
    }

    case 'run.pending':
      return [{ kind: 'run-pending', runId: data.run_id as string | undefined }];

    case 'run.completed':
    case 'done':
      return [{ kind: 'completed' }];

    case 'run.failed':
    case 'error':
      return [{ kind: 'failed',
        error: typeof data.error === 'string' ? data.error : 'The run failed.' }];

    default:
      return []; // unknown events are ignored without erroring (dossier rule 7)
  }
}

/**
 * Incremental SSE frame parser for the proxy stream. Feed it chunks; it emits
 * parsed WireEvents and ignores heartbeats/comments.
 */
export function createSseParser(onEvent: (ev: WireEvent) => void) {
  let buffer = '';
  return {
    push(chunk: string) {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const dataLines = frame
          .split('\n')
          .filter((l) => l.startsWith('data: '))
          .map((l) => l.slice(6));
        if (!dataLines.length) continue; // heartbeat comment
        try {
          onEvent(JSON.parse(dataLines.join('\n')) as WireEvent);
        } catch {
          // Malformed frame: skip, never crash the stream.
        }
      }
    },
  };
}

/**
 * Thinking-copy resolution, tiered exactly as the plan requires:
 * registry copy per tool -> "Running <display name>..." -> rotating fallback.
 */
export function thinkingCopyFor(
  tool: string | null,
  registryCopy: Record<string, string | string[]> | undefined,
  toolDisplay: Record<string, { display_name?: string | null }> | undefined,
): string | string[] | null {
  if (!tool) return null;
  if (registryCopy?.[tool]) return registryCopy[tool];
  const display = toolDisplay?.[tool]?.display_name;
  if (display) return `Running ${display}...`;
  return `Running ${tool.replace(/_/g, ' ')}...`;
}
