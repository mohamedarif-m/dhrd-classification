import { describe, expect, it } from 'vitest';
import { parseDeepLink } from '../deepLink';

const KEYS = ['jobreq', 'assignrec', 'otp'];

describe('parseDeepLink', () => {
  it('returns nothing selected when there are no params', () => {
    expect(parseDeepLink('', KEYS)).toEqual({ agentKey: undefined, focus: false });
    expect(parseDeepLink('?', KEYS)).toEqual({ agentKey: undefined, focus: false });
    expect(parseDeepLink(undefined, KEYS)).toEqual({ agentKey: undefined, focus: false });
  });

  it('selects a valid agent key', () => {
    expect(parseDeepLink('?agent=jobreq', KEYS).agentKey).toBe('jobreq');
    // Leading '?' is optional.
    expect(parseDeepLink('agent=otp', KEYS).agentKey).toBe('otp');
  });

  it('ignores an unknown agent key so the host default stands', () => {
    expect(parseDeepLink('?agent=nope', KEYS).agentKey).toBeUndefined();
    // Keys are exact: no case folding, no prefix matching.
    expect(parseDeepLink('?agent=JobReq', KEYS).agentKey).toBeUndefined();
    expect(parseDeepLink('?agent=job', KEYS).agentKey).toBeUndefined();
    // An empty registry can never match.
    expect(parseDeepLink('?agent=jobreq', []).agentKey).toBeUndefined();
  });

  it('reads the focus flag', () => {
    expect(parseDeepLink('?focus=1', KEYS).focus).toBe(true);
    expect(parseDeepLink('?focus=true', KEYS).focus).toBe(true);
    expect(parseDeepLink('?focus=TRUE', KEYS).focus).toBe(true);
    expect(parseDeepLink('?focus=0', KEYS).focus).toBe(false);
    expect(parseDeepLink('?focus=', KEYS).focus).toBe(false);
    expect(parseDeepLink('?focus=maybe', KEYS).focus).toBe(false);
  });

  it('reads both params together and tolerates unrelated ones', () => {
    expect(parseDeepLink('?agent=jobreq&focus=1&inTeams=1', KEYS))
      .toEqual({ agentKey: 'jobreq', focus: true });
  });
});
