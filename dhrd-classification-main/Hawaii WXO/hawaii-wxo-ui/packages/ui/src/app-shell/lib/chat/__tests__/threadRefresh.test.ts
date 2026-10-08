import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { THREAD_RETRY_MS, createThreadRefreshRetry } from '../threadRefresh';

const rows = (...ids: string[]) => ids.map((thread_id) => ({ thread_id }));

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the deferred re-listing of a thread that has not landed', () => {
  it('does nothing when the listing already has the thread', () => {
    const refresh = vi.fn();
    const retry = createThreadRefreshRetry(refresh);
    retry.consider(rows('t-1', 't-2'), 't-1');
    vi.advanceTimersByTime(10_000);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('does nothing when the listing was not triggered by a new thread', () => {
    const refresh = vi.fn();
    const retry = createThreadRefreshRetry(refresh);
    retry.consider(rows('t-2'), undefined);
    vi.advanceTimersByTime(10_000);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('asks again once when the thread is missing', () => {
    const refresh = vi.fn();
    const retry = createThreadRefreshRetry(refresh);
    retry.consider(rows('t-2'), 't-1');
    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(THREAD_RETRY_MS);
    expect(refresh).toHaveBeenCalledWith('t-1');
  });

  it('never turns into a polling loop', () => {
    const refresh = vi.fn();
    const retry = createThreadRefreshRetry(refresh);
    retry.consider(rows(), 't-1');
    vi.advanceTimersByTime(THREAD_RETRY_MS);
    // The retry's own listing still misses it: that is the end of the road.
    retry.consider(rows(), 't-1');
    vi.advanceTimersByTime(60_000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('is cancelled by an unmount or an agent switch', () => {
    const refresh = vi.fn();
    const retry = createThreadRefreshRetry(refresh);
    retry.consider(rows(), 't-1');
    retry.cancel();
    vi.advanceTimersByTime(60_000);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('follows the next thread when an earlier one already retried', () => {
    const refresh = vi.fn();
    const retry = createThreadRefreshRetry(refresh);
    retry.consider(rows(), 't-1');
    vi.advanceTimersByTime(THREAD_RETRY_MS);
    retry.consider(rows('t-1'), 't-2');
    vi.advanceTimersByTime(THREAD_RETRY_MS);
    expect(refresh.mock.calls).toEqual([['t-1'], ['t-2']]);
  });
});
