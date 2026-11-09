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

import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACPSession, ACPSessionError, textContent } from '../src/client/acp-session.js';
import { defaultPermissionPolicy } from '../src/client/permission.js';
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
  /** Direct call: send a response to a specific request id. */
  respond: (id: number | string, method: string, result: unknown) => void;
  /** Direct call: send an error response. */
  respondError: (
    id: number | string,
    method: string,
    error: { code: number; message: string },
  ) => void;
}

vi.mock('../src/agent/stdio-transport.js', async () => {
  // Dynamic, not a static import: vi.mock is hoisted above the imports, so the
  // shared helper would not be initialised when this factory body runs.
  const { FakeClientTransport } = await import('./helpers/fake-client-transport.js');
  class ClientTransport extends FakeClientTransport {
    constructor() {
      super();
      hoisted.instances.push(this as never as FakeTransport);
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

      // Permission cancellation has a standard successful cancelled outcome.
      const response = t.sent.find(
        (message) =>
          (message as { id?: unknown }).id === 'perm-close' &&
          (message as { result?: unknown }).result !== undefined,
      ) as { result?: unknown } | undefined;
      expect(response?.result).toEqual({ outcome: { outcome: 'cancelled' } });
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

  it('drops a session/update that names a different session (client-side defense in depth)', async () => {
    const session = await startSession();
    const t = lastTransport();

    const promptP = session.prompt([textContent('hello')], new AbortController().signal);
    await new Promise((r) => setImmediate(r));
    const newMsg = t.sent.find((m) => m.method === 'session/new');
    t.respond(newMsg!.id!, 'session/new', { sessionId: 'sess_abc' });
    await new Promise((r) => setImmediate(r));

    // A stale chunk left over from a session this client no longer holds.
    t.emit({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'sess_closed_elsewhere',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'STALE' } },
      },
    } as never as ACPMessage);
    // The active session's own chunk must still be folded in.
    t.emit({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'sess_abc',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'mine' } },
      },
    } as never as ACPMessage);

    const promptMsg = t.sent.find((m) => m.method === 'session/prompt');
    t.respond(promptMsg!.id!, 'session/prompt', { stopReason: 'end_turn' });

    const result = await promptP;
    expect(result.text).toBe('mine');
    expect(result.text).not.toContain('STALE');
    await session.close();
  });

  it("keeps the agent's error reply in the cause chain of a failed prompt", async () => {
    const session = await startSession();
    const t = lastTransport();
    const promptP = session.prompt([textContent('hi')], new AbortController().signal);
    await new Promise((r) => setImmediate(r));
    t.respond(t.sent.find((m) => m.method === 'session/new')!.id!, 'session/new', {
      sessionId: 's',
    });
    await new Promise((r) => setImmediate(r));
    const reply = {
      code: -32603,
      message: "Internal error: You've hit your limit · resets 3pm",
      data: { errorKind: 'rate_limit' },
    };
    t.respondError(t.sent.find((m) => m.method === 'session/prompt')!.id!, 'session/prompt', reply);
    const err = (await promptP.catch((e: unknown) => e)) as { kind?: string; cause?: unknown };
    expect(err.kind).toBe('prompt_failed');
    const chain: unknown[] = [];
    for (let c: unknown = err; c; c = (c as { cause?: unknown }).cause) chain.push(c);
    expect(chain).toContainEqual(
      expect.objectContaining({ code: -32603, data: { errorKind: 'rate_limit' } }),
    );
    await session.close();
  });

  it("reads the turn's token usage from the prompt response", async () => {
    for (const [usage, tokens] of [
      [
        { inputTokens: 120, outputTokens: 30, cachedReadTokens: 4000, totalTokens: 4150 },
        { input: 120, output: 30, cacheRead: 4000, cacheWrite: 0 },
      ],
      [{ totalTokens: 9 }, undefined],
      [undefined, undefined],
    ] as const) {
      const session = await startSession();
      const t = lastTransport();
      const promptP = session.prompt([textContent('hi')], new AbortController().signal);
      await new Promise((r) => setImmediate(r));
      t.respond(t.sent.find((m) => m.method === 'session/new')!.id!, 'session/new', {
        sessionId: 's',
      });
      await new Promise((r) => setImmediate(r));
      t.respond(t.sent.find((m) => m.method === 'session/prompt')!.id!, 'session/prompt', {
        stopReason: 'end_turn',
        ...(usage ? { usage } : {}),
      });
      expect((await promptP).tokens).toEqual(tokens);
      await session.close();
    }
  });

  it('CONTROL: still handles a session/update that omits sessionId', async () => {
    const session = await startSession();
    const t = lastTransport();

    const promptP = session.prompt([textContent('hello')], new AbortController().signal);
    await new Promise((r) => setImmediate(r));
    const newMsg = t.sent.find((m) => m.method === 'session/new');
    t.respond(newMsg!.id!, 'session/new', { sessionId: 'sess_abc' });
    await new Promise((r) => setImmediate(r));

    // Non-conformant update with no sessionId must not be dropped.
    t.emit({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'noid' } },
      },
    } as never as ACPMessage);

    const promptMsg = t.sent.find((m) => m.method === 'session/prompt');
    t.respond(promptMsg!.id!, 'session/prompt', { stopReason: 'end_turn' });

    const result = await promptP;
    expect(result.text).toBe('noid');
    await session.close();
  });

  it('authenticates with an agent-type method then retries session/new on auth_required', async () => {
    const session = await startSession({
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
      agentInfo: { name: 'fake-agent', version: '0.0.1' },
      authMethods: [{ id: 'oauth', name: 'OAuth', type: 'agent' }],
    });
    const t = lastTransport();
    const promptP = session.prompt([textContent('hello')], new AbortController().signal);

    await new Promise((r) => setImmediate(r));
    const newMsg = t.sent.find((m) => m.method === 'session/new');
    t.respondError(newMsg!.id!, 'session/new', {
      code: -32000,
      message: 'Authentication required',
    });

    await new Promise((r) => setImmediate(r));
    const authMsg = t.sent.find((m) => m.method === 'authenticate');
    expect(authMsg).toBeDefined();
    expect((authMsg as { params?: { methodId?: string } }).params?.methodId).toBe('oauth');
    t.respond(authMsg!.id!, 'authenticate', {});

    await new Promise((r) => setImmediate(r));
    const retryNew = t.sent.filter((m) => m.method === 'session/new');
    expect(retryNew.length).toBe(2);
    t.respond(retryNew[1]!.id!, 'session/new', { sessionId: 'sess_authed' });

    await new Promise((r) => setImmediate(r));
    const promptMsg = t.sent.find((m) => m.method === 'session/prompt');
    t.respond(promptMsg!.id!, 'session/prompt', { stopReason: 'end_turn' });

    const result = await promptP;
    expect(result.stopReason).toBe('end_turn');
    await session.close();
  });

  it('fails with a terminal-login hint when only terminal auth is advertised', async () => {
    const session = await startSession({
      protocolVersion: 1,
      agentCapabilities: {},
      agentInfo: { name: 'kimi', version: '1' },
      authMethods: [{ id: 'login', name: 'Login', type: 'terminal', args: ['--setup'] }],
    });
    const t = lastTransport();
    const promptP = session.prompt([textContent('hello')], new AbortController().signal);

    await new Promise((r) => setImmediate(r));
    const newMsg = t.sent.find((m) => m.method === 'session/new');
    t.respondError(newMsg!.id!, 'session/new', { code: -32000, message: 'auth_required' });

    await expect(promptP).rejects.toMatchObject({
      kind: 'auth_failed',
      message: expect.stringContaining('terminal login'),
    });
    expect(t.sent.some((m) => m.method === 'authenticate')).toBe(false);
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

  it('keeps a tool result sent as content text blocks or as a text rawOutput', async () => {
    const session = await startSession();
    const t = lastTransport();
    const promptP = session.prompt([textContent('look')], new AbortController().signal);

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

    // Claude's adapter: the result as `content` blocks, `rawOutput` the raw
    // tool_result content (a string or an array of text blocks).
    update({ sessionUpdate: 'tool_call', toolCallId: 'r1', title: 'Read a.ts', status: 'pending' });
    update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'r1',
      status: 'completed',
      rawOutput: [{ type: 'text', text: 'raw' }],
      content: [{ type: 'content', content: { type: 'text', text: 'line 1\nline 2' } }],
    });
    update({
      sessionUpdate: 'tool_call',
      toolCallId: 'b1',
      title: 'git status',
      status: 'pending',
    });
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'b1', rawOutput: 'clean' });
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'b1', status: 'completed' });
    t.respond(promptMsg!.id!, 'session/prompt', { stopReason: 'end_turn' });

    const { toolCalls } = await promptP;
    expect(toolCalls.find((c) => c.toolCallId === 'r1')?.output).toBe('line 1\nline 2');
    // A later update without a result keeps the one already seen.
    expect(toolCalls.find((c) => c.toolCallId === 'b1')).toMatchObject({
      status: 'completed',
      output: 'clean',
      rawOutput: undefined,
    });
    await session.close();
  });

  it('resumes an earlier session when asked and offered, with this session meta and mode', async () => {
    const init = {
      protocolVersion: 1,
      agentCapabilities: { sessionCapabilities: { resume: {} } },
      agentInfo: { name: 'claude', version: '1' },
    };
    const session = await startSession(init, {
      resumeSessionId: 'sess_old',
      sessionMeta: { systemPrompt: { append: 'note' } },
      initialModeId: 'default',
    });
    const t = lastTransport();
    const opening = session.openSession();
    await new Promise((r) => setImmediate(r));
    const resume = t.sent.find((m) => m.method === 'session/resume');
    expect(resume?.params).toMatchObject({
      sessionId: 'sess_old',
      _meta: { systemPrompt: { append: 'note' } },
    });
    t.respond(resume!.id!, 'session/resume', {
      modes: { currentModeId: 'default', availableModes: [{ id: 'default' }] },
    });
    await expect(opening).resolves.toEqual({ sessionId: 'sess_old', resumed: true });
    expect(t.sent.some((m) => m.method === 'session/new')).toBe(false);
    await session.close();
  });

  it('starts a new session when the agent no longer has the one to resume', async () => {
    const session = await startSession(
      { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } } },
      { resumeSessionId: 'sess_gone' },
    );
    const t = lastTransport();
    const opening = session.openSession();
    await new Promise((r) => setImmediate(r));
    const resume = t.sent.find((m) => m.method === 'session/resume');
    t.respondError(resume!.id!, 'session/resume', { code: -32002, message: 'not found' });
    await new Promise((r) => setImmediate(r));
    const created = t.sent.find((m) => m.method === 'session/new');
    t.respond(created!.id!, 'session/new', { sessionId: 'sess_new' });
    await expect(opening).resolves.toEqual({ sessionId: 'sess_new', resumed: false });
    await session.close();
  });

  it('abort mid-turn sends session/cancel and returns stopReason=cancelled', async () => {
    const session = await startSession();
    const t = lastTransport();
    const ac = new AbortController();
    const promptP = session.prompt([textContent('hello')], ac.signal);

    await new Promise((r) => setImmediate(r));
    const newMsg = t.sent.find((m) => m.method === 'session/new');
    t.respond(newMsg!.id!, 'session/new', { sessionId: 'sess_abc' });
    await new Promise((r) => setImmediate(r));
    const promptMsg = t.sent.find((m) => m.method === 'session/prompt');
    // The turn must be on the wire before the abort, or this is the pre-abort path.
    expect(promptMsg).toBeDefined();

    // Abort mid-turn — onTurnAbort rejects the race, and onAbort (session id
    // already assigned) sends session/cancel on the wire.
    ac.abort();
    // The turn must resolve with 'cancelled': the raced rejection surfaces a
    // clean cancellation even though sendRequest is still in flight.
    const result = await promptP;
    expect(result).toMatchObject({ stopReason: 'cancelled' });
    expect(t.sent.some((m) => m.method === 'session/cancel')).toBe(true);

    await session.close();
  });

  it('returns stopReason=cancelled when the signal is pre-aborted (no wire activity)', async () => {
    const session = await startSession();
    const ac = new AbortController();
    ac.abort();
    // Pre-aborted signal: early guard at line 465 returns immediately.
    // No wire activity (no session/new, no session/cancel).
    const result = await session.prompt([textContent('x')], ac.signal);
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

    // Abort fired during createSessionWithAuth — the race rejected, catch returns
    // emptyRunResult('cancelled') without ever calling sendRequest.
    await expect(promptP).resolves.toMatchObject({ stopReason: 'cancelled' });

    await session.close();
  });

  it('cancels a late-arriving session after an abort-during-creation race loss', async () => {
    const session = await startSession();
    const t = lastTransport();
    const ac = new AbortController();

    const promptP = session.prompt([textContent('hello')], ac.signal);
    await new Promise((r) => setImmediate(r));
    const newMsg = t.sent.find((m) => m.method === 'session/new');
    expect(newMsg).toBeDefined();

    // Abort wins the race; the server confirms the session afterwards. The
    // late arrival must be cancelled instead of leaking server-side.
    ac.abort();
    await new Promise((r) => setImmediate(r));
    t.respond(newMsg!.id!, 'session/new', { sessionId: 'sess_late' });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const cancelMsg = t.sent.find((m) => m.method === 'session/cancel');
    expect(cancelMsg?.params).toMatchObject({ sessionId: 'sess_late' });
    await expect(promptP).resolves.toMatchObject({ stopReason: 'cancelled' });

    await session.close();
  });

  it('surfaces a failed late-cancel send on the warn channel', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const session = await startSession();
    const t = lastTransport();
    const ac = new AbortController();

    const promptP = session.prompt([textContent('hello')], ac.signal);
    await new Promise((r) => setImmediate(r));
    const newMsg = t.sent.find((m) => m.method === 'session/new');
    expect(newMsg).toBeDefined();

    ac.abort();
    await new Promise((r) => setImmediate(r));
    // Break the outbound wire: the late cancel cannot be delivered.
    (lastTransport() as unknown as { send: () => Promise<void> }).send = () =>
      Promise.reject(new Error('transport gone'));
    t.respond(newMsg!.id!, 'session/new', { sessionId: 'sess_late' });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('acp_session.late_cancel_failed');
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('sess_late');

    await expect(promptP).resolves.toMatchObject({ stopReason: 'cancelled' });
    await session.close();
    warnSpy.mockRestore();
  });

  it('warns when the abandoned creation rejects after the race was lost', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const session = await startSession();
    const t = lastTransport();
    const ac = new AbortController();

    const promptP = session.prompt([textContent('hello')], ac.signal);
    await new Promise((r) => setImmediate(r));
    const newMsg = t.sent.find((m) => m.method === 'session/new');
    expect(newMsg).toBeDefined();

    // Abort wins the race; the server then REFUSES the abandoned creation.
    // Nothing is left to cancel, but the refusal must be observable.
    ac.abort();
    await new Promise((r) => setImmediate(r));
    t.respondError(newMsg!.id!, 'session/new', { code: -32000, message: 'nope' });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('acp_session.late_cancel_failed');
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('nope');

    await expect(promptP).resolves.toMatchObject({ stopReason: 'cancelled' });
    await session.close();
    warnSpy.mockRestore();
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

  it('serves fs/read_text_file outside projectRoot when the host allows it', async () => {
    // Claude Code over ACP reads its own settings and temp files; under the
    // host's default allowOutsideProjectRoot those reads were refused with
    // "path is outside the project root" (surfaced as "IO Error").
    const fsp = await import('node:fs/promises');
    const os = await import('node:os');
    const outsideDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wstack-acp-outside-'));
    const outsideFile = path.join(outsideDir, 'agent-settings.json');
    await fsp.writeFile(outsideFile, '{"ok":true}', 'utf8');
    const session = await startSession(undefined, { allowOutsideProjectRoot: true });
    const t = lastTransport();
    try {
      t.emit({
        jsonrpc: '2.0',
        id: 44,
        method: 'fs/read_text_file',
        params: { sessionId: 'sess_abc', path: outsideFile },
      } as never as ACPMessage);
      await new Promise((r) => setTimeout(r, 50));
      const response = t.sent.find((m) => m.id === 44);
      expect(response?.error).toBeUndefined();
      expect((response?.result as { content: string } | undefined)?.content).toBe('{"ok":true}');
    } finally {
      await session.close();
      await fsp.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('puts every read that leaves the project to the permission policy as a read', async () => {
    // Outside-root reads skip containment, so the host's sensitive-path rules
    // (~/.ssh, ~/.aws, agent state) must still see them: they live in the
    // permission policy, which an fs/read_text_file used to bypass entirely.
    const fsp = await import('node:fs/promises');
    const os = await import('node:os');
    const outsideDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wstack-acp-gate-'));
    const secret = path.join(outsideDir, 'id_rsa');
    await fsp.writeFile(secret, 'PRIVATE', 'utf8');
    const inside = path.join(PROJECT_ROOT, 'inside.txt');
    await fsp.writeFile(inside, 'project text', 'utf8');
    const link = path.join(PROJECT_ROOT, 'innocent-link');
    let linked = true;
    try {
      await fsp.symlink(secret, link, 'file');
    } catch {
      linked = false; // symlinks need privileges on some Windows hosts
    }
    const asked: Array<{ kind: string | undefined; path: unknown }> = [];
    const session = await startSession(undefined, {
      allowOutsideProjectRoot: true,
      permissionPolicy: async (req) => {
        asked.push({
          kind: req.toolCall.kind ?? undefined,
          path: (req.toolCall.rawInput as { path?: unknown } | undefined)?.path,
        });
        return { outcome: 'selected', optionId: 'reject' };
      },
    });
    const t = lastTransport();
    const read = async (id: number, p: string) => {
      t.emit({
        jsonrpc: '2.0',
        id,
        method: 'fs/read_text_file',
        params: { sessionId: 'sess_abc', path: p },
      } as never as ACPMessage);
      await new Promise((r) => setTimeout(r, 50));
      return t.sent.find((m) => m.id === id);
    };
    try {
      const denied = await read(45, secret);
      expect(denied?.error?.message).toContain('denied by permission policy');
      expect(JSON.stringify(denied)).not.toContain('PRIVATE');
      expect(asked).toEqual([{ kind: 'read', path: await fsp.realpath(secret) }]);

      const ok = await read(46, inside);
      expect((ok?.result as { content: string } | undefined)?.content).toBe('project text');
      expect(asked).toHaveLength(1); // a read inside the project asks nothing

      if (linked) {
        const viaLink = await read(47, link);
        expect(viaLink?.error).toBeDefined();
        expect(JSON.stringify(viaLink)).not.toContain('PRIVATE');
        // Asked about the file the link opens, not the innocent spelling.
        expect(asked.at(-1)).toEqual({ kind: 'read', path: await fsp.realpath(secret) });
      }
    } finally {
      await session.close();
      await fsp.rm(outsideDir, { recursive: true, force: true });
      await fsp.rm(link, { force: true });
      await fsp.rm(inside, { force: true });
    }
  });

  it('asks about the real target of a write through a symlinked directory, and writes there', async () => {
    // A directory link inside the project pointing at agent state: the
    // policy's agent-state guard must see the real target, not the
    // in-project spelling, and the write must land on what was approved.
    const fsp = await import('node:fs/promises');
    const os = await import('node:os');
    const outsideDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wstack-acp-dirlink-'));
    const link = path.join(PROJECT_ROOT, 'state-link');
    await fsp.symlink(outsideDir, link, 'junction');
    const asked: Array<{ kind: string | undefined; path: unknown }> = [];
    let allow = false;
    const session = await startSession(undefined, {
      allowOutsideProjectRoot: true,
      permissionPolicy: async (req) => {
        asked.push({
          kind: req.toolCall.kind ?? undefined,
          path: (req.toolCall.rawInput as { path?: unknown } | undefined)?.path,
        });
        return { outcome: 'selected', optionId: allow ? 'allow' : 'reject' };
      },
    });
    const t = lastTransport();
    const write = async (id: number) => {
      t.emit({
        jsonrpc: '2.0',
        id,
        method: 'fs/write_text_file',
        params: { sessionId: 'sess_abc', path: path.join(link, 'config.json'), content: 'x' },
      } as never as ACPMessage);
      await new Promise((r) => setTimeout(r, 50));
      return t.sent.find((m) => m.id === id);
    };
    try {
      const realTarget = path.join(await fsp.realpath(outsideDir), 'config.json');
      const denied = await write(48);
      expect(denied?.error?.message).toContain('denied by permission policy');
      expect(asked).toEqual([{ kind: 'edit', path: realTarget }]);
      await expect(fsp.readFile(realTarget, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

      allow = true;
      const ok = await write(49);
      expect(ok?.error).toBeUndefined();
      expect(await fsp.readFile(realTarget, 'utf8')).toBe('x');
    } finally {
      await session.close();
      await fsp.rm(link, { recursive: false, force: true });
      await fsp.rm(outsideDir, { recursive: true, force: true });
    }
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
    await vi.waitFor(() => expect(t.sent.find((m) => m.id === waitId)).toBeDefined(), {
      timeout: 5_000,
    });
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

  it('steers the running turn only when the agent advertises steering', async () => {
    const reply = async <T>(
      t: FakeTransport,
      method: string,
      action: Promise<T>,
      result: unknown,
    ) => {
      await new Promise((resolve) => setImmediate(resolve));
      const request = t.sent.findLast((message) => message.method === method);
      expect(request, method).toBeDefined();
      t.respond(request!.id!, method, result);
      return action;
    };

    const plain = await startSession();
    expect(plain.canSteer()).toBe(false);
    await reply(lastTransport(), 'session/load', plain.loadSession('s0' as never), {});
    await expect(plain.steer('hi')).resolves.toBe('unsupported');
    expect(lastTransport().sent.some((m) => m.method === '_session/steering')).toBe(false);
    await plain.close();

    const session = await startSession({
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
      _meta: { steering: { supported: true } },
    });
    const t = lastTransport();
    expect(session.canSteer()).toBe(true);
    // No session yet: nothing to steer.
    await expect(session.steer('early')).resolves.toBe('unsupported');
    await reply(t, 'session/load', session.loadSession('s1' as never), {});

    await expect(
      reply(t, '_session/steering', session.steer('use the index'), { outcome: 'injected' }),
    ).resolves.toBe('injected');
    expect(t.sent.findLast((m) => m.method === '_session/steering')?.params).toEqual({
      sessionId: 's1',
      prompt: [{ type: 'text', text: 'use the index' }],
      _meta: { steering: { idleBehavior: 'promptRequired' } },
    });
    await expect(
      reply(t, '_session/steering', session.steer('late'), { outcome: 'promptRequired' }),
    ).resolves.toBe('promptRequired');

    const failing = session.steer('bad');
    await new Promise((resolve) => setImmediate(resolve));
    const req = t.sent.findLast((m) => m.method === '_session/steering')!;
    t.respondError(req.id!, '_session/steering', { code: -32602, message: 'invalid' });
    await expect(failing).rejects.toThrow('invalid');
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

  it('rejects session operations when closed or unsupported', async () => {
    const session = await startSession({
      protocolVersion: 1,
      agentCapabilities: {},
    });
    // Unsupported capabilities
    await expect(session.logout()).rejects.toMatchObject({ kind: 'unsupported_capability' });
    await expect(session.loadSession('sid' as never)).rejects.toMatchObject({
      kind: 'unsupported_capability',
    });
    await expect(session.resumeSession('sid' as never)).rejects.toMatchObject({
      kind: 'unsupported_capability',
    });
    await expect(session.listSessions()).rejects.toMatchObject({ kind: 'unsupported_capability' });
    await expect(session.deleteSession('sid' as never)).rejects.toMatchObject({
      kind: 'unsupported_capability',
    });

    // Close session
    await session.close();

    // Closed session operations
    await expect(session.authenticate('tok')).rejects.toMatchObject({ kind: 'closed' });
    await expect(session.logout()).rejects.toMatchObject({ kind: 'closed' });
    await expect(session.loadSession('sid' as never)).rejects.toMatchObject({ kind: 'closed' });
    await expect(session.resumeSession('sid' as never)).rejects.toMatchObject({ kind: 'closed' });
    await expect(session.listSessions()).rejects.toMatchObject({ kind: 'closed' });
    await expect(session.deleteSession('sid' as never)).rejects.toMatchObject({ kind: 'closed' });
    await expect(session.forkSession('sid' as never)).rejects.toMatchObject({ kind: 'closed' });
    await expect(session.setMode('sid' as never, 'code')).rejects.toMatchObject({ kind: 'closed' });
    await expect(session.setConfigOption('sid' as never, 'c', 'v')).rejects.toMatchObject({
      kind: 'closed',
    });
    await expect(session.listProviders()).rejects.toMatchObject({ kind: 'closed' });
    await expect(session.setProvider('p')).rejects.toMatchObject({ kind: 'closed' });
    await expect(session.disableProvider()).rejects.toMatchObject({ kind: 'closed' });
    await expect(session.mcpMessage('conn', {})).rejects.toMatchObject({ kind: 'closed' });
  });

  it('handles ops error responses from agent', async () => {
    const session = await startSession({
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: {
          resume: {},
          list: {},
          delete: {},
          fork: {},
        },
      },
    });
    const t = lastTransport();
    const replyError = async <T>(method: string, action: Promise<T>): Promise<void> => {
      await new Promise((r) => setImmediate(r));
      const req = t.sent.findLast((m) => m.method === method);
      expect(req).toBeDefined();
      // An ACP agent returns an error either as msg.error or as a JsonRpcError in result
      t.respond(req!.id!, method, { code: -32603, message: `${method} error` });
      await expect(action).rejects.toMatchObject({ kind: 'prompt_failed' });
    };

    await replyError('session/load', session.loadSession('s' as never));
    await replyError('session/resume', session.resumeSession('s' as never));
    await replyError('session/list', session.listSessions());
    await replyError('session/delete', session.deleteSession('s' as never));
    await replyError('session/fork', session.forkSession('s' as never));
    await replyError('session/set_mode', session.setMode('s' as never, 'code'));
    await replyError('session/set_config_option', session.setConfigOption('s' as never, 'c', 'v'));
    await replyError('providers/list', session.listProviders());
    await replyError('providers/set', session.setProvider('p'));
    await replyError('providers/disable', session.disableProvider());
    await replyError('mcp/message', session.mcpMessage('c', {}));

    // Fork returning empty sessionId
    const forkP = session.forkSession('s' as never);
    await new Promise((r) => setImmediate(r));
    const forkReq = t.sent.findLast((m) => m.method === 'session/fork');
    t.respond(forkReq!.id!, 'session/fork', { sessionId: '' });
    await expect(forkP).rejects.toMatchObject({ kind: 'protocol_error' });

    await session.close();
  });

  it('rejects pending requests when session is closed', async () => {
    const session = await startSession();
    const t = lastTransport();
    // Start a prompt but close before response
    const promptP = session.prompt([textContent('hello')], new AbortController().signal);
    await new Promise((r) => setImmediate(r));
    const newReq = t.sent.find((m) => m.method === 'session/new');
    t.respond(newReq!.id!, 'session/new', { sessionId: 's1' });
    await new Promise((r) => setImmediate(r));
    // Now session/prompt is pending
    const closePromise = session.close();
    await expect(promptP).rejects.toMatchObject({ kind: 'prompt_failed' });
    await closePromise;
  });

  // `session/new` is the wire trust boundary: a result that is not a
  // non-empty string must be rejected before it is branded as a SessionId.
  it('rejects a session/new that returns a non-string or empty session id', async () => {
    const session = await startSession();
    const t = lastTransport();
    const promptP = session.prompt([textContent('hello')], new AbortController().signal);
    await new Promise((r) => setImmediate(r));
    const newMsg = t.sent.find((m) => m.method === 'session/new');
    t.respond(newMsg!.id!, 'session/new', { sessionId: '' });
    // Error.message is non-enumerable, so assert kind via toMatchObject and
    // read the message off the rejection itself. The guard that actually fires
    // is executeCreateSession's, one layer down in acp-session-ops.ts.
    await expect(promptP).rejects.toMatchObject({ kind: 'protocol_error' });
    await promptP.catch((e: unknown) => {
      expect((e as Error).message).toBe('session/new returned no sessionId');
    });
    await session.close();
  });

  it('rejects image and audio content when the agent advertises no such capability', async () => {
    // No promptCapabilities at all: `caps?.image` / `caps?.audio` are
    // undefined, so the gate must reject rather than fall through to `true`.
    const session = await startSession({
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
      agentInfo: { name: 'fake-agent', title: 'Fake', version: '0.0.1' },
    });
    await expect(
      session.prompt(
        [{ type: 'image', mimeType: 'image/png', data: 'AAAA' }],
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ kind: 'unsupported_capability' });
    await expect(
      session.prompt(
        [{ type: 'audio', mimeType: 'audio/wav', data: 'AAAA' }],
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ kind: 'unsupported_capability' });
    await session.close();
  });

  // An unsupported method that carries an id must get a method-not-found
  // error response, and a transport failure while sending it must not escape
  // as an unhandled rejection (the fire-and-forget `.catch`).
  it('answers an unsupported method with an error even when the send fails', async () => {
    const session = await startSession();
    const t = lastTransport();
    t.sent.length = 0;
    (t as unknown as { send: () => Promise<void> }).send = () =>
      Promise.reject(new Error('wire is gone'));

    t.emit({ jsonrpc: '2.0', id: 'unknown-1', method: 'totally/unknown' } as never as ACPMessage);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // No throw escaped the pump despite the rejecting send.
    expect(true).toBe(true);
    await session.close();
  });

  it('handles agent error in session/prompt and JSON-RPC error response in handleMessage', async () => {
    const session = await startSession();
    const t = lastTransport();
    const promptP = session.prompt([textContent('hello')], new AbortController().signal);
    await new Promise((r) => setImmediate(r));
    const newReq = t.sent.find((m) => m.method === 'session/new');
    t.respond(newReq!.id!, 'session/new', { sessionId: 's1' });
    await new Promise((r) => setImmediate(r));
    const promptReq = t.sent.find((m) => m.method === 'session/prompt');
    // Reply with a JSON-RPC error directly
    t.respondError(promptReq!.id!, 'session/prompt', { code: -32000, message: 'Agent crashed' });
    await expect(promptP).rejects.toMatchObject({
      kind: 'prompt_failed',
      message: expect.stringContaining('Agent crashed'),
    });
    await session.close();
  });

  it('handles session/new returning JSON-RPC error or empty sessionId', async () => {
    const session = await startSession();
    const t = lastTransport();
    const promptP = session.prompt([textContent('test')], new AbortController().signal);
    await new Promise((r) => setImmediate(r));
    const newReq = t.sent.find((m) => m.method === 'session/new');
    t.respond(newReq!.id!, 'session/new', { code: -32603, message: 'cannot create' });
    await expect(promptP).rejects.toMatchObject({
      kind: 'session_create_failed',
      message: expect.stringContaining('cannot create'),
    });

    const promptP2 = session.prompt([textContent('test2')], new AbortController().signal);
    await new Promise((r) => setImmediate(r));
    const newReq2 = t.sent.findLast((m) => m.method === 'session/new');
    t.respond(newReq2!.id!, 'session/new', { sessionId: '' });
    await expect(promptP2).rejects.toMatchObject({
      kind: 'protocol_error',
      message: expect.stringContaining('returned no sessionId'),
    });
    await session.close();
  });

  it('closeSession closes an active sessionId on session/load or session/resume', async () => {
    const session = await startSession({
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { close: {}, resume: {} },
      },
    });
    const t = lastTransport();
    const answered = new Set<string | number>();
    const answer = async (method: string, result: unknown = {}) => {
      for (let i = 0; i < 50; i++) {
        const req = t.sent.find((m) => m.method === method && !answered.has(m.id!));
        if (req) {
          answered.add(req.id!);
          t.respond(req.id!, method, result);
          return req;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`Timed out waiting for unanswered request: ${method}`);
    };

    // 1. Initial load
    const load1P = session.loadSession('s1' as never);
    await answer('session/load');
    await load1P;
    expect(session.getSessionId()).toBe('s1');

    // 2. Second load: triggers session/close for s1, then session/load for s2
    const load2P = session.loadSession('s2' as never);
    await answer('session/close');
    await answer('session/load');
    await load2P;
    expect(session.getSessionId()).toBe('s2');

    // 3. Resume: triggers session/close for s2, then session/resume for s3
    const resumeP = session.resumeSession('s3' as never);
    await answer('session/close');
    await answer('session/resume');
    await resumeP;
    expect(session.getSessionId()).toBe('s3');

    const closeP = session.close();
    await answer('session/close');
    await closeP;
  });

  it('accepts replayed session/update notifications streamed during session/load and resets scratch on session/resume', async () => {
    const session = await startSession({
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { close: {}, resume: {} },
      },
    });
    const t = lastTransport();

    const loadP = session.loadSession('sess_replay' as never);
    await new Promise((r) => setImmediate(r));
    const loadReq = t.sent.find((m) => m.method === 'session/load')!;
    expect(loadReq).toBeDefined();

    // Agent streams replayed history before returning the session/load response
    t.emit({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'sess_replay',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'replayed-turn' },
        },
      },
    } as never as ACPMessage);
    t.respond(loadReq.id!, 'session/load', { sessionId: 'sess_replay' });
    await loadP;

    const internal = session as unknown as { scratch: { text: string } };
    expect(internal.scratch.text).toBe('replayed-turn');

    const resumeP = session.resumeSession('sess_resumed' as never);
    await new Promise((r) => setImmediate(r));
    const closeReq = t.sent.find((m) => m.method === 'session/close')!;
    t.respond(closeReq.id!, 'session/close', {});
    await new Promise((r) => setImmediate(r));
    const resumeReq = t.sent.find((m) => m.method === 'session/resume')!;
    t.emit({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'sess_resumed',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'resume-warning-chunk' },
        },
      },
    } as never as ACPMessage);
    t.respond(resumeReq.id!, 'session/resume', { sessionId: 'sess_resumed' });
    await resumeP;

    expect(internal.scratch.text).toBe('resume-warning-chunk');
    const closeP = session.close();
    await new Promise((r) => setImmediate(r));
    const finalCloseReq = t.sent.filter((m) => m.method === 'session/close').at(-1)!;
    t.respond(finalCloseReq.id!, 'session/close', {});
    await closeP;
  });
});
