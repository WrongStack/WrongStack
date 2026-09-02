import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ClientRequest, IncomingMessage } from 'node:http';
import { Socket } from 'node:net';

type HttpGetImplementation = (...args: unknown[]) => ClientRequest;

function getResponseCallback(args: readonly unknown[]): (response: IncomingMessage) => void {
  const callback = args.find(
    (arg): arg is (response: IncomingMessage) => void => typeof arg === 'function',
  );
  if (!callback) throw new Error('HTTP response callback was not provided');
  return callback;
}

function createMockRequest(): ClientRequest {
  const request = Object.create(ClientRequest.prototype) as ClientRequest;
  request.end = vi.fn();
  request.destroy = vi.fn(() => request);
  return request;
}

// ── Mock infrastructure ────────────────────────────────────────────────
//
// lookupRegistry → httpsFetch → https.get / http.get.
// We mock node:https and node:http to return synthetic responses, so the
// retry/cache/404/429/backoff logic in lookupRegistry can be exercised
// deterministically without any real network I/O.

function createMockResponse(
  statusCode: number,
  headers: Record<string, string> = {},
): IncomingMessage {
  const response = new IncomingMessage(new Socket());
  response.statusCode = statusCode;
  Object.assign(response.headers, headers);
  return response;
}

function emitResponse(response: IncomingMessage, body: string): void {
  setTimeout(() => {
    response.emit('data', body);
    response.emit('end');
  }, 0);
}

function mockGet(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): ReturnType<typeof vi.fn<HttpGetImplementation>> {
  return vi.fn<HttpGetImplementation>((...args: unknown[]) => {
    const response = createMockResponse(status, headers);
    getResponseCallback(args)(response);
    emitResponse(response, body);
    return createMockRequest();
  });
}

vi.mock('node:https', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:https')>()),
  get: vi.fn(),
}));

vi.mock('node:http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:http')>()),
  get: vi.fn(),
}));

import { get as httpsGet } from 'node:https';
import { get as httpGet } from 'node:http';
import { lookupRegistry, clearRegistryCache } from '../src/registry/client.js';

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
      mockGet(
        200,
        JSON.stringify({
          'dist-tags': { latest: '1.2.3' },
          license: 'MIT',
          versions: {},
        }),
        { etag: '"abc"' },
      ),
    );

    const entry = await lookupRegistry('npm', 'test-pkg');
    expect(entry).toBeDefined();
    expect(entry!.latestStable).toBe('1.2.3');
    expect(entry!.license).toBe('MIT');
    expect(entry!.source).toContain('test-pkg');
  });

  it('caches successful lookups (second call does not hit the network)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const mockImpl = mockGet(
      200,
      JSON.stringify({
        'dist-tags': { latest: '1.0.0' },
      }),
    );
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
    mockedHttpsGet.mockImplementation((...args: unknown[]) => {
      const cb = getResponseCallback(args);
      callCount++;
      const status = callCount === 1 ? 429 : 200;
      const body = callCount === 1 ? '' : JSON.stringify({ 'dist-tags': { latest: '1.0.0' } });
      const res = createMockResponse(status);
      cb(res);
      emitResponse(res, body);
      return createMockRequest();
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
    mockedHttpsGet.mockImplementation((...args: unknown[]) => {
      const cb = getResponseCallback(args);
      callCount++;
      const status = callCount === 1 ? 503 : 200;
      const body = callCount === 1 ? '' : JSON.stringify({ 'dist-tags': { latest: '2.0.0' } });
      const res = createMockResponse(status);
      cb(res);
      emitResponse(res, body);
      return createMockRequest();
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
      const request = createMockRequest();
      setTimeout(() => request.emit('error', new Error('ECONNREFUSED')), 0);
      return request;
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
    mockedHttpsGet.mockImplementation((...args: unknown[]) => {
      const cb = getResponseCallback(args);
      const body = JSON.stringify({ 'dist-tags': { latest: latestVersion } });
      const res = createMockResponse(200);
      cb(res);
      emitResponse(res, body);
      return createMockRequest();
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
    mockedHttpsGet.mockImplementation((...args: unknown[]) => {
      const cb = getResponseCallback(args);
      callCount++;
      const status = callCount === 1 ? 200 : 304;
      const body = callCount === 1 ? JSON.stringify({ 'dist-tags': { latest: '1.5.0' } }) : '';
      const headers = callCount === 1 ? { etag: '"v1"' } : {};
      const res = createMockResponse(status, headers);
      cb(res);
      emitResponse(res, body);
      return createMockRequest();
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
    await expect(lookupRegistry('unknown-ecosystem', 'pkg')).rejects.toThrow(
      'Unsupported ecosystem',
    );
  });
});

// ── lookupRegistryBatch ───────────────────────────────────────────────

describe('lookupRegistryBatch', () => {
  it('returns a map of results for multiple packages', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockedHttpsGet.mockImplementation((...args: unknown[]) => {
      const cb = getResponseCallback(args);
      const body = JSON.stringify({ 'dist-tags': { latest: '1.0.0' } });
      const res = createMockResponse(200);
      cb(res);
      emitResponse(res, body);
      return createMockRequest();
    });

    const { lookupRegistryBatch } = await import('../src/registry/client.js');
    const results = await lookupRegistryBatch('npm', ['pkg-a', 'pkg-b']);
    expect(results.size).toBe(2);
    expect(results.get('pkg-a')).toBeDefined();
    expect(results.get('pkg-b')).toBeDefined();
  });

  it('deduplicates names before allocating batch work', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockedHttpsGet.mockImplementation((...args: unknown[]) => {
      const cb = getResponseCallback(args);
      const res = createMockResponse(200);
      cb(res);
      emitResponse(res, JSON.stringify({ 'dist-tags': { latest: '1.0.0' } }));
      return createMockRequest();
    });

    const { lookupRegistryBatch } = await import('../src/registry/client.js');
    const results = await lookupRegistryBatch('npm', ['pkg-a', 'pkg-a', 'pkg-b']);
    expect(results.size).toBe(2);
    expect(mockedHttpsGet).toHaveBeenCalledTimes(2);
  });

  it('handles errors in batch gracefully', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockedHttpsGet.mockImplementation(mockGet(404, 'not found'));

    const { lookupRegistryBatch } = await import('../src/registry/client.js');
    const results = await lookupRegistryBatch('npm', ['missing-a', 'missing-b']);
    expect(results.size).toBe(2);
    expect(results.get('missing-a')).toBeUndefined();
    expect(results.get('missing-b')).toBeUndefined();
  });
});

// ── Per-ecosystem parsers ──────────────────────────────────────────────

describe('lookupRegistry — per-ecosystem parsers', () => {
  it('parses PyPI JSON for python ecosystem', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockedHttpsGet.mockImplementation(
      mockGet(
        200,
        JSON.stringify({
          info: { name: 'django', version: '5.2.1', license: 'BSD' },
        }),
      ),
    );

    const entry = await lookupRegistry('python', 'django');
    expect(entry).toBeDefined();
    expect(entry!.latestStable).toBe('5.2.1');
    expect(entry!.license).toBe('BSD');
    expect(entry!.source).toContain('pypi.org');
  });

  it('parses crates.io JSON for cargo ecosystem', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockedHttpsGet.mockImplementation(
      mockGet(
        200,
        JSON.stringify({
          crate: { max_stable_version: '1.2.3', license: 'MIT', name: 'serde' },
        }),
      ),
    );

    const entry = await lookupRegistry('cargo', 'serde');
    expect(entry).toBeDefined();
    expect(entry!.latestStable).toBe('1.2.3');
    expect(entry!.license).toBe('MIT');
  });

  it('parses Go proxy JSON for golang ecosystem', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockedHttpsGet.mockImplementation(mockGet(200, JSON.stringify({ Version: '1.21.0' })));

    const entry = await lookupRegistry('golang', 'github.com/gorilla/mux');
    expect(entry).toBeDefined();
    expect(entry!.latestStable).toBe('1.21.0');
    expect(entry!.license).toBeUndefined();
  });

  it('parses NuGet V3 JSON for nuget ecosystem', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockedHttpsGet.mockImplementation(
      mockGet(
        200,
        JSON.stringify({
          items: [
            {
              items: [
                {
                  catalogEntry: { version: '6.0.0' },
                },
              ],
            },
          ],
        }),
      ),
    );

    const entry = await lookupRegistry('nuget', 'Newtonsoft.Json');
    expect(entry).toBeDefined();
    expect(entry!.latestStable).toBe('6.0.0');
  });

  it('prefers non-prerelease versions in NuGet parser', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockedHttpsGet.mockImplementation(
      mockGet(
        200,
        JSON.stringify({
          items: [
            {
              items: [
                { catalogEntry: { version: '7.0.0-preview.1' } },
                { catalogEntry: { version: '6.0.0' } },
              ],
            },
          ],
        }),
      ),
    );

    const entry = await lookupRegistry('nuget', 'Some.Package');
    expect(entry).toBeDefined();
    expect(entry!.latestStable).toBe('6.0.0');
  });

  it('parses Packagist JSON for composer ecosystem', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockedHttpsGet.mockImplementation(
      mockGet(
        200,
        JSON.stringify({
          packages: {
            'monolog/monolog': [{ version: '3.0.0', license: 'MIT' }, { version: '2.9.0' }],
          },
        }),
      ),
    );

    const entry = await lookupRegistry('composer', 'monolog/monolog');
    expect(entry).toBeDefined();
    expect(entry!.latestStable).toBe('3.0.0');
    expect(entry!.license).toBe('MIT');
  });

  it('parses pub.dev JSON for pub ecosystem', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockedHttpsGet.mockImplementation(
      mockGet(
        200,
        JSON.stringify({
          name: 'flutter',
          latestVersion: '3.22.0',
          latest: { license: 'BSD-3-Clause' },
          isDiscontinued: false,
          isRetracted: false,
        }),
      ),
    );

    const entry = await lookupRegistry('pub', 'flutter');
    expect(entry).toBeDefined();
    expect(entry!.latestStable).toBe('3.22.0');
    expect(entry!.license).toBe('BSD-3-Clause');
    expect(entry!.deprecated).toBe(false);
    expect(entry!.yanked).toBe(false);
  });
});

// ── strictErrors ───────────────────────────────────────────────────────

describe('lookupRegistry — strictErrors', () => {
  it('throws RegistryNotFoundError for 404 when strictErrors is true', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockedHttpsGet.mockImplementation(mockGet(404, 'not found'));

    await expect(lookupRegistry('npm', 'missing', { strictErrors: true })).rejects.toThrow(
      'Registry package not found or inaccessible',
    );
  });

  it('throws RegistryAuthError for 403 when strictErrors is true', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockedHttpsGet.mockImplementation(mockGet(403, 'forbidden'));

    await expect(lookupRegistry('npm', 'private', { strictErrors: true })).rejects.toThrow(
      'Registry authorization failed',
    );
  });

  it('throws RegistryNotFoundError for 401 when strictErrors is true', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockedHttpsGet.mockImplementation(mockGet(401, 'unauthorized'));

    await expect(lookupRegistry('npm', 'unauth', { strictErrors: true })).rejects.toThrow(
      'Registry package not found or inaccessible',
    );
  });
});

// ── 5xx errors ─────────────────────────────────────────────────────────

describe('lookupRegistry — 5xx after retries exhausted', () => {
  it('throws RegistryNetworkError on persistent 503', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockedHttpsGet.mockImplementation(mockGet(503, 'service unavailable'));

    const promise = lookupRegistry('npm', 'always-503').catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(60000);
    const result = await promise;
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain('503');
  });
});

// ── Unexpected status code ─────────────────────────────────────────────

describe('lookupRegistry — unexpected status code', () => {
  it('throws on unexpected 3xx status code', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockedHttpsGet.mockImplementation(mockGet(302, 'redirected'));

    const promise = lookupRegistry('npm', 'redirected').catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(60000);
    const result = await promise;
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain('302');
  });
});
