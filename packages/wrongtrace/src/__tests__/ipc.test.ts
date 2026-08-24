import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createIpcTransport } from '../adapters/ipc.js';
import { createWrongTraceClient } from '../client.js';
import type { WrongTraceHealth } from '../types.js';

/**
 * In-process JSON-RPC 2.0 socket daemon for transport tests.
 * Mirrors the live daemon's contract (verified 2026-08-24):
 * newline-delimited frames, error envelopes for unknown methods.
 */

interface TrackedServer {
  path: string;
  close(): Promise<void>;
}

const openServers: Array<Promise<void>> = [];

function startRpcServer(
  handler: (
    method: string,
    params: Record<string, unknown>,
    id: number | null,
  ) => string | string[],
): TrackedServer {
  const path =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\wrongtrace-ipc-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      : join(tmpdir(), `wrongtrace-ipc-test-${process.pid}-${Date.now()}.sock`);

  const server = net.createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let newlineAt = buffer.indexOf('\n');
      while (newlineAt !== -1) {
        const line = buffer.slice(0, newlineAt).trim();
        buffer = buffer.slice(newlineAt + 1);
        newlineAt = buffer.indexOf('\n');
        if (line.length === 0) continue;
        let request: { id?: number | null; method?: string; params?: Record<string, unknown> };
        try {
          request = JSON.parse(line);
        } catch {
          continue;
        }
        const frames = handler(request.method ?? '', request.params ?? {}, request.id ?? null);
        for (const frame of Array.isArray(frames) ? frames : [frames]) {
          socket.write(`${frame}\n`);
        }
      }
    });
  });

  const listenPromise = new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => resolve());
  });
  openServers.push(listenPromise.then(() => undefined));

  return {
    path,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        (server as net.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
      }),
  };
}

/** `makeFetch` twin of client.test.ts, scoped to what these tests need. */
function healthFetch(socketPath: string, responder?: (url: string) => unknown): typeof fetch {
  return (async (url: Parameters<typeof fetch>[0]) => {
    const target = String(url);
    if (target.endsWith('/api/health')) {
      const body = { ok: true, status: 'ok', socket_path: socketPath } satisfies WrongTraceHealth;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const custom = responder?.(target);
    if (custom !== undefined) {
      return new Response(JSON.stringify(custom), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('boom', { status: 503 });
  }) as typeof fetch;
}

describe('createIpcTransport (JSON-RPC 2.0, \\n-framed)', () => {
  const servers: TrackedServer[] = [];

  afterEach(async () => {
    while (servers.length > 0) {
      const server = servers.pop();
      if (server) await server.close();
    }
  });

  afterAll(async () => {
    await Promise.allSettled(openServers);
  });

  it('isWired=false resolves { result: null } without touching the network', async () => {
    const ipc = createIpcTransport(undefined);
    expect(ipc.isWired).toBe(false);
    await expect(ipc.call('telemetry/file_health', {})).resolves.toEqual({ result: null });
  });

  it('round-trips a JSON-RPC result envelope', async () => {
    const server = startRpcServer((method, params, id) =>
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        result: { method, file_path: params.file_path, health_score: 100 },
      }),
    );
    servers.push(server);
    const ipc = createIpcTransport(server.path);
    const res = await ipc.call<{ health_score: number }>('telemetry/file_health', {
      file_path: 'a.ts',
    });
    expect(res.result).toMatchObject({
      method: 'telemetry/file_health',
      file_path: 'a.ts',
      health_score: 100,
    });
    expect(res.error).toBeUndefined();
  });

  it('surfaces daemon error envelopes as { result: null, error } — never as a fake result', async () => {
    const server = startRpcServer((method) =>
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32601, message: `method not found: ${method}` },
      }),
    );
    servers.push(server);
    const ipc = createIpcTransport(server.path);
    const res = await ipc.call('guardrail/lock', { path: 'x' });
    expect(res.result).toBeNull();
    expect(res.error).toEqual({ code: -32601, message: 'method not found: guardrail/lock' });
  });

  it('tolerates junk and split frames before the real response line', async () => {
    const server = startRpcServer((_method, _params, id) => [
      'not json at all',
      `{"partial":`,
      JSON.stringify({ jsonrpc: '2.0', id, result: { ok: true } }),
    ]);
    servers.push(server);
    const ipc = createIpcTransport(server.path);
    const res = await ipc.call<{ ok: boolean }>('telemetry/report_run', { run_id: 'r' });
    expect(res.result).toEqual({ ok: true });
  });

  it('ignores frames carrying a different id and waits for its own', async () => {
    const server = startRpcServer((_method, _params, id) => [
      JSON.stringify({ jsonrpc: '2.0', id: 999, result: { wrong: true } }),
      JSON.stringify({ jsonrpc: '2.0', id, result: { right: true } }),
    ]);
    servers.push(server);
    const ipc = createIpcTransport(server.path);
    const res = await ipc.call<{ right: boolean }>('telemetry/file_health', {});
    expect(res.result).toEqual({ right: true });
  });

  it('resolves { result: null } when the socket disappears without answering (read timeout honored)', async () => {
    // Server that accepts the connection and never writes back.
    const silent = net.createServer(() => {
      /* swallow */
    });
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', () => resolve()));
    const silentPath = `${(silent.address() as net.AddressInfo).address}:${(silent.address() as net.AddressInfo).port}`;
    // Note: a host:port string is a valid net.connect target — reused here
    // purely to exercise the never-answers path without a named-pipe slot.
    const ipc = createIpcTransport(silentPath, { readTimeoutMs: 150, connectTimeoutMs: 300 });
    const t0 = Date.now();
    const res = await ipc.call('telemetry/file_health', {});
    expect(res.result).toBeNull();
    expect(Date.now() - t0).toBeLessThan(2_000);
    await new Promise<void>((resolve) => silent.close(() => resolve()));
  });

  it('resolves { result: null } when the socket path is dead', async () => {
    const deadPath =
      process.platform === 'win32'
        ? '\\\\.\\pipe\\wrongtrace-ipc-test-definitely-not-listening'
        : join(tmpdir(), `wrongtrace-ipc-test-dead-${Date.now()}.sock`);
    const ipc = createIpcTransport(deadPath, { connectTimeoutMs: 250 });
    const res = await ipc.call('telemetry/file_health', {});
    expect(res.result).toBeNull();
  });
});

describe('createWrongTraceClient() IPC-first routing', () => {
  const servers: TrackedServer[] = [];
  let originalFetch: typeof fetch | undefined;

  beforeAll(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch as typeof fetch;
    while (servers.length > 0) {
      const server = servers.pop();
      if (server) await server.close();
    }
  });

  it('getFileHealth prefers the daemon pipe and skips HTTP', async () => {
    const server = startRpcServer((_method, params, id) =>
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        result: {
          file_path: params.file_path,
          health_score: 35,
          is_fragile: true,
          recent_thrashing_count: 4,
          is_locked: false,
        },
      }),
    );
    servers.push(server);

    let httpCalls = 0;
    globalThis.fetch = healthFetch(server.path, () => {
      httpCalls++;
      return {};
    });

    const wt = await createWrongTraceClient({ baseUrl: 'http://localhost:3444' });
    const health = await wt.getFileHealth('internal/server/server.go');
    expect(health).toMatchObject({
      file_path: 'internal/server/server.go',
      health_score: 35,
      is_fragile: true,
    });
    // Only the discovery probe hit HTTP; the health call rode the pipe.
    expect(httpCalls).toBe(0);
  });

  it('getFileHealth falls back to HTTP when the pipe answers with an error envelope', async () => {
    const server = startRpcServer((method) =>
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32601, message: `method not found: ${method}` },
      }),
    );
    servers.push(server);

    globalThis.fetch = healthFetch(server.path, (url) => {
      if (url.includes('/api/file/health')) {
        return {
          file_path: 'x.ts',
          health_score: 80,
          is_fragile: false,
          recent_thrashing_count: 0,
          is_locked: false,
        };
      }
      return undefined;
    });

    const wt = await createWrongTraceClient({ baseUrl: 'http://localhost:3444' });
    const health = await wt.getFileHealth('x.ts');
    expect(health).toMatchObject({ health_score: 80 });
  });

  it("reportTelemetry rides the pipe and normalizes {status:'ok'} → {ok:true}", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const server = startRpcServer((_method, params, id) => {
      seen.push(params);
      return JSON.stringify({ jsonrpc: '2.0', id, result: { status: 'ok' } });
    });
    servers.push(server);

    let httpCalls = 0;
    globalThis.fetch = healthFetch(server.path, () => {
      httpCalls++;
      return {};
    });

    const wt = await createWrongTraceClient({ baseUrl: 'http://localhost:3444' });
    const res = await wt.reportTelemetry({
      run_id: 'run-ws-903',
      task_id: 'task-auth-fix',
      agent_name: 'WrongStack-Coder',
      model_name: 'claude-3-7-sonnet',
      provider: 'anthropic',
      prompt_tokens: 8420,
      completion_tokens: 1250,
      cost_usd: 0.0435,
      intent: 'Refactor JWT middleware',
    });
    expect(res).toEqual({ ok: true });
    expect(httpCalls).toBe(0);
    expect(seen[0]).toMatchObject({ run_id: 'run-ws-903', agent_name: 'WrongStack-Coder' });
  });

  it('getAtlas rides the pipe when wired (daemon v0.3.3) and forwards query params', async () => {
    const seen: Array<{ method: string; params: Record<string, unknown> }> = [];
    const server = startRpcServer((method, params, id) => {
      seen.push({ method, params });
      return JSON.stringify({
        jsonrpc: '2.0',
        id,
        result: { repo: 'WrongStack', packages: [{ path: 'packages/x', name: 'x' }] },
      });
    });
    servers.push(server);

    let atlasOverHttp = false;
    globalThis.fetch = healthFetch(server.path, (url) => {
      if (url.includes('/api/atlas')) {
        atlasOverHttp = true;
        return { poisoned: 'must not be consumed' };
      }
      return undefined;
    });

    const wt = await createWrongTraceClient({ baseUrl: 'http://localhost:3444' });
    const atlas = await wt.getAtlas({ summary: true, limit: 5 });
    expect(atlas?.packages).toHaveLength(1);
    expect(atlas?.packages[0]?.name).toBe('x');
    expect(atlasOverHttp).toBe(false);
    expect(seen[0]?.method).toBe('get_atlas');
    expect(seen[0]?.params).toMatchObject({ summary: true, limit: 5 });
  });

  it('getAtlas falls back to HTTP when the pipe answers -32601 (pre-v0.3.3 daemon)', async () => {
    const server = startRpcServer((method) =>
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32601, message: `method not found: ${method}` },
      }),
    );
    servers.push(server);

    globalThis.fetch = healthFetch(server.path, (url) => {
      if (url.includes('/api/atlas')) {
        return { packages: [{ path: 'packages/http', name: 'http' }] };
      }
      return undefined;
    });

    const wt = await createWrongTraceClient({ baseUrl: 'http://localhost:3444' });
    const atlas = await wt.getAtlas({ summary: true });
    expect(atlas?.packages[0]?.name).toBe('http');
  });

  it('unlockFile rides the pipe and normalizes {file_path,status} → {ok,path,status}', async () => {
    const server = startRpcServer((_method, params, id) =>
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        result: { file_path: params.path, status: 'unlocked' },
      }),
    );
    servers.push(server);

    let httpCalls = 0;
    globalThis.fetch = healthFetch(server.path, () => {
      httpCalls++;
      return {};
    });

    const wt = await createWrongTraceClient({ baseUrl: 'http://localhost:3444' });
    const res = await wt.unlockFile('src/auth.ts');
    expect(res).toEqual({ ok: true, path: 'src/auth.ts', status: 'unlocked' });
    expect(httpCalls).toBe(0);
  });

  it('unlockFile falls back to HTTP when the pipe answers with an error envelope', async () => {
    const server = startRpcServer((method) =>
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32601, message: `method not found: ${method}` },
      }),
    );
    servers.push(server);

    globalThis.fetch = healthFetch(server.path, (url) => {
      if (url.includes('/api/guardrail/unlock')) {
        return { ok: true, path: 'src/auth.ts', status: 'unlocked' };
      }
      return undefined;
    });

    const wt = await createWrongTraceClient({ baseUrl: 'http://localhost:3444' });
    const res = await wt.unlockFile('src/auth.ts');
    expect(res).toMatchObject({ ok: true, status: 'unlocked' });
  });

  it('lockFile stays HTTP-first even when the pipe is wired (IPC lock ignores conflicts — live probe 2026-08-24)', async () => {
    const server = startRpcServer((_method, _params, id) =>
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        result: { poisoned: 'lock must never ride a conflict-agnostic pipe' },
      }),
    );
    servers.push(server);

    let lockOverHttp = false;
    globalThis.fetch = healthFetch(server.path, (url) => {
      if (url.includes('/api/guardrail/lock')) {
        lockOverHttp = true;
        return { ok: true, path: 'src/auth.ts', status: 'locked' };
      }
      return undefined;
    });

    const wt = await createWrongTraceClient({ baseUrl: 'http://localhost:3444' });
    const res = await wt.lockFile('src/auth.ts', 'test');
    expect(res).toMatchObject({ ok: true, status: 'locked' });
    expect(lockOverHttp).toBe(true);
  });
});
