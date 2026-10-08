/**
 * The single time policy for every consumer of the engine.
 *
 * 1. Chat/thread timestamps always come from API records (server ISO strings)
 *    and are formatted for display in the viewer's browser-local timezone.
 * 2. Form "today" is CONTRACT DATA: tools compute the authoritative business
 *    date and ship it as `contract.todayIso`; validation truth never reads the
 *    browser clock. The browser clock is used only for display formatting and
 *    relative labels.
 * 3. All formatting funnels through here so locale/format changes are one edit.
 */

import type { FormContract } from './contract';

/** Parse a server ISO timestamp; returns null for absent/invalid input. */
export function parseServerTime(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

const timeFmt = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
});
const dateTimeFmt = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});
const dateFmt = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
});

/**
 * Format a server timestamp for chat display, browser-local timezone,
 * locale-aware: time-only when it falls on the viewer's current day,
 * month + day + time otherwise.
 */
export function formatTimestamp(iso: string | null | undefined, nowMs = Date.now()): string {
  const d = parseServerTime(iso);
  if (!d) return '';
  const now = new Date(nowMs);
  const sameDay = d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? timeFmt.format(d) : dateTimeFmt.format(d);
}

/** Format a server timestamp as a local calendar date. */
export function formatDate(iso: string | null | undefined): string {
  const d = parseServerTime(iso);
  return d ? dateFmt.format(d) : '';
}

/**
 * Relative label ("2 min ago") against a server timestamp. Tolerant of client
 * clock skew: a server time "in the future" clamps to "just now".
 */
export function formatRelative(iso: string | null | undefined, nowMs = Date.now()): string {
  const d = parseServerTime(iso);
  if (!d) return '';
  const diffS = Math.max(0, Math.floor((nowMs - d.getTime()) / 1000));
  if (diffS < 60) return 'just now';
  const diffMin = Math.floor(diffS / 60);
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return diffH === 1 ? '1 hour ago' : `${diffH} hours ago`;
  const diffD = Math.floor(diffH / 24);
  if (diffD < 7) return diffD === 1 ? 'yesterday' : `${diffD} days ago`;
  return formatDate(iso);
}

/**
 * The authoritative "today" (YYYY-MM-DD) for a form: CONTRACT DATA ONLY.
 * Returns undefined when the contract carries no `todayIso` - validation then
 * has no client-side "today" and defers relative-date rules to the server
 * (which always checks). The browser clock is NEVER validation truth; it is
 * used only for display formatting above.
 */
export function contractToday(
  contract?: Pick<FormContract, 'todayIso'>,
): string | undefined {
  return contract?.todayIso;
}
