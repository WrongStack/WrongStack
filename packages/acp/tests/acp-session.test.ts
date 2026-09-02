/**
 * Tests for ACPSession.
 *
 * Strategy: vi.mock the stdio transport with a controllable fake. The
 * fake records sent messages, lets tests emit canned responses, and
 * supports `emit(msg)` to fire inbound messages as if they came from
 * the child process.
 *
 * Tested scenarios mirror the design doc's test strategy section.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { ACPMessage } from '../src/types/acp-messages.js';
import { ACPSession, ACPSessionError, textContent } from '../src/client/acp-session.js';
import { defaultPermissionPolicy } from '../src/client/permission.js';

const hoisted = vi.hoisted(() => ({ instances: [] as FakeTransport[] }));

interface FakeTransport {
  sent: ACPMessage[];
  handlers: Array<(m: ACPMessage) => void>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  onMessage: (h: (m: ACPMessage) => void) => () => void;
  emit: (m: ACPMessage) => void;
  /** Direct call: send a response to a specific request id. */
  respond: (id: number | string, method: string, result: unknown) => void;
  /** Direct call: send an error response. */
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

const PROJECT_ROOT = path.resolve(os.tmpdir(), 'wstack-acp-test-' + process.pid);

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
  // Best-effort retry: on Windows the rmdir occasionally fails with
  // EBUSY when the prior test's session still has a file handle open
  // for a few extra milliseconds.
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
  // Don't await start() yet — we need to read the initialize message
  // and respond to it first, otherwise start() deadlocks waiting for
  // the initialize response that we can't send until start() returns.
  const p = ACPSession.start({ command: 'fake', projectRoot: PROJECT_ROOT, ...overrides });
  const t = lastTransport();
  // Give the microtask queue a tick so the initialize message is sent
  // before we try to find it.
  await new Promise((r) => setImmediate(r));
  const init = t.sent.find((m) => m.method === 'initialize');
  expect(init).toBeDefined();
  t.respond(init!.id!, 'initialize', initResult);
  return p;
}

describe('ACPSession', () => {
  it('returns a JSON-RPC error when the permission policy throws', async () => {
    const permissionPolicy = vi.fn(async () => {
      throw new Error('approval backend unavailable');
    });
    const session = await startSession(undefined, { permissionPolicy });
    const t = lastTransport();

    t.emit({
      jsonrpc: '2.0',
      id: 'perm-1',
      method: 'session/request_permission',
      params: {
        sessionId: 'sess_abc',
        toolCall: {
          toolCallId: 'tc-permission',
          title: 'edit a.ts',
          kind: 'edit',
          status: 'pending',
        },
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
      },
    } as never as ACPMessage);
    await new Promise((resolve) => setImmediate(resolve));

    const response = t.sent.find((message) => message.id === 'perm-1') as
      | { jsonrpc?: string; method?: string; error?: { code?: number; message?: string } }
      | undefined;
    expect(permissionPolicy).toHaveBeenCalledTimes(1);
    expect(response).toMatchObject({
      jsonrpc: '2.0',
      error: {
        code: -32603,
        message: 'permission policy failed: approval backend unavailable',
      },
    });
    expect(response?.method).toBeUndefined();

    await session.close();
  });

  it('swallows rejected fire-and-forget callback responses during teardown', async () => {
    const session = await startSession();
    const t = lastTransport();
    const filePath = path.join(PROJECT_ROOT, 'callback-read.txt');
    await fsp.writeFile(filePath, 'callback content', 'utf8');
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      t.send.mockImplementation(async (message: ACPMessage) => {
        if (message.id === 'fs-close') {
          throw new Error('transport closed');
        }
        t.sent.push(message);
      });

      t.emit({
        jsonrpc: '2.0',
        id: 'fs-close',
        method: 'fs/read_text_file',
        params: { sessionId: 'sess_abc', path: filePath },
      } as never as ACPMessage);
      await session.close();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
      await session.close();
    }
  });

  it('closes cleanly with a pending permission callback (no unhandled rejection)', async () => {
    // Regression: close() aborts the pending callback; the handler's catch
    // then tries sendErrorResponse on a transport whose send() rejects after
    // teardown. That rejection must be swallowed, not crash the process.
    const neverSettles = vi
      .fn()
      .mockImplementation(
        () => new Promise(() => undefined) as ReturnType<typeof defaultPermissionPolicy>,
      );
    const session = await startSession(undefined, { permissionPolicy: neverSettles });
    const t = lastTransport();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      t.send.mockImplementation(async (message: ACPMessage) => {
        t.sent.push(message);
        if ((message as { id?: unknown }).id === 'perm-close') {
          throw new Error('ClientTransport not started');
        }
      });

      t.emit({
        jsonrpc: '2.0',
        id: 'perm-close',
        method: 'session/request_permission',
        params: {
          sessionId: 'sess_abc',
          toolCall: {
            toolCallId: 'tc-pending',
            title: 'write a.ts',
            kind: 'edit',
            status: 'pending',
          },
          options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
        },
      } as never as ACPMessage);
      // Let the handler reach the policy race before tearing down.
      await new Promise((resolve) => setImmediate(resolve));
      expect(neverSettles).toHaveBeenCalledTimes(1);

      await session.close();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      // The abort-driven cancellation must have attempted a -32800 reply.
      const response = t.sent.find(
        (message) =>
          (message as { id?: unknown }).id === 'perm-close' &&
          (message as { error?: unknown }).error !== undefined,
      ) as { error?: { code?: number; message?: string } } | undefined;
      expect(response?.error?.code).toBe(-32800);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
      await session.close();
    }
  });

  it('runs a happy-path prompt turn and concatenates text', async () => {
    const session = await startSession();
    const t = lastTransport();

    // Kick off the prompt (don't await yet)
    const promptP = session.prompt([textContent('hello')], new AbortController().signal);

    // Drain session/new response
    await new Promise((r) => setImmediate(r));
    const newMsg = t.sent.find((m) => m.method === 'session/new');
    t.respond(newMsg!.id!, 'session/new', { sessionId: 'sess_abc' });

    // Drain session/prompt
    await new Promise((r) => setImmediate(r));
    const promptMsg = t.sent.find((m) => m.method === 'session/prompt');
    expect(promptMsg).toBeDefined();
    // Stream a few agent_message_chunk updates
    t.emit({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'sess_abc',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hel' } },
      },
    } as never as ACPMessage);
    t.emit({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'sess_abc',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'lo' } },
      },
    } as never as ACPMessage);
    // Now return the stopReason
    t.respond(promptMsg!.id!, 'session/prompt', { stopReason: 'end_turn' });

    const result = await promptP;
    expect(result.text).toBe('hello');
    expect(result.stopReason).toBe('end_turn');
    expect(result.hasText).toBe(true);

    await session.close();
  });

  it('captures tool calls, diffs and thoughts, and streams them via onProgress', async () => {
    const session = await startSession();
    const t = lastTransport();

    const events: string[] = [];
    const promptP = session.prompt([textContent('do it')], new AbortController().signal, (e) =>
      events.push(e.type),
    );

    await new Promise((r) => setImmediate(r));
    const newMsg = t.sent.find((m) => m.method === 'session/new');
    t.respond(newMsg!.id!, 'session/new', { sessionId: 'sess_abc' });
    await new Promise((r) => setImmediate(r));
    const promptMsg = t.sent.find((m) => m.method === 'session/prompt');

    const update = (u: unknown) =>
      t.emit({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId: 'sess_abc', update: u },
      } as never as ACPMessage);

    update({ sessionUpdate: 'thought_chunk', content: { type: 'text', text: 'hmm' } });
    update({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc1',
      title: 'edit a.ts',
      kind: 'edit',
      status: 'in_progress',
      content: [{ type: 'diff', path: 'a.ts', oldText: null, newText: 'new' }],
    });
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'tc1', status: 'completed' });
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } });
    t.respond(promptMsg!.id!, 'session/prompt', { stopReason: 'end_turn' });

    const result = await promptP;
    expect(result.text).toBe('done');
    expect(result.thoughts).toBe('hmm');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({ toolCallId: 'tc1', status: 'completed' });
    expect(result.diffs).toEqual([{ path: 'a.ts', oldText: null, newText: 'new' }]);
    // Live progress fired for thought, tool_call, diff, tool_call_update, message.
    expect(events).toEqual(
      expect.arrayContaining(['thought', 'tool_call', 'diff', 'tool_call_update', 'message']),
    );

    await session.close();
  });

  it('returns stopReason=cancelled and a session/cancel notification when aborted', async () => {
    const session = await startSession();
    const t = lastTransport();
    const ac = new AbortController();
    const promptP = session.prompt([textContent('hello')], ac.signal);

    await new Promise((r) => setImmediate(r));
    const newMsg = t.sent.find((m) => m.method === 'session/new');
    t.respond(newMsg!.id!, 'session/new', { sessionId: 'sess_abc' });
    await new Promise((r) => setImmediate(r));
    const promptMsg = t.sent.find((m) => m.method === 'session/prompt');

    // Abort mid-turn
    ac.abort();
    // Let the abort handler fire
    await new Promise((r) => setImmediate(r));
    // The session should have sent a session/cancel notification
    const cancel = t.sent.find((m) => m.method === 'session/cancel');
    expect(cancel).toBeDefined();
    // The agent eventually responds with stopReason=cancelled
    t.respond(promptMsg!.id!, 'session/prompt', { stopReason: 'cancelled' });

    const result = await promptP;
    expect(result.stopReason).toBe('cancelled');

    await session.close();
  });

  it('returns stopReason=cancelled when the signal is pre-aborted (no wire activity)', async () => {
    const session = await startSession();
    const ac = new AbortController();
    ac.abort();
    const result = await session.prompt([textContent('x')], ac.signal);
    // A pre-aborted prompt is a normal cancelled outcome per spec;
    // session/cancel is only sent for in-flight prompts.
    expect(result.stopReason).toBe('cancelled');
    expect(result.text).toBe('');
    expect(result.hasText).toBe(false);
    await session.close();
  });

  it('returns stopReason=cancelled when the signal aborts during session/new (no session/prompt sent)', async () => {
    const session = await startSession();
    const t = lastTransport();
    const ac = new AbortController();

    const promptP = session.prompt([textContent('hello')], ac.signal);
    await new Promise((r) => setImmediate(r));
    const newMsg = t.sent.find((m) => m.method === 'session/new');
    expect(newMsg).toBeDefined();

    // The abort lands while session/new is still in flight — before prompt()
    // registers its abort listener. addEventListener on an already-aborted
    // signal never fires, so the cancellation must be re-checked after the
    // create resolves instead of being lost.
    ac.abort();
    t.respond(newMsg!.id!, 'session/new', { sessionId: 'sess_aborted_create' });
    await new Promise((r) => setImmediate(r));

    // The cancelled turn must never reach the wire.
    expect(t.sent.some((m) => m.method === 'session/prompt')).toBe(false);

    const result = await promptP;
    expect(result.stopReason).toBe('cancelled');
    expect(result.text).toBe('');
    expect(result.hasText).toBe(false);

    await session.close();
  });

  it('throws ACPSessionError(init_failed) when the agent speaks a different version', async () => {
    hoisted.instances.length = 0;
    const p = ACPSession.start({ command: 'fake', projectRoot: PROJECT_ROOT });
    const t = lastTransport();
    // Tick to let start() send the initialize message
    await new Promise((r) => setImmediate(r));
    const init = t.sent.find((m) => m.method === 'initialize')!;
    t.respond(init.id!, 'initialize', { protocolVersion: 99 });
    await expect(p).rejects.toBeInstanceOf(ACPSessionError);
    await expect(p).rejects.toMatchObject({ kind: 'unsupported_capability' });
  });

  it('answers fs/read_text_file from the file server', async () => {
    const session = await startSession();
    const t = lastTransport();

    // Skip session/new (not needed for fs); the request comes from the
    // agent mid-prompt, we just route it through handleFsRequest.
    const filePath = path.join(PROJECT_ROOT, 'greeting.txt');
    await (await import('node:fs/promises')).writeFile(filePath, 'hi from file', 'utf8');

    const id = 42;
    t.emit({
      jsonrpc: '2.0',
      id,
      method: 'fs/read_text_file',
      params: { sessionId: 'sess_abc', path: filePath },
    } as never as ACPMessage);

    // Wait for the async handler to read the file and send the response.
    // The handler awaits fileServer.readTextFile (which is a real fs
    // call) then awaits transport.send. Give it a real timer tick.
    await new Promise((r) => setTimeout(r, 50));
    // JSON-RPC responses are correlated by id alone and MUST NOT carry a
    // `method` field (the official ACP SDK drops responses that do).
    const response = t.sent.find((m) => m.id === id && m.result !== undefined);
    expect(response).toBeDefined();
    expect((response as { jsonrpc?: string }).jsonrpc).toBe('2.0');
    expect((response as { method?: string }).method).toBeUndefined();
    expect((response!.result as { content: string }).content).toBe('hi from file');

    await session.close();
  });

  it('rejects fs/read_text_file for paths outside projectRoot', async () => {
    const session = await startSession();
    const t = lastTransport();

    const id = 43;
    t.emit({
      jsonrpc: '2.0',
      id,
      method: 'fs/read_text_file',
      params: { sessionId: 'sess_abc', path: '/etc/passwd' },
    } as never as ACPMessage);

    await new Promise((r) => setImmediate(r));
    const response = t.sent.find((m) => m.id === id && m.error !== undefined);
    expect(response).toBeDefined();
    expect((response as { jsonrpc?: string }).jsonrpc).toBe('2.0');
    expect((response as { method?: string }).method).toBeUndefined();
    expect(response!.error).toBeDefined();
    expect(response!.error!.code).toBe(-32602);

    await session.close();
  });

  it('runs a terminal end-to-end (create → output → wait_for_exit)', async () => {
    const session = await startSession(undefined, { permissionPolicy: defaultPermissionPolicy });
    const t = lastTransport();

    const createId = 100;
    t.emit({
      jsonrpc: '2.0',
      id: createId,
      method: 'terminal/create',
      params: {
        sessionId: 'sess_abc',
        command: 'node',
        args: ['-e', "console.log('hi from terminal')"],
        cwd: PROJECT_ROOT,
      },
    } as never as ACPMessage);
    await new Promise((r) => setImmediate(r));

    const createResp = t.sent.find((m) => m.id === createId);
    expect(createResp).toBeDefined();
    const terminalId = (createResp!.result as { terminalId: string }).terminalId;
    expect(terminalId).toMatch(/^term_/);

    // Wait for the process to exit
    const waitId = 101;
    t.emit({
      jsonrpc: '2.0',
      id: waitId,
      method: 'terminal/wait_for_exit',
      params: { sessionId: 'sess_abc', terminalId },
    } as never as ACPMessage);
    // Do not assume a child Node process receives a fixed CPU slice under the
    // full coverage suite. Wait for the protocol response instead of making
    // this end-to-end assertion depend on an arbitrary wall-clock delay.
    await vi.waitFor(
      () => expect(t.sent.find((m) => m.id === waitId)).toBeDefined(),
      { timeout: 5_000 },
    );
    const waitResp = t.sent.find((m) => m.id === waitId);
    expect(waitResp).toBeDefined();
    expect((waitResp!.result as { exitCode: number | null }).exitCode).toBe(0);

    // Now ask for output
    const outputId = 102;
    t.emit({
      jsonrpc: '2.0',
      id: outputId,
      method: 'terminal/output',
      params: { sessionId: 'sess_abc', terminalId },
    } as never as ACPMessage);
    await new Promise((r) => setImmediate(r));
    const outputResp = t.sent.find((m) => m.id === outputId);
    expect((outputResp!.result as { output: string }).output).toContain('hi from terminal');

    await session.close();
  });

  it('captures resource-type content in agent_message_chunk via extractText', async () => {
    const session = await startSession();
    const t = lastTransport();

    const promptP = session.prompt([textContent('show resource')], new AbortController().signal);
    await new Promise((r) => setImmediate(r));
    const newMsg = t.sent.find((m) => m.method === 'session/new')!;
    t.respond(newMsg.id!, 'session/new', { sessionId: 'sess_resource' });
    await new Promise((r) => setImmediate(r));
    const promptMsg = t.sent.find((m) => m.method === 'session/prompt')!;

    // Send an agent_message_chunk with type 'resource' (tests extractText resource branch)
    t.emit({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'sess_resource',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'resource', resource: { text: 'embedded content' } },
        },
      },
    } as never as ACPMessage);
    t.respond(promptMsg.id!, 'session/prompt', { stopReason: 'end_turn' });

    const result = await promptP;
    expect(result.text).toBe('embedded content');
    await session.close();
  });

  it('audioContent and imageContent helper functions', async () => {
    const mod = await vi.importActual<typeof import('../src/client/acp-session.js')>(
      '../src/client/acp-session.js',
    );
    const audio = mod.audioContent('audio/wav', 'base64data');
    expect(audio).toEqual({ type: 'audio', mimeType: 'audio/wav', data: 'base64data' });

    const image = mod.imageContent('image/png', 'pngdata');
    expect(image).toEqual({ type: 'image', mimeType: 'image/png', data: 'pngdata' });
  });

  it('captures thought_chunk updates', async () => {
    const session = await startSession();
    const t = lastTransport();

    const promptP = session.prompt([textContent('think')], new AbortController().signal);
    await new Promise((r) => setImmediate(r));
    const newMsg = t.sent.find((m) => m.method === 'session/new')!;
    t.respond(newMsg.id!, 'session/new', { sessionId: 'sess_think' });
    await new Promise((r) => setImmediate(r));
    const promptMsg = t.sent.find((m) => m.method === 'session/prompt')!;

    t.emit({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'sess_think',
        update: { sessionUpdate: 'thought_chunk', content: { type: 'text', text: 'thinking...' } },
      },
    } as never as ACPMessage);
    t.respond(promptMsg.id!, 'session/prompt', { stopReason: 'end_turn' });

    const result = await promptP;
    expect(result.thoughts).toBe('thinking...');
    await session.close();
  });

  it('captures plan and usage updates from session/update', async () => {
    const session = await startSession();
    const t = lastTransport();

    const promptP = session.prompt([textContent('plan please')], new AbortController().signal);
    await new Promise((r) => setImmediate(r));
    const newMsg = t.sent.find((m) => m.method === 'session/new')!;
    t.respond(newMsg.id!, 'session/new', { sessionId: 'sess_abc' });
    await new Promise((r) => setImmediate(r));
    const promptMsg = t.sent.find((m) => m.method === 'session/prompt')!;

    // Send a plan
    t.emit({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'sess_abc',
        update: {
          sessionUpdate: 'plan',
          entries: [
            { content: 'first', priority: 'high', status: 'in_progress' },
            { content: 'second', priority: 'low', status: 'pending' },
          ],
        },
      },
    } as never as ACPMessage);
    // Send a usage update
    t.emit({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'sess_abc',
        update: {
          sessionUpdate: 'usage_update',
          used: 1200,
          size: 200_000,
          cost: { amount: 0.01, currency: 'USD' },
        },
      },
    } as never as ACPMessage);
    // And the agent's text
    t.emit({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'sess_abc',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } },
      },
    } as never as ACPMessage);
    t.respond(promptMsg.id!, 'session/prompt', { stopReason: 'end_turn' });

    const result = await promptP;
    expect(result.text).toBe('ok');
    expect(result.plan).toHaveLength(2);
    expect(result.plan?.[0]?.content).toBe('first');
    expect(result.usage?.used).toBe(1200);
    expect(result.usage?.cost?.amount).toBe(0.01);

    await session.close();
  });

  it('covers the advertised lifecycle and provider APIs', async () => {
    const session = await startSession({
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        auth: { logout: true },
        sessionCapabilities: {
          close: {},
          resume: {},
          list: {},
          delete: {},
          fork: {},
        },
      },
      authMethods: [{ id: 'token', name: 'Token' }],
      agentInfo: { name: 'agent', version: '1.0' },
    });
    const t = lastTransport();
    const reply = async <T>(
      method: string,
      action: Promise<T>,
      result: unknown = {},
    ): Promise<T> => {
      await new Promise((resolve) => setImmediate(resolve));
      const request = t.sent.findLast((message) => message.method === method);
      expect(request, method).toBeDefined();
      t.respond(request!.id!, method, result);
      return action;
    };

    expect(session.getNegotiatedVersion()).toBe(1);
    expect(session.getCapabilities().loadSession).toBe(true);
    expect(session.getAuthMethods()).toHaveLength(1);
    expect(session.getAgentInfo()).toMatchObject({ name: 'agent' });
    expect(session.requiresAuth()).toBe(true);
    expect(session.getSessionId()).toBeNull();

    await reply('authenticate', session.authenticate('token'));
    await reply('logout', session.logout());
    await reply('session/load', session.loadSession('loaded' as never));
    expect(session.getSessionId()).toBe('loaded');
    await reply('session/delete', session.deleteSession('loaded' as never));
    expect(session.getSessionId()).toBeNull();
    await reply('session/resume', session.resumeSession('resumed' as never));
    await reply('session/delete', session.deleteSession('resumed' as never));

    await expect(
      reply('session/list', session.listSessions('cursor', '/cwd'), {
        sessions: [{ sessionId: 'one', cwd: '/cwd' }],
        nextCursor: 'next',
      }),
    ).resolves.toMatchObject({ nextCursor: 'next' });
    await expect(
      reply('session/fork', session.forkSession('one' as never, '/fork'), { sessionId: 'forked' }),
    ).resolves.toBe('forked');
    await reply('session/set_mode', session.setMode('one' as never, 'code'));
    await reply(
      'session/set_config_option',
      session.setConfigOption('one' as never, 'model', 'large'),
    );
    await expect(
      reply('providers/list', session.listProviders(), {
        providers: ['provider'],
        currentProviderId: 'provider',
      }),
    ).resolves.toEqual({ providers: ['provider'], currentProviderId: 'provider' });
    await expect(
      reply('mcp/message', session.mcpMessage('connection', { jsonrpc: '2.0' }), {
        accepted: true,
      }),
    ).resolves.toEqual({ accepted: true });
    await reply('providers/set', session.setProvider('provider', { key: 'value' }));
    await reply('providers/disable', session.disableProvider());
    await session.close();
    await session.close();
  });
});
