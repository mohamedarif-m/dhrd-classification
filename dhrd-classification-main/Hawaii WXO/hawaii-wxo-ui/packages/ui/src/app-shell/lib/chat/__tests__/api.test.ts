/**
 * Upload response mapping. The proxy answers `POST /uploads` with a files[]
 * whose per-file statusCode/invalid/error* keys decide the outcome; this pins
 * that reading, plus the request shape uploadFile puts on the wire.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchOptions, mapUploadResponse, optionsRetryDelayMs, parseRetryAfter, uploadFile,
} from '../api';

const okRow = {
  fileName: 'jd.pdf',
  id: 'file-123',
  url: 'https://api.watson-orchestrate.ibm.com/files/file-123',
  statusCode: 200,
  invalid: false,
};

describe('mapUploadResponse', () => {
  it('maps a clean 200 row to the file URL', () => {
    expect(mapUploadResponse({ files: [okRow] })).toEqual({
      name: 'jd.pdf', url: okRow.url, id: 'file-123',
    });
  });

  it('falls back to the local file name when the row carries none', () => {
    expect(mapUploadResponse({ files: [{ ...okRow, fileName: undefined }] }, 'local.pdf'))
      .toEqual({ name: 'local.pdf', url: okRow.url, id: 'file-123' });
  });

  it('treats an invalid row as a failure even on statusCode 200', () => {
    const body = { files: [{ ...okRow, invalid: true, errorSubject: 'Unsupported file type' }] };
    expect(mapUploadResponse(body)).toEqual({ error: 'Unsupported file type' });
  });

  it('prefers errorSubject, then errorBody, then a generic line', () => {
    const row = { statusCode: 500, invalid: true };
    expect(mapUploadResponse({ files: [{ ...row, errorSubject: 'S', errorBody: 'B' }] }))
      .toEqual({ error: 'S' });
    expect(mapUploadResponse({ files: [{ ...row, errorBody: 'B' }] })).toEqual({ error: 'B' });
    expect(mapUploadResponse({ files: [row] })).toEqual({ error: 'Upload failed. Try again.' });
  });

  it('fails when the row has no url, and when there is no row at all', () => {
    expect(mapUploadResponse({ files: [{ ...okRow, url: undefined }] }))
      .toEqual({ error: 'Upload failed. Try again.' });
    expect(mapUploadResponse({ files: [] })).toEqual({ error: 'Upload failed. Try again.' });
    expect(mapUploadResponse({})).toEqual({ error: 'Upload failed. Try again.' });
    expect(mapUploadResponse(null)).toEqual({ error: 'Upload failed. Try again.' });
  });
});

describe('uploadFile', () => {
  const stubClient = () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
    });
    vi.stubGlobal('crypto', { randomUUID: () => 'anon-1' });
  };

  afterEach(() => { vi.unstubAllGlobals(); });

  it('posts multipart under the field "file" with the client header and no Content-Type', async () => {
    stubClient();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ files: [okRow] }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const file = new File(['x'], 'jd.pdf', { type: 'application/pdf' });
    const result = await uploadFile(file);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/uploads');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['X-TKO-Client']).toBe('anon-1');
    expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
    expect((init.body as FormData).get('file')).toBe(file);
    expect(result).toEqual({ name: 'jd.pdf', url: okRow.url, id: 'file-123' });
  });

  it('resolves an error (never throws) on a non-ok response and on a network failure', async () => {
    stubClient();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 502 })));
    expect(await uploadFile(new File(['x'], 'a.pdf'))).toEqual({
      error: 'Upload failed. Try again. (HTTP 502)',
    });

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    expect(await uploadFile(new File(['x'], 'a.pdf'))).toEqual({
      error: 'Upload failed. Try again.',
    });
  });
});

describe('parseRetryAfter', () => {
  it('reads delta-seconds and clamps a negative one to zero', () => {
    expect(parseRetryAfter('5')).toBe(5000);
    expect(parseRetryAfter(' 0 ')).toBe(0);
    expect(parseRetryAfter('-3')).toBe(0);
  });

  it('reads an HTTP date as the distance from now', () => {
    const ms = parseRetryAfter(new Date(Date.now() + 4000).toUTCString());
    expect(ms).toBeGreaterThan(2000);
    expect(ms).toBeLessThanOrEqual(4000);
  });

  it('is null when the header is absent or unreadable', () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter(undefined)).toBeNull();
    expect(parseRetryAfter('')).toBeNull();
    expect(parseRetryAfter('soon')).toBeNull();
  });
});

describe('optionsRetryDelayMs', () => {
  it('retries 429, 5xx and a thrown fetch (status 0)', () => {
    expect(optionsRetryDelayMs(429)).toBe(5000);
    expect(optionsRetryDelayMs(500)).toBe(5000);
    expect(optionsRetryDelayMs(503)).toBe(5000);
    expect(optionsRetryDelayMs(0)).toBe(5000);
  });

  it('honors Retry-After over the default wait, capped', () => {
    expect(optionsRetryDelayMs(429, '2')).toBe(2000);
    expect(optionsRetryDelayMs(503, '45')).toBe(20000);
  });

  it('gives up on every other 4xx', () => {
    expect(optionsRetryDelayMs(404)).toBeNull();
    expect(optionsRetryDelayMs(400, '2')).toBeNull();
    expect(optionsRetryDelayMs(403)).toBeNull();
  });
});

describe('fetchOptions', () => {
  const stubBrowser = (random = 0) => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
    });
    vi.stubGlobal('crypto', { randomUUID: () => 'anon-1' });
    vi.spyOn(Math, 'random').mockReturnValue(random);
  };

  const ready = () => new Response(
    JSON.stringify({ status: 'ready', rows: [{ key: 'a', cells: ['A'] }], total: 1 }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
  const limited = (retryAfter?: string) => new Response('{"detail": "rate limited"}', {
    status: 429, headers: retryAfter ? { 'Retry-After': retryAfter } : {},
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('retries a 429 and resolves the rows the next attempt returns', async () => {
    stubBrowser();
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(limited())
      .mockResolvedValueOnce(ready());
    vi.stubGlobal('fetch', fetchMock);

    const pending = fetchOptions('jobreq', 'sup-orgs');
    await vi.runAllTimersAsync();

    expect(await pending).toEqual({ rows: [{ key: 'a', cells: ['A'] }], total: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0])
      .toBe('/api/options?agent_key=jobreq&source=sup-orgs');
  });

  it('waits the Retry-After the server named before trying again', async () => {
    stubBrowser();
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(limited('8'))
      .mockResolvedValueOnce(ready());
    vi.stubGlobal('fetch', fetchMock);

    const pending = fetchOptions('jobreq', 'sup-orgs');
    await vi.advanceTimersByTimeAsync(7000);
    expect(fetchMock).toHaveBeenCalledTimes(1);   // still inside the 8s the header asked for
    await vi.advanceTimersByTimeAsync(1500);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await pending).toEqual({ rows: [{ key: 'a', cells: ['A'] }], total: 1 });
  });

  it('polls while the proxy warms the set, then returns it', async () => {
    stubBrowser();
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'loading' }), { status: 200 }))
      .mockResolvedValueOnce(ready());
    vi.stubGlobal('fetch', fetchMock);

    const pending = fetchOptions('jobreq', 'sup-orgs');
    await vi.runAllTimersAsync();

    expect(await pending).toEqual({ rows: [{ key: 'a', cells: ['A'] }], total: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up at once on a terminal 404', async () => {
    stubBrowser();
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response('{"detail": "Unknown options source"}',
      { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);

    const pending = fetchOptions('jobreq', 'nope');
    await vi.runAllTimersAsync();

    expect(await pending).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a thrown fetch and stops once the budget is spent', async () => {
    stubBrowser();
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => { throw new Error('offline'); });
    vi.stubGlobal('fetch', fetchMock);

    const pending = fetchOptions('jobreq', 'sup-orgs');
    await vi.runAllTimersAsync();

    expect(await pending).toBeNull();
    // 120s budget / 5s retry wait, so it kept trying rather than failing once.
    expect(fetchMock.mock.calls.length).toBeGreaterThan(5);
  });
});
