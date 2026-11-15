import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createWrongTraceClient } from '../client.js';
import { defaultSocketPath, discover } from '../discovery.js';

/**
 * Minimal fetch stub. The cast through `unknown` is required because the
 * `RequestInfo` global only exists under DOM lib types — this test runs
 * in Node and just needs a structurally-compatible function.
 */
function makeFetch(
  responder: (url: string, init?: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    return responder(url, init);
  }) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('discover()', () => {
  let originalFetch: typeof fetch | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch as typeof fetch;
    // vi.useRealTimers is safe to call even when fake timers were never installed.
  });

  it('returns available:false when the daemon is unreachable', async () => {
    const result = await discover({
      baseUrl: 'http://nowhere.local',
      fetchImpl: makeFetch(() => {
        throw new Error('ECONNREFUSED');
      }),
      timeoutMs: 50,
    });
    expect(result.available).toBe(false);
    expect(result.baseUrl).toBe('http://nowhere.local');
  });

  it("accepts the daemon's { status: 'ok' } schema (live WrongProxy daemon)", async () => {
    globalThis.fetch = makeFetch(() =>
      jsonResponse({ repo: 'WrongStack', status: 'ok', socket_path: '\\\\.\\pipe\\wrongtrace' }),
    );
    const result = await discover({ baseUrl: 'http://localhost:3444' });
    expect(result.available).toBe(true);
    expect(result.socketPath).toBe('\\\\.\\pipe\\wrongtrace');
  });

  it('returns available:true with socket_path when /api/health replies ok', async () => {
    globalThis.fetch = makeFetch(() =>
      jsonResponse({ ok: true, version: '0.3.0', socket_path: '/tmp/wt.sock' }),
    );
    const result = await discover({ baseUrl: 'http://localhost:3444' });
    expect(result.available).toBe(true);
    expect(result.version).toBe('0.3.0');
    expect(result.socketPath).toBe('/tmp/wt.sock');
  });

  it('falls back to a platform-default socket_path when health omits one', async () => {
    globalThis.fetch = makeFetch(() => jsonResponse({ ok: true }));
    const result = await discover({ baseUrl: 'http://localhost:3444' });
    expect(result.available).toBe(true);
    expect(typeof result.socketPath).toBe('string');
    expect(result.socketPath!.length).toBeGreaterThan(0);
  });

  it('rejects non-2xx responses with available:false', async () => {
    globalThis.fetch = makeFetch(() => jsonResponse({ ok: false }, 503));
    const result = await discover({ baseUrl: 'http://localhost:3444' });
    expect(result.available).toBe(false);
  });

  it('aborts the probe within the configured timeout', async () => {
    let aborted = false;
    globalThis.fetch = makeFetch((_url, init) => {
      // Abort-aware stub: matches the contract of undici / Web fetch so the
      // adapter's `AbortSignal.timeout()` actually unblocks the await chain.
      return new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) {
          aborted = true;
          reject(new DOMException('The operation was aborted.', 'AbortError'));
          return;
        }
        init?.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      });
    });
    const t0 = Date.now();
    const result = await discover({ baseUrl: 'http://localhost:3444', timeoutMs: 100 });
    const elapsed = Date.now() - t0;
    expect(result.available).toBe(false);
    expect(aborted).toBe(true);
    expect(elapsed).toBeLessThan(500);
  });

  it('defaultSocketPath returns a non-empty string on this platform', () => {
    const p = defaultSocketPath();
    expect(typeof p).toBe('string');
    expect(p.length).toBeGreaterThan(0);
  });

  it.skipIf(process.platform !== 'win32')(
    'win32 default socket path matches the live daemon pipe (no .sock)',
    () => {
      const p = defaultSocketPath('C:\\Users\\someone');
      // The daemon's live pipe is \\.\pipe\wrongtrace (see adapters/ipc.ts);
      // the fallback must never append ".sock", or socket-less health
      // responses wire IPC to a pipe no daemon opens. Skipped on non-win32:
      // defaultSocketPath branches on platform(), and the posix branches are
      // asserted by the "non-empty string" test above.
      expect(p).toBe('\\\\.\\pipe\\wrongtrace');
      expect(p).not.toContain('.sock');
    },
  );
});
describe('createWrongTraceClient()', () => {
  let originalFetch: typeof fetch | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch as typeof fetch;
  });

  it('reports isAvailable:false when discovery fails — every method is a no-op', async () => {
    globalThis.fetch = makeFetch(() => {
      throw new Error('ECONNREFUSED');
    });
    const wt = await createWrongTraceClient({ baseUrl: 'http://nowhere.local', timeoutMs: 50 });
    expect(wt.isAvailable).toBe(false);

    expect(await wt.getHealth()).toBeNull();
    expect(await wt.getFileHealth('src/foo.ts')).toBeNull();
    expect(await wt.getSymbolLineage('src/foo.ts', 'foo()')).toEqual([]);
    expect(await wt.getFrictionMatrix()).toEqual([]);
    expect(await wt.getAtlas()).toBeNull();
    expect(await wt.lockFile('src/foo.ts', 'test')).toBeNull();
    expect(await wt.unlockFile('src/foo.ts')).toBeNull();
    expect(
      await wt.reportTelemetry({
        run_id: 'r',
        agent_name: 'a',
        model_name: 'm',
        provider: 'anthropic',
        prompt_tokens: 0,
        completion_tokens: 0,
        cost_usd: 0,
        intent: 'x',
      }),
    ).toBeNull();
  });

  it('lockFile POSTs to /api/guardrail/lock with path + reason when daemon is up', async () => {
    const seen: Array<{ url: string; method: string; body?: unknown }> = [];
    globalThis.fetch = makeFetch(async (url, init) => {
      const u = new URL(url);
      if (u.pathname === '/api/health') return jsonResponse({ ok: true });
      const parsed = init?.body ? JSON.parse(String(init.body)) : undefined;
      seen.push({ url, method: init?.method ?? 'GET', body: parsed });
      return jsonResponse({ ok: true, path: u.searchParams.get('path') ?? '' });
    });

    const wt = await createWrongTraceClient({ baseUrl: 'http://localhost:3444' });
    expect(wt.isAvailable).toBe(true);
    const res = await wt.lockFile('src/auth/middleware.ts', 'refactor in progress');
    expect(res?.ok).toBe(true);
    const lockCall = seen.find((c) => c.url.endsWith('/api/guardrail/lock'));
    expect(lockCall).toBeDefined();
    expect(lockCall?.method).toBe('POST');
    expect(lockCall?.body).toEqual({
      path: 'src/auth/middleware.ts',
      reason: 'refactor in progress',
    });
  });

  it("lockFile surfaces the daemon's 409-conflict body (owner/expires_at) instead of null", async () => {
    globalThis.fetch = makeFetch(async (url) => {
      const u = new URL(url);
      if (u.pathname === '/api/health') return jsonResponse({ ok: true });
      if (u.pathname === '/api/guardrail/lock') {
        // Daemon round-3 conflict shape: structured JSON on 409.
        return jsonResponse(
          {
            ok: false,
            status: 'conflict',
            error: 'file is already locked',
            message: 'file src/auth.ts is already locked by agent-x',
            path: 'src/auth.ts',
            owner: 'agent-x',
            owner_run_id: 'run-42',
            reason: 'active refactor',
            locked_at: '2026-08-24T18:40:00Z',
            expires_at: '2026-08-24T18:55:00Z',
          },
          409,
        );
      }
      return jsonResponse({ ok: true });
    });
    const wt = await createWrongTraceClient({ baseUrl: 'http://localhost:3444' });
    const res = await wt.lockFile('src/auth.ts', 'my edit');
    // The conflict body must survive — callers decide wait-vs-force from it.
    expect(res).not.toBeNull();
    expect(res?.ok).toBe(false);
    expect(res?.status).toBe('conflict');
    expect(res?.owner).toBe('agent-x');
    expect(res?.owner_run_id).toBe('run-42');
    expect(res?.expires_at).toBe('2026-08-24T18:55:00Z');
    expect(res?.message).toContain('already locked');
  });

  it('lockFile returns null for non-409 HTTP errors (only 409 bodies are surfaced)', async () => {
    globalThis.fetch = makeFetch(async (url) => {
      const u = new URL(url);
      if (u.pathname === '/api/health') return jsonResponse({ ok: true });
      return new Response('boom', { status: 503 });
    });
    const wt = await createWrongTraceClient({ baseUrl: 'http://localhost:3444' });
    expect(await wt.lockFile('src/auth.ts', 'my edit')).toBeNull();
  });

  it('lockFile stays HTTP-first when MCP lock_file is wired — the 409 conflict body wins', async () => {
    // Regression pin: lockFile deliberately routes HTTP BEFORE the MCP
    // lock_file tool (daemon's non-HTTP lock surface silently takes over
    // another owner's lock; live-probed — see client.ts header). A wired
    // MCP bag must never shadow the daemon's structured 409.
    let httpLockCalls = 0;
    let mcpLockCalls = 0;
    globalThis.fetch = makeFetch(async (url) => {
      const u = new URL(url);
      if (u.pathname === '/api/health') return jsonResponse({ ok: true, socket_path: '' });
      if (u.pathname === '/api/guardrail/lock') {
        httpLockCalls++;
        return jsonResponse(
          { ok: false, status: 'conflict', owner: 'agent-x', message: 'already locked by agent-x' },
          409,
        );
      }
      return jsonResponse({});
    });
    const wt = await createWrongTraceClient({
      baseUrl: 'http://localhost:3444',
      mcpTools: {
        lock_file: async () => {
          mcpLockCalls++;
          return { ok: true, status: 'locked' };
        },
      },
    });
    const res = await wt.lockFile('src/auth.ts', 'my edit');
    expect(httpLockCalls).toBe(1);
    expect(mcpLockCalls).toBe(0); // MCP must not be consulted while HTTP can answer
    expect(res?.ok).toBe(false);
    expect(res?.owner).toBe('agent-x');
  });

  it('lockFile fails closed when the HTTP 409 body is unreadable — MCP not consulted', async () => {
    // Regression pin: httpJson collapses timeout/5xx/unparseable-409 into
    // null (lossy). With an HTTP route present, that ambiguous null must
    // fail closed — consulting the conflict-unsafe MCP lock surface here
    // would turn a real conflict into a silent takeover.
    let mcpLockCalls = 0;
    globalThis.fetch = makeFetch(async (url) => {
      const u = new URL(url);
      if (u.pathname === '/api/health') return jsonResponse({ ok: true, socket_path: '' });
      return new Response('<html>gateway error</html>', { status: 409 });
    });
    const wt = await createWrongTraceClient({
      baseUrl: 'http://localhost:3444',
      mcpTools: {
        lock_file: async () => {
          mcpLockCalls++;
          return { ok: true, status: 'locked' };
        },
      },
    });
    expect(await wt.lockFile('src/auth.ts', 'my edit')).toBeNull();
    expect(mcpLockCalls).toBe(0);
  });

  it('lockFile fails closed on an ambiguous HTTP 503 — MCP not consulted', async () => {
    let mcpLockCalls = 0;
    globalThis.fetch = makeFetch(async (url) => {
      const u = new URL(url);
      if (u.pathname === '/api/health') return jsonResponse({ ok: true, socket_path: '' });
      return new Response('boom', { status: 503 });
    });
    const wt = await createWrongTraceClient({
      baseUrl: 'http://localhost:3444',
      mcpTools: {
        lock_file: async () => {
          mcpLockCalls++;
          return { ok: true, status: 'locked' };
        },
      },
    });
    expect(await wt.lockFile('src/auth.ts', 'my edit')).toBeNull();
    expect(mcpLockCalls).toBe(0);
  });

  it('lockFile falls back to MCP lock_file only when no HTTP route exists', async () => {
    // Discovery fails (ECONNREFUSED) → requireBaseUrl() null → the MCP
    // surface is the only remaining route; the fallback must still work.
    let mcpLockCalls = 0;
    globalThis.fetch = makeFetch(async () => {
      throw new Error('ECONNREFUSED');
    });
    const wt = await createWrongTraceClient({
      baseUrl: 'http://localhost:59999',
      mcpTools: {
        lock_file: async () => {
          mcpLockCalls++;
          return { ok: true, status: 'locked' };
        },
      },
    });
    const res = await wt.lockFile('src/auth.ts', 'my edit');
    expect(mcpLockCalls).toBe(1);
    expect(res?.ok).toBe(true);
  });

  it('routes getFileHealth through MCP when the tool is wired', async () => {
    let httpCalls = 0;
    globalThis.fetch = makeFetch(async (url) => {
      httpCalls++;
      const u = new URL(url);
      // socket_path: "" keeps IPC unwired so the MCP path is exercised
      // deterministically; a live daemon on the default pipe would otherwise
      // win the IPC-first routing and beat the stub.
      if (u.pathname === '/api/health') return jsonResponse({ ok: true, socket_path: '' });
      return jsonResponse({
        path: '',
        health_score: 0,
        is_fragile: false,
        recent_thrashing_count: 0,
        is_locked: false,
      });
    });
    const wt = await createWrongTraceClient({
      baseUrl: 'http://localhost:3444',
      mcpTools: {
        get_file_health_score: async (args) => ({
          path: args.path,
          health_score: 95,
          is_fragile: false,
          recent_thrashing_count: 0,
          is_locked: false,
        }),
      },
    });
    const health = await wt.getFileHealth('src/foo.ts');
    expect(health?.health_score).toBe(95);
    expect(httpCalls).toBe(1); // only /api/health hit HTTP
  });

  it('falls back to HTTP when MCP tool is wired but throws', async () => {
    globalThis.fetch = makeFetch(async (url) => {
      const u = new URL(url);
      // socket_path: "" keeps IPC unwired (see test above) so the HTTP
      // fallback path is exercised rather than a live daemon's IPC answer.
      if (u.pathname === '/api/health') return jsonResponse({ ok: true, socket_path: '' });
      if (u.pathname === '/api/file/health') {
        return jsonResponse({
          path: 'src/foo.ts',
          health_score: 30,
          is_fragile: true,
          recent_thrashing_count: 7,
          is_locked: false,
        });
      }
      return jsonResponse({});
    });
    const wt = await createWrongTraceClient({
      baseUrl: 'http://localhost:3444',
      mcpTools: {
        get_file_health_score: async () => {
          throw new Error('MCP down');
        },
      },
    });
    const health = await wt.getFileHealth('src/foo.ts');
    expect(health?.is_fragile).toBe(true);
    expect(health?.health_score).toBe(30);
  });

  it('getFrictionMatrix returns [] when the daemon replies with an error', async () => {
    globalThis.fetch = makeFetch(async (url) => {
      const u = new URL(url);
      if (u.pathname === '/api/health') return jsonResponse({ ok: true });
      return new Response('boom', { status: 500 });
    });
    const wt = await createWrongTraceClient({ baseUrl: 'http://localhost:3444' });
    expect(await wt.getFrictionMatrix()).toEqual([]);
  });

  it("unlockFile surfaces the daemon's 409-conflict body instead of null", async () => {
    globalThis.fetch = makeFetch(async (url) => {
      const u = new URL(url);
      if (u.pathname === '/api/health') return jsonResponse({ ok: true, socket_path: '' });
      if (u.pathname === '/api/guardrail/unlock') {
        return jsonResponse(
          {
            ok: false,
            status: 'conflict',
            error: 'lock held by another owner',
            path: 'src/auth.ts',
            owner: 'peer-agent',
          },
          409,
        );
      }
      return jsonResponse({ ok: true });
    });
    const wt = await createWrongTraceClient({ baseUrl: 'http://localhost:3444' });
    const res = await wt.unlockFile('src/auth.ts');
    expect(res).not.toBeNull();
    expect(res?.ok).toBe(false);
    expect(res?.status).toBe('conflict');
    expect(res?.owner).toBe('peer-agent');
  });

  it('getFrictionMatrix attaches total_collisions and events to returned rows', async () => {
    const rawEvents = [{ file_path: 'src/foo.ts', action: 'MODIFIED' }];
    globalThis.fetch = makeFetch(async (url) => {
      const u = new URL(url);
      if (u.pathname === '/api/health') return jsonResponse({ ok: true });
      if (u.pathname === '/api/metrics/friction') {
        return jsonResponse({
          edges: [{ author_model: 'm1', overwriter_model: 'm2', conflict_count: 3 }],
          total_collisions: 12,
          events: rawEvents,
        });
      }
      return jsonResponse({});
    });
    const wt = await createWrongTraceClient({ baseUrl: 'http://localhost:3444' });
    const rows = (await wt.getFrictionMatrix()) as any;
    expect(rows).toHaveLength(1);
    expect(rows.total_collisions).toBe(12);
    expect(rows.events).toEqual(rawEvents);
  });

  it('strips trailing slashes from baseUrl in discover() and resolves home socket path on non-win32 platforms', async () => {
    const requestedUrls: string[] = [];
    const res = await discover({
      baseUrl: 'http://localhost:3444///',
      fetchImpl: makeFetch(async (url) => {
        requestedUrls.push(url);
        return jsonResponse({ status: 'ok', version: '1.0.0' });
      }),
    });
    expect(res.available).toBe(true);
    expect(res.baseUrl).toBe('http://localhost:3444');
    expect(requestedUrls).toEqual(['http://localhost:3444/api/health']);

    expect(defaultSocketPath('/home/alice', 'linux')).toContain('.wrongtrace');
    expect(defaultSocketPath('', 'linux')).toBe('/tmp/wrongtrace.sock');
  });

  it('routes getFileHealth and getAtlas through wired MCP/IPC when HTTP discovery is offline (F755)', async () => {
    let mcpCalls = 0;
    const wt = await createWrongTraceClient({
      baseUrl: 'http://127.0.0.1:59999',
      socketPath: '',
      fetchImpl: makeFetch(async () => {
        throw new Error('ECONNREFUSED');
      }),
      mcpTools: {
        get_file_health_score: async (args) => {
          mcpCalls += 1;
          return {
            path: args.path,
            health_score: 91,
            is_fragile: false,
            recent_thrashing_count: 0,
            is_locked: false,
          };
        },
      },
    });
    const health = await wt.getFileHealth('src/index.ts');
    expect(health?.health_score).toBe(91);
    expect(mcpCalls).toBe(1);
    const atlas = await wt.getAtlas({ workspace: 'repo', summary: true });
    expect(atlas).toBeNull();
  });

  it('clamps _httpJson timeoutMs above 2_147_483_647 ms so it does not abort in 1ms', async () => {
    const { _httpJson } = await import('../client.js');
    globalThis.fetch = makeFetch(async (_url, init) => {
      await new Promise((r) => setTimeout(r, 25));
      if (init?.signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      return jsonResponse({ ok: true });
    });
    const res = await _httpJson<{ ok: boolean }>('http://localhost:3444', '/api/health', {
      timeoutMs: 3_000_000_000,
    });
    expect(res).toEqual({ ok: true });
  });
});
