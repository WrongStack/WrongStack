/**
 * Focused coverage for ACPSession branches not exercised by the main
 * suite: authenticate against an unadvertised method, abort with a
 * failing transport, MCP server capability filtering, sendRequest
 * timeout/send-failure, terminal fire-and-forget teardown, and
 * best-effort ack send failures.
 */

import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACPSession, textContent } from '../src/client/acp-session.js';
import type { ACPMessage } from '../src/types/acp-messages.js';

const hoisted = vi.hoisted(() => ({ instances: [] as FakeTransport[] }));

interface FakeTransport {
  sent: ACPMessage[];
  handlers: Array<(m: ACPMessage) => void>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  onMessage: (h: (m: ACPMessage) => void) => () => void;
  emit: (m: ACPMessage) => void;
  respond: (id: number | string, method: string, result: unknown) => void;
  respondError: (
    id: number | string,
    method: string,
    error: { code: number; message: string },
  ) => void;
}

vi.mock('../src/agent/stdio-transport.js', () => {
  class ClientTransport {
    sent: ACPMessage[] = [];
    handlers: Array<(m: ACPMessage) => void> = [];
    start = vi.fn(async () => {});
    stop = vi.fn();
    send = vi.fn(async (m: ACPMessage) => {
      this.sent.push(m);
    });
    constructor() {
      hoisted.instances.push(this as never as FakeTransport);
    }
    onMessage(h: (m: ACPMessage) => void): () => void {
      this.handlers.push(h);
      return () => {};
    }
    emit(m: ACPMessage): void {
      for (const h of [...this.handlers]) h(m);
    }
    respond(id: number | string, method: string, result: unknown): void {
      this.emit({ jsonrpc: '2.0', id, method, result } as never as ACPMessage);
    }
    respondError(
      id: number | string,
      method: string,
      error: { code: number; message: string },
    ): void {
      this.emit({ jsonrpc: '2.0', id, method, error } as never as ACPMessage);
    }
  }
  return { ClientTransport, StdioTransport: class {} };
});

const PROJECT_ROOT = path.resolve(os.tmpdir(), 'wstack-acp-extra-' + process.pid);

function lastTransport(): FakeTransport {
  const t = hoisted.instances[hoisted.instances.length - 1];
  if (!t) throw new Error('no transport was constructed');
  return t;
}

beforeEach(async () => {
  hoisted.instances.length = 0;
  await fsp.mkdir(PROJECT_ROOT, { recursive: true });
});

afterEach(async () => {
  hoisted.instances.length = 0;
  for (let i = 0; i < 3; i++) {
    try {
      await fsp.rm(PROJECT_ROOT, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'EBUSY' && code !== 'ENOTEMPTY') throw err;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
});

async function startSession(
  initResult: Record<string, unknown> = {
    protocolVersion: 1,
    agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },
    agentInfo: { name: 'fake-agent', title: 'Fake', version: '0.0.1' },
  },
  overrides: Partial<Parameters<typeof ACPSession.start>[0]> = {},
): Promise<ACPSession> {
  const p = ACPSession.start({ command: 'fake', projectRoot: PROJECT_ROOT, ...overrides });
  const t = lastTransport();
  await new Promise((r) => setImmediate(r));
  const init = t.sent.find((m) => m.method === 'initialize');
  expect(init).toBeDefined();
  t.respond(init!.id!, 'initialize', initResult);
  return p;
}

describe('ACPSession — focused coverage', () => {
  it('authenticate rejects an unadvertised method (auth_failed message lists methods)', async () => {
    // No auth methods are advertised, so any authenticate call must fail
    // with the advertised-list message (acp-session.ts:332-336).
    const session = await startSession();
    await expect(session.authenticate('token')).rejects.toMatchObject({
      kind: 'auth_failed',
      message: expect.stringContaining('not in advertised methods'),
    });
    await session.close();
  });

  it('abort swallows a failing session/cancel send (transport torn down)', async () => {
    const session = await startSession();
    const t = lastTransport();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const ac = new AbortController();
      const promptP = session.prompt([textContent('x')], ac.signal);
      // Drain session/new response first.
      await new Promise((r) => setImmediate(r));
      const newMsg = t.sent.find((m) => m.method === 'session/new');
      expect(newMsg).toBeDefined();
      t.respond(newMsg!.id!, 'session/new', { sessionId: 'sess_abc' });
      await new Promise((r) => setImmediate(r));
      const promptMsg = t.sent.find((m) => m.method === 'session/prompt');
      expect(promptMsg).toBeDefined();

      // From this point the transport rejects every send — simulating
      // teardown. The abort path's session/cancel send failure is swallowed
      // (acp-session.ts:707) and must not become an unhandled rejection.
      t.send.mockRejectedValue(new Error('transport down'));
      ac.abort();
      await new Promise((r) => setImmediate(r));
      // The cancel was attempted (mockRejectedValue replaces send, so it
      // never lands in t.sent — but the invocation is recorded).
      expect(
        t.send.mock.calls.some(
          ([message]) => (message as { method?: string }).method === 'session/cancel',
        ),
      ).toBe(true);

      // The agent settles the prompt with stopReason=cancelled — respond
      // uses emit, so it works even though send() now rejects.
      t.respond(promptMsg!.id!, 'session/prompt', { stopReason: 'cancelled' });
      const result = await promptP;
      expect(result.stopReason).toBe('cancelled');
      await new Promise((r) => setImmediate(r));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.removeListener('unhandledRejection', unhandled);
      await session.close();
    }
  });

  it('filters MCP servers by agent capability (http/sse gating)', async () => {
    const session = await startSession();
    const t = lastTransport();
    // Stdio servers survive; http/sse servers are dropped without
    // mcpCapabilities.http/sse (acp-session.ts:844-847).
    const mcpServers = [
      { name: 'stdio', command: 'node', args: [] },
      { type: 'http', name: 'http-server', url: 'http://localhost:9000' },
      { type: 'sse', name: 'sse-server', url: 'http://localhost:9001/sse' },
    ] as never as Parameters<typeof session.loadSession>[1];
    // `SessionId` is a branded string, so a literal needs the cast. Same
    // shape as the `mcpServers` cast above — derive it from the parameter
    // type rather than importing the brand.
    const sessionId = 's_1' as Parameters<typeof session.loadSession>[0];
    const loadP = session.loadSession(sessionId, mcpServers);
    await new Promise((r) => setImmediate(r));
    const load = t.sent.find((m) => m.method === 'session/load');
    expect(load).toBeDefined();
    const params = load!.params as { mcpServers: Array<{ name: string }> };
    // Only the stdio server passed the capability filter.
    expect(params.mcpServers.map((s) => s.name)).toEqual(['stdio']);
    t.respond(load!.id!, 'session/load', { sessionId: 's_1' });
    await loadP;
    await session.close();
  });

  it('sendRequest rejects on timeout when the agent never answers', async () => {
    const session = await startSession(undefined, { timeoutMs: 40 });
    const t = lastTransport();
    const promptP = session.prompt([textContent('x')], new AbortController().signal);
    await new Promise((r) => setImmediate(r));
    const newMsg = t.sent.find((m) => m.method === 'session/new');
    expect(newMsg).toBeDefined();
    t.respond(newMsg!.id!, 'session/new', { sessionId: 'sess_abc' });
    await new Promise((r) => setImmediate(r));
    const promptMsg = t.sent.find((m) => m.method === 'session/prompt');
    expect(promptMsg).toBeDefined();
    // Never respond — the timeout must fire (acp-session.ts:867-875); the
    // prompt wrapper surfaces it as prompt_failed with the timeout detail.
    await expect(promptP).rejects.toMatchObject({
      kind: 'prompt_failed',
      message: expect.stringContaining('timed out'),
    });
    await session.close();
  });

  it('sendRequest rejects when the transport send fails', async () => {
    const session = await startSession();
    const t = lastTransport();
    t.send.mockRejectedValue(new Error('pipe closed'));
    await expect(
      session.prompt([textContent('x')], new AbortController().signal),
    ).rejects.toMatchObject({
      kind: 'protocol_error',
      message: expect.stringContaining('send '),
    });
    await session.close();
  });

  it('terminal request handler failures are swallowed (fire-and-forget)', async () => {
    const session = await startSession();
    const t = lastTransport();
    // A terminal/output for a terminal that was never created makes the
    // handler reject; its fire-and-forget catch (acp-session.ts:994) must
    // swallow the failure — no unhandled rejection.
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      t.emit({
        jsonrpc: '2.0',
        id: 'term-1',
        method: 'terminal/output',
        params: { sessionId: 'sess_abc', terminalId: 'missing-term' },
      } as never as ACPMessage);
      await new Promise((r) => setImmediate(r));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
    await session.close();
  });

  it('best-effort ack send failures are swallowed', async () => {
    const session = await startSession();
    const t = lastTransport();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      t.send.mockRejectedValue(new Error('transport down'));
      // mcp/connect is a best-effort ack method; the failing sendResult
      // must be swallowed (acp-session.ts:1003).
      t.emit({
        jsonrpc: '2.0',
        id: 'ack-1',
        method: 'mcp/connect',
        params: {},
      } as never as ACPMessage);
      await new Promise((r) => setImmediate(r));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
    await session.close();
  });

  it('starts session with all constructor options and static connect', async () => {
    const session = await startSession(undefined, {
      fsTimeoutMs: 5000,
      terminalTimeoutMs: 10_000,
      terminalOutputByteLimit: 65536,
      terminalMaxCount: 5,
      env: { CUSTOM_VAR: '1' },
      cwd: PROJECT_ROOT,
    });
    expect(session).toBeDefined();
    await session.close();

    let handler: ((m: ACPMessage) => void) | undefined;
    const customTransport = {
      start: vi.fn(async () => {}),
      stop: vi.fn(),
      send: vi.fn(async (m: ACPMessage) => {
        if (m.method === 'initialize') {
          setTimeout(() => {
            handler?.({
              jsonrpc: '2.0',
              id: m.id,
              result: { protocolVersion: 1, agentInfo: { name: 'agent', version: '1.0' } },
            } as never as ACPMessage);
          }, 5);
        }
      }),
      onMessage: (h: (m: ACPMessage) => void) => {
        handler = h;
        return () => {};
      },
    };
    const connectedSession = await ACPSession.connect(customTransport as never, {
      command: 'test',
      projectRoot: PROJECT_ROOT,
    });
    expect(connectedSession).toBeDefined();
    await connectedSession.close();
  });

  it('start() handles transport start failure', async () => {
    const customTransport = {
      start: vi.fn().mockRejectedValue(new Error('cannot execute binary')),
      stop: vi.fn(),
      send: vi.fn(),
      onMessage: vi.fn(() => () => {}),
    };
    await expect(
      ACPSession.connect(customTransport as never, {
        command: 'fake-bin',
        projectRoot: PROJECT_ROOT,
      }),
    ).rejects.toMatchObject({
      kind: 'spawn_failed',
      message: expect.stringContaining('cannot execute binary'),
    });
    expect(customTransport.start).toHaveBeenCalled();
  });

  it('covers remaining branches in session ops (list, delete, fork, providers)', async () => {
    const session = await startSession({
      protocolVersion: 1,
      agentCapabilities: {
        mcp: true,
        sessionCapabilities: {
          list: {},
          delete: {},
          fork: {},
        },
      },
    });
    const t = lastTransport();

    // 1. session/list returning empty object (r.sessions ?? [])
    const listP = session.listSessions();
    await new Promise((r) => setImmediate(r));
    const listReq = t.sent.find((m) => m.method === 'session/list');
    t.respond(listReq!.id!, 'session/list', {});
    const listRes = await listP;
    expect(listRes.sessions).toEqual([]);
    expect(listRes.nextCursor).toBeUndefined();

    // 2. session/delete when deleting non-current sessionId (ctx.sessionId !== sessionId)
    const delP = session.deleteSession('other_id' as never);
    await new Promise((r) => setImmediate(r));
    const delReq = t.sent.find((m) => m.method === 'session/delete');
    t.respond(delReq!.id!, 'session/delete', {});
    await delP;

    // 3. session/fork with mcpServers so servers.length > 0
    const forkP = session.forkSession('s1' as never, undefined, [
      { name: 'mcp-srv', command: 'cmd' },
    ]);
    await new Promise((r) => setImmediate(r));
    const forkReq = t.sent.find((m) => m.method === 'session/fork');
    expect((forkReq?.params as any)?.mcpServers).toHaveLength(1);
    t.respond(forkReq!.id!, 'session/fork', { sessionId: 'forked_id' });
    const forked = await forkP;
    expect(forked).toBe('forked_id');

    // 4. providers/list returning empty object (r.providers ?? [], r.currentProviderId ?? null)
    const provP = session.listProviders();
    await new Promise((r) => setImmediate(r));
    const provReq = t.sent.find((m) => m.method === 'providers/list');
    t.respond(provReq!.id!, 'providers/list', {});
    const provRes = await provP;
    expect(provRes.providers).toEqual([]);
    expect(provRes.currentProviderId).toBeNull();

    await session.close();
  });

  it('starts session with trustBoundary options', async () => {
    const boundary = {
      evaluate: vi.fn(async () => ({ action: 'allow' as const, reason: 'trusted' })),
    };
    const session = await startSession(undefined, {
      trustBoundary: boundary as never,
      trustActor: { id: 'actor-1' } as never,
      trustAuthContext: { token: 'tok' } as never,
    });
    expect(session).toBeDefined();
    await session.close();
  });

  it('prompt rejects when session is closed', async () => {
    const session = await startSession();
    await session.close();
    await expect(
      session.prompt([textContent('hello')], new AbortController().signal),
    ).rejects.toMatchObject({ kind: 'closed' });
  });

  it('throws ACPSessionError(aborted) when prompt rejects after abort', async () => {
    const session = await startSession();
    const t = lastTransport();
    const ac = new AbortController();
    const promptP = session.prompt([textContent('hello')], ac.signal);

    await new Promise((r) => setImmediate(r));
    const newMsg = t.sent.find((m) => m.method === 'session/new');
    t.respond(newMsg!.id!, 'session/new', { sessionId: 'sess_abc' });
    await new Promise((r) => setImmediate(r));
    const promptMsg = t.sent.find((m) => m.method === 'session/prompt');

    ac.abort();
    await new Promise((r) => setImmediate(r));
    t.respondError(promptMsg!.id!, 'session/prompt', { code: -32603, message: 'killed' });

    await expect(promptP).rejects.toMatchObject({
      kind: 'aborted',
      message: 'prompt was aborted by the parent',
    });
    await session.close();
  });

  it('throws ACPSessionError(prompt_failed) when response is a JSON-RPC error', async () => {
    const session = await startSession();
    const t = lastTransport();
    const promptP = session.prompt([textContent('hello')], new AbortController().signal);

    await new Promise((r) => setImmediate(r));
    const newMsg = t.sent.find((m) => m.method === 'session/new');
    t.respond(newMsg!.id!, 'session/new', { sessionId: 'sess_abc' });
    await new Promise((r) => setImmediate(r));
    const promptMsg = t.sent.find((m) => m.method === 'session/prompt');

    t.respond(promptMsg!.id!, 'session/prompt', {
      code: -32000,
      message: 'internal model failure',
    });

    await expect(promptP).rejects.toMatchObject({
      kind: 'prompt_failed',
      message: expect.stringContaining('internal model failure'),
    });
    await session.close();
  });

  it('authenticate rejects if not in ready state or if agent returns error', async () => {
    const session = await startSession({
      protocolVersion: 1,
      authMethods: [{ id: 'token', name: 'Token' }],
    });
    const t = lastTransport();

    // 1. Already-authenticated is a no-op (retry after auth_required).
    (session as any).state = 'authenticated';
    await expect(session.authenticate('token')).resolves.toBeUndefined();

    // Reset state to ready
    (session as any).state = 'ready';

    // 2. Agent returns JSON-RPC error
    const authP = session.authenticate('token');
    await new Promise((r) => setImmediate(r));
    const authMsg = t.sent.find((m) => m.method === 'authenticate');
    t.respond(authMsg!.id!, 'authenticate', { code: -32000, message: 'invalid token' });
    await expect(authP).rejects.toMatchObject({
      kind: 'auth_failed',
      message: expect.stringContaining('invalid token'),
    });

    await session.close();
  });

  it('logout throws logout_failed when agent returns error', async () => {
    const session = await startSession({
      protocolVersion: 1,
      agentCapabilities: { auth: { logout: true } },
    });
    const t = lastTransport();

    const logoutP = session.logout();
    await new Promise((r) => setImmediate(r));
    const logoutMsg = t.sent.find((m) => m.method === 'logout');
    t.respond(logoutMsg!.id!, 'logout', { code: -32000, message: 'logout refused' });
    await expect(logoutP).rejects.toMatchObject({
      kind: 'logout_failed',
      message: expect.stringContaining('logout refused'),
    });

    await session.close();
  });

  it('prompt rejects when already prompting or in invalid state', async () => {
    const session = await startSession();
    (session as any).state = 'prompting';
    await expect(
      session.prompt([textContent('hello')], new AbortController().signal),
    ).rejects.toMatchObject({
      kind: 'protocol_error',
      message: expect.stringContaining('prompt called in state=prompting'),
    });
    await session.close();
  });

  it('initialize handles jsonrpc error response and missing protocolVersion', async () => {
    // 1. Initialize returns a JsonRpcError
    const p1 = ACPSession.start({ command: 'fake', projectRoot: PROJECT_ROOT });
    const t1 = lastTransport();
    await new Promise((r) => setImmediate(r));
    const init1 = t1.sent.find((m) => m.method === 'initialize');
    t1.respond(init1!.id!, 'initialize', { code: -32600, message: 'init rejected' });
    await expect(p1).rejects.toMatchObject({
      kind: 'init_failed',
      message: expect.stringContaining('init rejected'),
    });

    // 2. Initialize returns an object with no protocolVersion
    const p2 = ACPSession.start({ command: 'fake', projectRoot: PROJECT_ROOT });
    const t2 = lastTransport();
    await new Promise((r) => setImmediate(r));
    const init2 = t2.sent.find((m) => m.method === 'initialize');
    t2.respond(init2!.id!, 'initialize', {});
    await expect(p2).rejects.toMatchObject({
      kind: 'protocol_error',
      message: expect.stringContaining('initialize returned no protocolVersion'),
    });
  });

  it('authenticate formats advertised methods when method is unadvertised', async () => {
    const session = await startSession({
      protocolVersion: 1,
      authMethods: [
        { id: 'oauth', name: 'OAuth' },
        { id: 'token', name: 'Token' },
      ],
    });
    await expect(session.authenticate('unknown_auth')).rejects.toMatchObject({
      kind: 'auth_failed',
      message: expect.stringContaining('oauth, token'),
    });
    await session.close();
  });

  it('handles non-Error spawn rejection and non-Error transport send rejection', async () => {
    // 1. Non-Error spawn failure
    const transportFail = {
      start: vi.fn().mockRejectedValue('raw string spawn failure'),
      stop: vi.fn(),
      send: vi.fn(),
      onMessage: vi.fn(() => () => {}),
    };
    await expect(
      ACPSession.connect(transportFail as never, { command: 'test', projectRoot: PROJECT_ROOT }),
    ).rejects.toMatchObject({
      kind: 'spawn_failed',
      message: expect.stringContaining('raw string spawn failure'),
    });

    // 2. Non-Error transport send failure
    const session = await startSession();
    const t = lastTransport();
    t.send.mockRejectedValue('raw string send failure');
    await expect(
      session.prompt([textContent('test')], new AbortController().signal),
    ).rejects.toMatchObject({
      kind: 'protocol_error',
      message: expect.stringContaining('raw string send failure'),
    });
    await session.close();
  });

  it('handleMessage ignores responses with unknown id and handles error without message', async () => {
    const session = await startSession();
    const t = lastTransport();

    // 1. Response for unknown pending id
    t.emit({ jsonrpc: '2.0', id: 99999, result: { ok: true } } as never as ACPMessage);

    // 2. Response with error object having no message string
    const promptP = session.prompt([textContent('test')], new AbortController().signal);
    await new Promise((r) => setImmediate(r));
    const newMsg = t.sent.find((m) => m.method === 'session/new');
    t.emit({
      jsonrpc: '2.0',
      id: newMsg!.id,
      error: { code: -32603 },
    } as never as ACPMessage);

    await expect(promptP).rejects.toThrow('unknown JSON-RPC error');
    await session.close();
  });

  it('prompt maps non-Error rejection to prompt_failed', async () => {
    const session = await startSession();
    const t = lastTransport();
    const promptP = session.prompt([textContent('test')], new AbortController().signal);
    await new Promise((r) => setImmediate(r));
    const newMsg = t.sent.find((m) => m.method === 'session/new');
    t.respond(newMsg!.id!, 'session/new', { sessionId: 'sess_abc' });
    await new Promise((r) => setImmediate(r));
    const promptMsg = t.sent.find((m) => m.method === 'session/prompt');
    (session as any).pending.get(promptMsg!.id).reject('raw prompt string error');
    await expect(promptP).rejects.toMatchObject({
      kind: 'prompt_failed',
      message: expect.stringContaining('raw prompt string error'),
    });
    await session.close();
  });

  it('prompt defaults stopReason to end_turn when missing in response', async () => {
    const session = await startSession();
    const t = lastTransport();
    const promptP = session.prompt([textContent('test')], new AbortController().signal);
    await new Promise((r) => setImmediate(r));
    const newMsg = t.sent.find((m) => m.method === 'session/new');
    t.respond(newMsg!.id!, 'session/new', { sessionId: 'sess_abc' });
    await new Promise((r) => setImmediate(r));
    const promptMsg = t.sent.find((m) => m.method === 'session/prompt');
    t.respond(promptMsg!.id!, 'session/prompt', {});
    const result = await promptP;
    expect(result.stopReason).toBe('end_turn');
    await session.close();
  });

  it('closeSession handles null sessionId and missing close capability', async () => {
    const session = await startSession({
      protocolVersion: 1,
      agentCapabilities: {},
    });
    // Line 544: sessionId is null
    await (session as any).closeSession();
    // Line 548: sessionId set but agentCapabilities.sessionCapabilities.close not set
    (session as any).sessionId = 'sess_no_close';
    await (session as any).closeSession();
    expect(session.getSessionId()).toBeNull();
    await session.close();
  });

  it('constructor sets trustBoundary with trustActor', async () => {
    const mockBoundary = {
      evaluate: vi.fn(),
    } as any;
    const session = await startSession(undefined, {
      trustBoundary: mockBoundary,
      trustActor: { kind: 'agent', id: 'actor-123' },
    });
    expect((session as any).permissionPolicy).toBeDefined();
    await session.close();
  });

  it('constructor sets trustBoundary without trustActor', async () => {
    const mockBoundary = {
      evaluate: vi.fn(),
    } as any;
    const session = await startSession(undefined, {
      trustBoundary: mockBoundary,
    });
    expect((session as any).permissionPolicy).toBeDefined();
    await session.close();
  });

  it('prompt reuses existing sessionId without calling session/new', async () => {
    const session = await startSession();
    const t = lastTransport();
    (session as any).sessionId = 'existing_session';
    const promptP = session.prompt([textContent('test')], new AbortController().signal);
    await new Promise((r) => setImmediate(r));
    const promptMsg = t.sent.find((m) => m.method === 'session/prompt');
    expect(promptMsg).toBeDefined();
    expect(t.sent.filter((m) => m.method === 'session/new')).toHaveLength(0);
    t.respond(promptMsg!.id!, 'session/prompt', { stopReason: 'end_turn' });
    const result = await promptP;
    expect(result.stopReason).toBe('end_turn');
    await session.close();
  });

  it('prompt aborts right after session/new finishes', async () => {
    const session = await startSession();
    const t = lastTransport();
    const ac = new AbortController();
    const promptP = session.prompt([textContent('test')], ac.signal);
    await new Promise((r) => setImmediate(r));
    const newMsg = t.sent.find((m) => m.method === 'session/new');
    ac.abort();
    t.respond(newMsg!.id!, 'session/new', { sessionId: 'sess_123' });
    const result = await promptP;
    expect(result.stopReason).toBe('cancelled');
    await session.close();
  });

  it('handleMessage sends error response on invalid request', async () => {
    const session = await startSession();
    const t = lastTransport();
    (session as any).handleMessage({
      jsonrpc: '2.0',
      id: 999,
      method: 'fs/read_text_file',
      params: {},
    });
    await new Promise((r) => setImmediate(r));
    const errResp = t.sent.find((m: any) => m.id === 999 && m.error);
    expect(errResp).toBeDefined();
    await session.close();
  });

  it('handleAcpTerminalRequest catches rejection when transport.send fails', async () => {
    const session = await startSession();
    const t = lastTransport();
    t.send.mockRejectedValue(new Error('transport write broken'));
    (session as any).handleMessage({
      jsonrpc: '2.0',
      id: 'term-broken',
      method: 'terminal/create',
      params: {},
    });
    await new Promise((r) => setImmediate(r));
    await session.close();
  });
});
