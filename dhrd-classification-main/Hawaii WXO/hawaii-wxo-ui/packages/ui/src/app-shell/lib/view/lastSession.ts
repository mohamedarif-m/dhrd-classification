/**
 * What survives a page reload: which agent the reader was on. Nothing else.
 *
 * REFRESH = CLEAN START ON THE SAME AGENT (product decision 2026-08-12). A
 * reload lands on the agent the reader was using, with a fresh surface - which
 * means the instant entry form - and the previous conversation waits in the
 * sidebar thread list, one click away.
 *
 * This module used to remember the open THREAD too, and the surface reopened
 * it on mount. That was the right fix for the original complaint (a reload in
 * focus mode left the reader with a welcome bubble and no way back), but it
 * overshot: refresh became the one gesture that could not produce a clean
 * form, which is the very thing readers reach for it to do. The instant entry
 * form closes the original gap from the other side - a reload now always shows
 * something useful immediately - so the thread half of this module is gone
 * rather than left dormant.
 *
 * The second thing it fixes is still needed and still here: leaving focus mode
 * without an `?agent=` param used to fall back to the FIRST agent in the
 * registry, which then listed threads for an agent the reader had never used.
 *
 * Storage is best-effort. Safari private mode and blocked third-party storage
 * make localStorage throw on access, and a reader who cannot resume is a much
 * smaller problem than a shell that will not boot, so every path here swallows
 * its errors.
 */

const AGENT_KEY = 'tko-last-agent';

function read(key: string): string | null {
  try {
    const v = localStorage.getItem(key);
    return v && v.trim() ? v : null;
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch { /* storage unavailable: resume is best-effort */ }
}

/** Remember the agent the reader is on. */
export function rememberAgent(agentKey: string): void {
  if (agentKey) write(AGENT_KEY, agentKey);
}

/**
 * The agent to boot on, or null. `valid` is the set of keys the live registry
 * actually offers: a remembered agent that has since been removed, renamed or
 * marked coming-soon must not win over the registry's own default.
 */
export function lastAgent(valid: readonly string[]): string | null {
  const key = read(AGENT_KEY);
  return key && valid.includes(key) ? key : null;
}
