import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lastAgent, rememberAgent } from '../lastSession';

const KEYS = ['jobreq', 'assignrec', 'otp', 'jobchange'];

function fakeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string) => { map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); },
    clear: () => map.clear(),
    get size() { return map.size; },
  };
}

beforeEach(() => {
  vi.stubGlobal('localStorage', fakeStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the remembered agent', () => {
  it('is nothing until one is remembered', () => {
    expect(lastAgent(KEYS)).toBeNull();
  });

  it('survives so a reload comes back to the same agent', () => {
    rememberAgent('jobchange');
    expect(lastAgent(KEYS)).toBe('jobchange');
  });

  it('is ignored when the registry no longer offers it', () => {
    // The registry is the authority: an agent that was removed, renamed or
    // marked coming-soon must not beat the registry's own default.
    rememberAgent('retired-agent');
    expect(lastAgent(KEYS)).toBeNull();
    expect(lastAgent([])).toBeNull();
  });

  it('ignores an empty key rather than storing one', () => {
    rememberAgent('jobchange');
    rememberAgent('');
    expect(lastAgent(KEYS)).toBe('jobchange');
  });
});

describe('when storage is unavailable', () => {
  it('never throws - a reader who cannot resume still gets a working shell', () => {
    // Safari private mode and blocked third-party storage throw on ACCESS.
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
      removeItem: () => { throw new Error('denied'); },
    });
    expect(() => rememberAgent('jobchange')).not.toThrow();
    expect(lastAgent(KEYS)).toBeNull();
  });
});

describe('a page reload does NOT restore the conversation', () => {
  it('remembers the agent and nothing about the thread', () => {
    // Product decision 2026-08-12: refresh is a clean start on the same agent.
    // The previous chat is not reopened - it waits in the sidebar - so this
    // module stores exactly one key and no thread state of any kind.
    rememberAgent('jobchange');
    expect(localStorage.size).toBe(1);
    expect(localStorage.getItem('tko-last-agent')).toBe('jobchange');
    // The retired key must not reappear under any name.
    const keys: string[] = [];
    for (const k of ['tko-last-thread:jobchange', 'tko-last-thread']) {
      if (localStorage.getItem(k) !== null) keys.push(k);
    }
    expect(keys).toEqual([]);
  });
});
