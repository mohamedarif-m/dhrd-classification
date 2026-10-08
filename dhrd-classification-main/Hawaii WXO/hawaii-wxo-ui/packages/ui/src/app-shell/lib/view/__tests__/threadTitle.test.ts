/**
 * THE SIDEBAR FULL OF ROWS CALLED "start" (wave-2 campaign, promoted UX item).
 *
 * Every agent's welcome copy invites the reader to type "start", the platform
 * titles a thread from its first user message, and the result is a chat history
 * in which every row has the same name.
 *
 * The fix is deliberately dumb: agent name plus when the chat happened. An
 * earlier cut derived the thread's SUBJECT from the review rows and was dropped
 * (see threadTitle.ts) - it needed a label heuristic over tool copy that got
 * Job Requisition wrong on contact with real rows, and it wrote a named
 * individual into a stored title. Nothing here names anyone.
 */
import { describe, expect, it } from 'vitest';
import {
  TITLE_CAP,
  derivedThreadTitle,
  isStubThreadTitle,
  threadDisplayTitle,
} from '../threadTitle';
import { ENVELOPE_SENTINEL } from '../../chat/useAgentChat';

const WHEN = '2026-08-13T14:32:00Z';

describe('which titles are placeholders', () => {
  it('catches what this product actually gets from the platform', () => {
    for (const t of [
      'start', 'Start', 'START', '"start"', ' start ', 'start.',
      '', '   ', 'begin', 'go', 'hi', 'Hello', 'hey',
      'new chat', 'Untitled', 'untitled chat', 'New conversation',
    ]) {
      expect(isStubThreadTitle(t), `should be a stub: ${JSON.stringify(t)}`).toBe(true);
    }
    expect(isStubThreadTitle(null)).toBe(true);
    expect(isStubThreadTitle(undefined)).toBe(true);
  });

  /**
   * A thread whose first user message was a form submission gets titled with
   * that message - a line of raw JSON, the least readable thing that could
   * appear in the sidebar.
   */
  it('treats a raw form envelope as a placeholder, not a name', () => {
    expect(isStubThreadTitle(`${ENVELOPE_SENTINEL} {"tool":"jcc_start","args":{}}`))
      .toBe(true);
    expect(isStubThreadTitle(`  ${ENVELOPE_SENTINEL} {}`)).toBe(true);
  });

  it('leaves anything a person might have meant alone', () => {
    for (const t of [
      'Riley Stone promotion',
      'Q3 bonus run',
      'start of quarter payments', // starts with the word, is not the word
      'Payments',
      'R0008169',
    ]) {
      expect(isStubThreadTitle(t), `should NOT be a stub: ${t}`).toBe(false);
    }
  });
});

describe('what the sidebar row reads', () => {
  it('a real title wins outright', () => {
    expect(threadDisplayTitle('Riley Stone promotion', 'Job Change', WHEN))
      .toBe('Riley Stone promotion');
  });

  it('a stub becomes the agent name and when it happened', () => {
    const shown = threadDisplayTitle('start', 'Job Change', WHEN);
    expect(shown, 'THE SIDEBAR STILL SAYS "start"').not.toBe('start');
    expect(shown.startsWith('Job Change - ')).toBe(true);
  });

  it('names nobody - the label is the agent and a timestamp, never a person', () => {
    const shown = threadDisplayTitle('start', 'Job Change', WHEN);
    expect(shown).toMatch(/^Job Change - [A-Za-z]{3} \d{1,2}, /);
  });

  it('two stub threads at different times do not read the same', () => {
    const a = threadDisplayTitle('start', 'Job Change', '2026-08-13T14:32:00Z');
    const b = threadDisplayTitle('start', 'Job Change', '2026-08-11T09:05:00Z');
    expect(a).not.toBe(b);
  });

  it('falls back to the bare agent name when the timestamp is unusable', () => {
    expect(threadDisplayTitle('start', 'Job Change', null)).toBe('Job Change');
    expect(threadDisplayTitle('start', 'Job Change', 'not-a-date')).toBe('Job Change');
  });

  it('the displayed label and the stored title the shell writes back agree', () => {
    // The shell PATCHes derivedThreadTitle; the row renders threadDisplayTitle.
    // They must be the same string or the row visibly changes when it lands.
    expect(threadDisplayTitle('start', 'Job Change', WHEN))
      .toBe(derivedThreadTitle('Job Change', WHEN));
  });
});

describe('the title written back to the server', () => {
  it('respects the server cap', () => {
    const long = derivedThreadTitle('A very long agent name '.repeat(10), WHEN);
    expect(long.length).toBeLessThanOrEqual(TITLE_CAP);
  });

  it('a derived title is never itself a stub, so it is never re-derived', () => {
    expect(isStubThreadTitle(derivedThreadTitle('Job Change', WHEN))).toBe(false);
  });
});
