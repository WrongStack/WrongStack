/**
 * Focused coverage for ACPSession branches not exercised by the main
 * suite: authenticate against an unadvertised method, abort with a
 * failing transport, MCP server capability filtering, sendRequest
 * timeout/send-failure, terminal fire-and-forget teardown, and
 * best-effort ack send failures.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { ACPMessage } from '../src/types/acp-messages.js';
import { ACPSession, textContent } from '../src/client/acp-session.js';

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
});
