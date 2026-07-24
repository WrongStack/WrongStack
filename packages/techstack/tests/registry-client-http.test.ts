import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ClientRequest } from 'node:http';

// ── Mock infrastructure ────────────────────────────────────────────────
//
// lookupRegistry → httpsFetch → https.get / http.get.
// We mock node:https and node:http to return synthetic responses, so the
// retry/cache/404/429/backoff logic in lookupRegistry can be exercised
// deterministically without any real network I/O.

function createMockResponse(
  statusCode: number,
  _body: string,
  headers: Record<string, string> = {},
): IncomingMessage {
  const listeners: Record<string, Array<(arg?: unknown) => void>> = {};
  return {
    statusCode,
    headers,
    on(event: string, cb: (arg?: unknown) => void) {
      const eventListeners = listeners[event] ?? [];
      eventListeners.push(cb);
      listeners[event] = eventListeners;
      return this as IncomingMessage;
    },
    // Allow the mock to emit events synchronously
    _emit(event: string, arg?: unknown) {
      for (const cb of listeners[event] ?? []) cb(arg);
    },
  } as unknown as IncomingMessage;
}

function mockGet(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): ReturnType<typeof vi.fn> {
  return vi.fn((_options: unknown, callback: (res: IncomingMessage) => void) => {
    const res = createMockResponse(status, body, headers);
    // Call the callback synchronously with the response object
    callback(res);
    // Then emit data + end on next tick
    setTimeout(() => {
      (res as unknown as { _emit: (e: string, a?: unknown) => void })._emit('data', body);
      (res as unknown as { _emit: (e: string, a?: unknown) => void })._emit('end');
    }, 0);

    const fakeReq: Partial<ClientRequest> = {
      on: vi.fn(() => fakeReq as ClientRequest),
      end: vi.fn(),
      destroy: vi.fn(),
    };
    return fakeReq as ClientRequest;
  });
}

vi.mock('node:https', () => ({
  get: vi.fn(),
}));

vi.mock('node:http', () => ({
  get: vi.fn(),
}));

import { get as httpsGet } from 'node:https';
import { get as httpGet } from 'node:http';
import {
  lookupRegistry,
  clearRegistryCache,
} from '../src/registry/client.js';

const mockedHttpsGet = vi.mocked(httpsGet);
const mockedHttpGet = vi.mocked(httpGet);

beforeEach(() => {
  clearRegistryCache();
  mockedHttpsGet.mockReset();
  mockedHttpGet.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

// ── Success: 2xx → parsed entry ───────────────────────────────────────

describe('lookupRegistry — success', () => {
  it('fetches and parses npm registry metadata', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockedHttpsGet.mockImplementation(
      mockGet(200, JSON.stringify({
        'dist-tags': { latest: '1.2.3' },
        license: 'MIT',
        versions: {},
      }), { etag: '"abc"' }),
    );

    const entry = await lookupRegistry('npm', 'test-pkg');
    expect(entry).toBeDefined();
    expect(entry!.latestStable).toBe('1.2.3');
    expect(entry!.license).toBe('MIT');
    expect(entry!.source).toContain('test-pkg');
  });

  it('caches successful lookups (second call does not hit the network)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const mockImpl = mockGet(200, JSON.stringify({
      'dist-tags': { latest: '1.0.0' },
    }));
    mockedHttpsGet.mockImplementation(mockImpl);

    await lookupRegistry('npm', 'cached-pkg');
    const firstCallCount = mockImpl.mock.calls.length;
    await lookupRegistry('npm', 'cached-pkg');
    expect(mockImpl.mock.calls.length).toBe(firstCallCount);
  });
});

// ── 404 → undefined (private/unresolved) ─────────────────────────────

describe('lookupRegistry — 404', () => {
  it('returns undefined for 404 (private or unresolved)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockedHttpsGet.mockImplementation(mockGet(404, 'not found'));

    const entry = await lookupRegistry('npm', 'missing-pkg');
    expect(entry).toBeUndefined();
  });

  it('returns undefined for 401 (unauthorized)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockedHttpsGet.mockImplementation(mockGet(401, 'unauthorized'));

    const entry = await lookupRegistry('npm', 'private-pkg');
    expect(entry).toBeUndefined();
  });

  it('returns undefined for 403 (forbidden)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockedHttpsGet.mockImplementation(mockGet(403, 'forbidden'));

    const entry = await lookupRegistry('npm', 'forbidden-pkg');
    expect(entry).toBeUndefined();
  });
});

// ── 429/5xx → retry with backoff ──────────────────────────────────────

describe('lookupRegistry — 429/5xx retry', () => {
  it('retries on 429 and succeeds on the next attempt', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let callCount = 0;
    mockedHttpsGet.mockImplementation((_opts: unknown, cb: (res: IncomingMessage) => void) => {
      callCount++;
      const status = callCount === 1 ? 429 : 200;
      const body = callCount === 1 ? '' : JSON.stringify({ 'dist-tags': { latest: '1.0.0' } });
      const res = createMockResponse(status, body);
      cb(res);
      setTimeout(() => {
        (res as unknown as { _emit: (e: string, a?: unknown) => void })._emit('data', body);
        (res as unknown as { _emit: (e: string, a?: unknown) => void })._emit('end');
      }, 0);
      return { on: vi.fn(() => ({ end: vi.fn(), destroy: vi.fn() } as unknown as ClientRequest)), end: vi.fn(), destroy: vi.fn() } as unknown as ClientRequest;
    });

    const promise = lookupRegistry('npm', 'retry-pkg');
    // Flush the backoff sleep so the retry happens immediately
    await vi.advanceTimersByTimeAsync(10000);
    const entry = await promise;
    expect(entry).toBeDefined();
    expect(entry!.latestStable).toBe('1.0.0');
    expect(callCount).toBeGreaterThanOrEqual(2);
  });

  it('retries on 5xx and succeeds on the next attempt', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let callCount = 0;
    mockedHttpsGet.mockImplementation((_opts: unknown, cb: (res: IncomingMessage) => void) => {
      callCount++;
      const status = callCount === 1 ? 503 : 200;
      const body = callCount === 1 ? '' : JSON.stringify({ 'dist-tags': { latest: '2.0.0' } });
      const res = createMockResponse(status, body);
      cb(res);
      setTimeout(() => {
        (res as unknown as { _emit: (e: string, a?: unknown) => void })._emit('data', body);
        (res as unknown as { _emit: (e: string, a?: unknown) => void })._emit('end');
      }, 0);
      return { on: vi.fn(() => ({ end: vi.fn(), destroy: vi.fn() } as unknown as ClientRequest)), end: vi.fn(), destroy: vi.fn() } as unknown as ClientRequest;
    });

    const promise = lookupRegistry('npm', 'retry-503');
    await vi.advanceTimersByTimeAsync(10000);
    const entry = await promise;
    expect(entry).toBeDefined();
    expect(callCount).toBeGreaterThanOrEqual(2);
  });

  it('throws after exhausting retries on persistent 429', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockedHttpsGet.mockImplementation(mockGet(429, 'rate limited'));

    // Attach the rejection handler immediately to prevent unhandled rejection
    const promise = lookupRegistry('npm', 'always-429').catch((e: Error) => e);
    // Advance through all 3 retry backoffs
    await vi.advanceTimersByTimeAsync(60000);
    const result = await promise;
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain('429');
  });
});

// ── Network error → throw ─────────────────────────────────────────────

describe('lookupRegistry — network error', () => {
  it('throws on network error after retries', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockedHttpsGet.mockImplementation(() => {
      const fakeReq: Partial<ClientRequest> = {
        on: vi.fn((event: string, cb: (e: Error) => void) => {
          if (event === 'error') setTimeout(() => cb(new Error('ECONNREFUSED')), 0);
          return fakeReq as ClientRequest;
        }),
        end: vi.fn(),
        destroy: vi.fn(),
      };
      return fakeReq as ClientRequest;
    });

    // Attach the rejection handler immediately to prevent unhandled rejection
    const promise = lookupRegistry('npm', 'broken-net').catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(60000);
    const result = await promise;
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toBe('ECONNREFUSED');
  });
});

// ── Cache: force refresh ──────────────────────────────────────────────

describe('lookupRegistry — cache force refresh', () => {
  it('re-fetches when force: true is passed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let latestVersion = '1.0.0';
    mockedHttpsGet.mockImplementation((_opts: unknown, cb: (res: IncomingMessage) => void) => {
      const body = JSON.stringify({ 'dist-tags': { latest: latestVersion } });
      const res = createMockResponse(200, body);
      cb(res);
      setTimeout(() => {
        (res as unknown as { _emit: (e: string, a?: unknown) => void })._emit('data', body);
        (res as unknown as { _emit: (e: string, a?: unknown) => void })._emit('end');
      }, 0);
      return { on: vi.fn(() => ({ end: vi.fn(), destroy: vi.fn() } as unknown as ClientRequest)), end: vi.fn(), destroy: vi.fn() } as unknown as ClientRequest;
    });

    const first = await lookupRegistry('npm', 'force-pkg');
    expect(first!.latestStable).toBe('1.0.0');

    latestVersion = '2.0.0';
    const second = await lookupRegistry('npm', 'force-pkg', { force: true });
    expect(second!.latestStable).toBe('2.0.0');
  });
});

// ── 304 Not Modified (ETag) ───────────────────────────────────────────

describe('lookupRegistry — 304 Not Modified', () => {
  it('returns cached data on 304', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let callCount = 0;
    mockedHttpsGet.mockImplementation((_opts: unknown, cb: (res: IncomingMessage) => void) => {
      callCount++;
      const status = callCount === 1 ? 200 : 304;
      const body = callCount === 1 ? JSON.stringify({ 'dist-tags': { latest: '1.5.0' } }) : '';
      const headers = callCount === 1 ? { etag: '"v1"' } : {};
      const res = createMockResponse(status, body, headers);
      cb(res);
      setTimeout(() => {
        (res as unknown as { _emit: (e: string, a?: unknown) => void })._emit('data', body);
        (res as unknown as { _emit: (e: string, a?: unknown) => void })._emit('end');
      }, 0);
      return { on: vi.fn(() => ({ end: vi.fn(), destroy: vi.fn() } as unknown as ClientRequest)), end: vi.fn(), destroy: vi.fn() } as unknown as ClientRequest;
    });

    // First call: 200 → cache entry with etag
    const first = await lookupRegistry('npm', 'etag-pkg');
    expect(first!.latestStable).toBe('1.5.0');

    // Second call (not force): cache expired path would send If-None-Match → 304
    // We need to expire the cache to trigger the 304 path; use force to bypass cache
    const second = await lookupRegistry('npm', 'etag-pkg', { force: true });
    expect(second).toBeDefined();
    expect(second!.latestStable).toBe('1.5.0');
  });
});

// ── Malformed JSON → throw ────────────────────────────────────────────

describe('lookupRegistry — malformed JSON', () => {
  it('throws on unparseable JSON body', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockedHttpsGet.mockImplementation(mockGet(200, 'not-json'));

    // Attach the rejection handler immediately to prevent unhandled rejection
    const promise = lookupRegistry('npm', 'bad-json').catch((e: Error) => e);
    // The Invalid JSON error is caught and retried 3 times with backoff.
    await vi.advanceTimersByTimeAsync(60000);
    const result = await promise;
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain('Invalid JSON');
  });
});

// ── Unsupported ecosystem ─────────────────────────────────────────────

describe('lookupRegistry — unsupported ecosystem', () => {
  it('throws for an unknown ecosystem', async () => {
    await expect(lookupRegistry('unknown-ecosystem', 'pkg')).rejects.toThrow('Unsupported ecosystem');
  });
});

// ── lookupRegistryBatch ───────────────────────────────────────────────

describe('lookupRegistryBatch', () => {
  it('returns a map of results for multiple packages', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockedHttpsGet.mockImplementation((_opts: unknown, cb: (res: IncomingMessage) => void) => {
      const body = JSON.stringify({ 'dist-tags': { latest: '1.0.0' } });
      const res = createMockResponse(200, body);
      cb(res);
      setTimeout(() => {
        (res as unknown as { _emit: (e: string, a?: unknown) => void })._emit('data', body);
        (res as unknown as { _emit: (e: string, a?: unknown) => void })._emit('end');
      }, 0);
      return { on: vi.fn(() => ({ end: vi.fn(), destroy: vi.fn() } as unknown as ClientRequest)), end: vi.fn(), destroy: vi.fn() } as unknown as ClientRequest;
    });

    const { lookupRegistryBatch } = await import('../src/registry/client.js');
    const results = await lookupRegistryBatch('npm', ['pkg-a', 'pkg-b']);
    expect(results.size).toBe(2);
    expect(results.get('pkg-a')).toBeDefined();
    expect(results.get('pkg-b')).toBeDefined();
  });
});
