/**
 * Slash commands (ACP "Slash Commands"): the agent advertises them with
 * `available_commands_update` once a session is open, and the client sends
 * `/<name> <args>` as an ordinary prompt, which the agent runs as the command.
 */
import type { Agent } from '@wrongstack/core/agent';
import { describe, expect, it, vi } from 'vitest';
import {
  ACPProtocolHandler,
  type AvailableCommand,
  type ProtocolHandlerOptions,
  type RunTurn,
} from '../src/agent/protocol-handler.js';
import { type RunPromptCommand, runPromptCommand } from '../src/agent/server-agent-commands.js';
import { makeACPServerAgentTurn } from '../src/agent/server-agent-turn.js';
import type { AgentServerTransport } from '../src/agent/stdio-transport.js';

const CWD = process.cwd();
const COMMANDS: AvailableCommand[] = [
  { name: 'init', description: 'Write an AGENTS.md for this project' },
  { name: 'git', description: 'Git status and history', input: { hint: 'status | log' } },
];

function makeHandler(opts: Partial<ProtocolHandlerOptions> = {}) {
  const sent: Array<Record<string, unknown>> = [];
  const transport = {
    send: vi.fn(async (m: Record<string, unknown>) => {
      sent.push(m);
    }),
  } as never as AgentServerTransport;
  const handler = new ACPProtocolHandler({
    transport,
    defaultCwd: CWD,
    runTurn: (async () => ({ stopReason: 'end_turn' })) as RunTurn,
    ...opts,
  });
  const call = async (id: number, method: string, params?: unknown) => {
    await handler.handleMessage({ id, method, params });
  };
  return { sent, call };
}

const updatesOf = (sent: Array<Record<string, unknown>>, kind: string) =>
  sent.filter(
    (m) =>
      m['method'] === 'session/update' &&
      (m['params'] as { update?: { sessionUpdate?: string } }).update?.sessionUpdate === kind,
  );

describe('available_commands_update', () => {
  it('announces the session’s commands after the session/new response', async () => {
    const sessionCommands = vi.fn(async () => COMMANDS);
    const { sent, call } = makeHandler({ sessionCommands });
    await call(1, 'initialize', { protocolVersion: 1 });
    await call(2, 'session/new', { cwd: CWD, mcpServers: [] });
    const responseAt = sent.findIndex((m) => m['id'] === 2);
    const [update] = updatesOf(sent, 'available_commands_update');
    expect(update).toBeDefined();
    expect(sent.indexOf(update as Record<string, unknown>)).toBeGreaterThan(responseAt);
    const params = (update as { params: { sessionId: string; update: unknown } }).params;
    expect(sessionCommands).toHaveBeenCalledWith(params.sessionId);
    expect(params.update).toEqual({
      sessionUpdate: 'available_commands_update',
      availableCommands: [
        { name: 'init', description: 'Write an AGENTS.md for this project' },
        { name: 'git', description: 'Git status and history', input: { hint: 'status | log' } },
      ],
    });
  });

  it('announces nothing for an empty list or a failing builder, and the session still opens', async () => {
    for (const sessionCommands of [
      async () => [],
      async () => {
        throw new Error('no commands');
      },
    ]) {
      const { sent, call } = makeHandler({ sessionCommands });
      await call(1, 'initialize', { protocolVersion: 1 });
      await call(2, 'session/new', { cwd: CWD, mcpServers: [] });
      expect(updatesOf(sent, 'available_commands_update')).toEqual([]);
      const created = sent.find((m) => m['id'] === 2) as { result?: { sessionId?: string } };
      expect(created.result?.sessionId).toMatch(/^sess_/);
    }
  });
});

describe('which prompts name a command', () => {
  const ask = async (text: string) => {
    const run = vi.fn<RunPromptCommand>(async () => ({ message: 'ok' }));
    const outcome = await runPromptCommand(
      run,
      {} as never as Agent,
      { sessionId: 's1', prompt: [{ type: 'text', text }], signal: new AbortController().signal },
      { signal: new AbortController().signal, emit: () => {} },
    );
    return { outcome, call: run.mock.calls[0]?.[2] };
  };
  it('reads a leading /name and its arguments', async () => {
    expect((await ask('/git log -5')).call).toEqual({ name: 'git', args: 'log -5' });
    expect((await ask('  /init  ')).call).toEqual({ name: 'init', args: '' });
  });
  it('leaves prompts that only start with a slash alone', async () => {
    for (const text of ['/usr/bin/node crashes on start', 'why does /init fail?', '/']) {
      const { outcome, call } = await ask(text);
      expect(outcome, text).toEqual({ kind: 'none' });
      expect(call, text).toBeUndefined();
    }
  });
});

describe('a prompt that names a command', () => {
  function turnWith(runCommand: RunPromptCommand) {
    const agentRun = vi.fn(async (_input: unknown) => ({
      status: 'done',
      iterations: 1,
      finalText: 'model reply',
    }));
    const turn = makeACPServerAgentTurn({
      agentFor: async () => ({ run: agentRun, teardown: vi.fn() }) as never as Agent,
      runCommand,
    });
    const updates: Array<{ sessionUpdate: string; content?: { text?: string } }> = [];
    const run = (prompt: Array<Record<string, unknown>>, signal = new AbortController().signal) =>
      turn({ sessionId: 's1', prompt: prompt as never, signal, cwd: CWD }, (u) =>
        updates.push(u as never),
      );
    return { run, updates, agentRun };
  }

  it('runs the command instead of a model turn and sends its message', async () => {
    const runCommand = vi.fn<RunPromptCommand>(async (_agent, _session, command) =>
      command.name === 'git' ? { message: `git ${command.args}: clean` } : undefined,
    );
    const { run, updates, agentRun } = turnWith(runCommand);
    await expect(run([{ type: 'text', text: '/git status' }])).resolves.toEqual({
      stopReason: 'end_turn',
    });
    expect(runCommand).toHaveBeenCalledWith(
      expect.anything(),
      's1',
      { name: 'git', args: 'status' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(updates).toEqual([
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'git status: clean' },
      },
    ]);
    expect(agentRun).not.toHaveBeenCalled();
  });

  it('runs an unknown /name as an ordinary prompt', async () => {
    const { run, agentRun } = turnWith(async () => undefined);
    await run([{ type: 'text', text: '/nonesuch please' }]);
    expect(agentRun).toHaveBeenCalledTimes(1);
  });

  it('follows a command’s runText with a model turn that keeps the other blocks', async () => {
    const { run, updates, agentRun } = turnWith(async () => ({
      message: 'Planning…',
      runText: 'Write the plan for X',
    }));
    const image = { type: 'image', mimeType: 'image/png', data: 'AA==' };
    await run([{ type: 'text', text: '/plan X' }, image]);
    expect(updates[0]).toEqual({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Planning…' },
    });
    expect(agentRun).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(agentRun.mock.calls[0]?.[0])).toContain('Write the plan for X');
    expect(JSON.stringify(agentRun.mock.calls[0]?.[0])).not.toContain('/plan X');
  });

  it('ends cancelled when the client cancels during the command', async () => {
    const stop = new AbortController();
    const { run, updates } = turnWith(async () => {
      stop.abort();
      return { message: 'too late' };
    });
    await expect(run([{ type: 'text', text: '/git' }], stop.signal)).resolves.toEqual({
      stopReason: 'cancelled',
    });
    expect(updates).toEqual([]);
  });

  it('cuts a very long message with a note', async () => {
    const { run, updates } = turnWith(async () => ({ message: 'x'.repeat(70_000) }));
    await run([{ type: 'text', text: '/git' }]);
    expect(updates[0]?.content?.text).toMatch(/… \(6000 more characters\)$/);
  });

  it('never splits an astral character at the message-limit cut', async () => {
    // Round r4-20261111-acp-surrogate-cut-b7e2: the raw
    // message.slice(0, MESSAGE_LIMIT) used to cut between the two UTF-16
    // units of an emoji straddling the boundary, leaving a lone high
    // surrogate in the emitted frame. JSON carries it to the wire as a
    // \udXXX escape, and strict ACP client parsers reject such a frame
    // outright — the editor lost the WHOLE message, not the tail. The cut
    // now walks back one unit, the same no-lone-surrogate contract the
    // shared primitives.truncate pins.
    const message = `${'a'.repeat(63_999)}\u{1F600}${'b'.repeat(10)}`;
    const { run, updates } = turnWith(async () => ({ message }));
    await run([{ type: 'text', text: '/git' }]);
    const text = updates[0]?.content?.text ?? '';
    expect(text).toMatch(/\n… \(12 more characters\)$/);
    expect(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text),
      'emitted message must carry no unpaired surrogate',
    ).toBe(false);
  });

  it('keeps the command exchange for replay and for the model’s next turn', async () => {
    const appendMessage = vi.fn();
    const turn = makeACPServerAgentTurn({
      agentFor: async () =>
        ({ run: vi.fn(), teardown: vi.fn(), ctx: { state: { appendMessage } } }) as never as Agent,
      runCommand: async () => ({ message: 'On branch main, clean' }),
    });
    await turn(
      {
        sessionId: 's2',
        prompt: [{ type: 'text', text: '/git status' }],
        signal: new AbortController().signal,
        cwd: CWD,
      },
      () => {},
    );
    expect(turn.replay('s2')).toEqual([
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '/git status' } },
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'On branch main, clean' },
      },
    ]);
    expect(appendMessage.mock.calls.map(([m]) => m)).toEqual([
      { role: 'user', content: '/git status' },
      { role: 'assistant', content: 'On branch main, clean' },
    ]);
  });
});
