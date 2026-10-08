/**
 * Data-driven thinking copy. Nothing is hardcoded per screen: the registry
 * supplies per-tool copy and the rotation list; this resolver only picks a tier.
 */

export interface ThinkingCopyInput {
  /** Tier 1: registry-provided per-tool copy. A LIST means staged progress
   * copy: the indicator advances through the phrases and HOLDS on the last
   * one (never cycles back) - e.g. ["Submitting...", "Verifying...",
   * "Gearing up alerts..."]. All copy is data. */
  copy?: string | string[];
  /** Tier 2: tool display name revealed by the event stream. */
  toolName?: string;
  /** Tier 3: rotation list from registry/config; DEFAULT_FALLBACK_PHRASES if absent. */
  fallbackPhrases?: string[];
}

export type ThinkingCopy =
  | { mode: 'fixed'; label: string }
  | { mode: 'rotate'; phrases: string[] }
  | { mode: 'staged'; phrases: string[] };

export const DEFAULT_FALLBACK_PHRASES = [
  'Thinking...',
  'Working on it...',
  'Preparing...',
];

export function resolveThinkingCopy(input: ThinkingCopyInput): ThinkingCopy {
  if (Array.isArray(input.copy)) {
    const phrases = input.copy.filter(Boolean);
    if (phrases.length === 1) return { mode: 'fixed', label: phrases[0] };
    if (phrases.length > 1) return { mode: 'staged', phrases };
  } else if (input.copy) {
    return { mode: 'fixed', label: input.copy };
  }
  if (input.toolName) return { mode: 'fixed', label: `Running ${input.toolName}...` };
  const phrases = input.fallbackPhrases?.length
    ? input.fallbackPhrases
    : DEFAULT_FALLBACK_PHRASES;
  return { mode: 'rotate', phrases };
}
