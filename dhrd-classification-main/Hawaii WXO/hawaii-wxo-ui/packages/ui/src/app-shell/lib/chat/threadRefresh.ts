/**
 * One deferred re-listing of the sidebar when the list that came back did not
 * yet contain the thread the reader just started.
 *
 * Why it exists: `run.started` tells the shell a thread id, and the shell
 * answers by re-listing threads. The server holds that frame until the row is
 * shared (see the landed barrier in the proxy's thread store), so the list
 * normally has it. If the barrier ever times out - a sick object store, a slow
 * round trip - the row is real but not yet visible, and nothing else would ask
 * again until the next mount, agent switch or rename. This asks once more.
 *
 * Deliberately small and generic: it knows nothing about agents, and it fires
 * at most once per thread id, so a listing that keeps missing the row cannot
 * turn into a polling loop.
 */

/** How long to wait before the single retry. Comfortably past a late push. */
export const THREAD_RETRY_MS = 1500;

export type ThreadRefreshRetry = {
  /** Feed it a listing and the thread that listing was supposed to contain. */
  consider: (rows: { thread_id: string }[], threadId?: string) => void;
  /** Drop a pending retry (unmount, agent switch). */
  cancel: () => void;
};

export function createThreadRefreshRetry(
  refresh: (threadId: string) => void,
  delayMs: number = THREAD_RETRY_MS,
): ThreadRefreshRetry {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const retried = new Set<string>();
  const cancel = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  return {
    consider(rows, threadId) {
      if (!threadId || retried.has(threadId)) return;
      if (rows.some((r) => r.thread_id === threadId)) return;
      retried.add(threadId);
      cancel();
      timer = setTimeout(() => {
        timer = null;
        refresh(threadId);
      }, delayMs);
    },
    cancel,
  };
}
