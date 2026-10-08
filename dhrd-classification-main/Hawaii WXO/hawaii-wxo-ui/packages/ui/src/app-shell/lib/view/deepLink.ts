/**
 * Deep-link query parameters, read once on boot by the workspace shell.
 *
 * The package stays router-free: this is plain URLSearchParams parsing, and
 * the values only seed the INITIAL view. A user can navigate away afterwards
 * (pick another agent, leave focus view) and the URL is never rewritten.
 *
 * Supported params:
 *   agent=<key>  preselect that registry agent. Unknown or coming-soon keys
 *                are ignored, leaving the host's default selection.
 *   focus=1      start in focus view (single agent, no workspace sidebar).
 *                Accepts 1/true/yes, case-insensitive; anything else is off.
 *
 * Embedding hosts (a Microsoft Teams tab, an intranet iframe) use these to
 * point one surface at one agent without shipping host-specific code.
 */

export interface DeepLink {
  /** A key that exists in the registry and is selectable, or undefined. */
  agentKey?: string;
  /** True when the caller asked to boot straight into focus view. */
  focus: boolean;
}

const TRUTHY = new Set(['1', 'true', 'yes']);

/**
 * Parse a `window.location.search` string against the keys a registry offers.
 *
 * @param search    raw query string, with or without the leading '?'
 * @param validKeys agent keys the host is willing to select
 */
export function parseDeepLink(
  search: string | null | undefined,
  validKeys: readonly string[] = [],
): DeepLink {
  const params = new URLSearchParams(search ?? '');
  const agent = params.get('agent');
  const focus = params.get('focus');
  return {
    agentKey: agent && validKeys.includes(agent) ? agent : undefined,
    focus: Boolean(focus && TRUTHY.has(focus.trim().toLowerCase())),
  };
}

/** The current page's query string, or '' when there is no DOM (SSR, tests). */
export function currentSearch(): string {
  return typeof window === 'undefined' ? '' : window.location.search;
}
