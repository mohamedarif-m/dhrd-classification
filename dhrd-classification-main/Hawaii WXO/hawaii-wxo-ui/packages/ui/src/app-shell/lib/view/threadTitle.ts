import { parseServerTime } from '../../../form-engine';
import { ENVELOPE_SENTINEL } from '../chat/useAgentChat';

/**
 * WHAT A CHAT IS CALLED IN THE SIDEBAR.
 *
 * The platform titles a thread from its first user message, and in this product
 * that message is almost always the word "start" - every agent's welcome copy
 * literally invites it, and the entry form does the rest. So the chat history
 * reads as a column of identical rows named "start", which is no history at all:
 * the reader cannot tell yesterday's promotion from this morning's payment
 * without opening both.
 *
 * THE REPLACEMENT IS THE AGENT'S NAME AND THE TIME, AND NOTHING ELSE.
 *
 * An earlier cut of this tried to be clever and name the thread after its
 * SUBJECT, dug out of the review model's rows ("Job Change - Riley Stone").
 * That was the wrong trade and it was dropped deliberately (product decision
 * 2026-08-13). It bought a nicer label at the cost of:
 *
 *   - a label-matching heuristic over tool-authored copy, which got it wrong on
 *     real rows the moment it met them - Job Requisition's review carries an
 *     "Employee type" row, so every requisition thread would have been named
 *     after the word "Regular";
 *   - writing a named individual's identity into a thread title, which is
 *     stored on the platform and shown in listings - a data-at-rest question
 *     nobody needed to have.
 *
 * Agent name plus the time separates the rows, which was the entire problem. It
 * cannot be wrong about anything, it names no one, and there is a Rename button
 * one click away for a reader who wants something better. A title the user typed
 * themselves is never touched.
 */

/**
 * Placeholder openers, normalized. These are the words this product's own
 * welcome copy asks for, plus the handful of greetings people type instead.
 * Anything else - even something short - is treated as a real title, because the
 * cost of overwriting a deliberate name is far higher than the cost of leaving
 * one odd row alone.
 */
const STUBS = new Set([
  '', 'start', 'begin', 'go', 'hi', 'hello', 'hey', 'yo', 'ok',
  'new chat', 'untitled', 'untitled chat', 'new conversation',
]);

/** Lowercased, whitespace-collapsed, stripped of surrounding punctuation. */
function normalize(title?: string | null): string {
  return (title ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'`\s]+|["'`.!,\s]+$/g, '')
    .toLowerCase();
}

/**
 * Is this title a placeholder rather than something worth showing?
 *
 * The envelope sentinel is in here because a thread whose first user message was
 * a form submission gets TITLED with that message, and the raw envelope is a
 * line of JSON - the least readable thing that could appear in the sidebar, and
 * certainly not a name.
 */
export function isStubThreadTitle(title?: string | null): boolean {
  if ((title ?? '').trimStart().startsWith(ENVELOPE_SENTINEL)) return true;
  return STUBS.has(normalize(title));
}

/** The server caps a title at 80 characters. */
export const TITLE_CAP = 80;

/** Trim to the cap without leaving a dangling half-word or separator. */
function cap(text: string): string {
  if (text.length <= TITLE_CAP) return text;
  return `${text.slice(0, TITLE_CAP - 1).replace(/[\s\-,:;]+$/, '')}…`;
}

/**
 * Short absolute stamp for a title - "Aug 13, 2:41 PM" in en-US. Absolute
 * rather than relative ("2 hours ago") on purpose: a title is written once and
 * read for weeks, so it has to stay true after it is stored. The row already
 * shows a relative time beside it for recency.
 */
function stamp(iso: string | null | undefined): string {
  const d = parseServerTime(iso);
  if (!d) return '';
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    }).format(d);
  } catch {
    return '';
  }
}

/**
 * The name a stub thread should be given: the agent, and when the chat happened.
 * This is BOTH what the sidebar renders and what the shell writes back to the
 * server, so a thread reads the same before and after the rename lands.
 */
export function derivedThreadTitle(
  agentName: string,
  updatedAtIso: string | null | undefined,
): string {
  const when = stamp(updatedAtIso);
  return cap(when ? `${agentName} - ${when}` : agentName);
}

/**
 * What the sidebar row reads: a real title wins outright, a stub is replaced by
 * the derived name.
 */
export function threadDisplayTitle(
  title: string | null | undefined,
  agentName: string,
  updatedAtIso: string | null | undefined,
): string {
  if (!isStubThreadTitle(title)) return (title ?? '').trim();
  return derivedThreadTitle(agentName, updatedAtIso);
}
