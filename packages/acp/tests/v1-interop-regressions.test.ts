import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACPProtocolHandler, type ProtocolHandlerOptions } from '../src/agent/protocol-handler.js';
import { serverAgentTurnCoverage } from '../src/agent/server-agent-turn.js';
import { ACPSessionStore } from '../src/agent/session-store.js';
import { WsBridgeTransport } from '../src/agent/ws-bridge-transport.js';
import { ACPSession } from '../src/client/acp-session.js';
import { handleAcpFsRequest } from '../src/client/acp-session-callbacks.js';
import { createSessionScratch, handleAcpSessionUpdate } from '../src/client/acp-session-updates.js';
import { FileServer } from '../src/client/file-server.js';
import { type AnyMessage, client, agent as sdkAgent } from '../src/sdk-unstable.js';
import type { ACPMessage } from '../src/types/acp-messages.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function connect(options: Partial<ProtocolHandlerOptions> = {}) {
  let receiver!: ReadableStreamDefaultController<AnyMessage>;
  const readable = new ReadableStream<AnyMessage>({
    start(c) {
      receiver = c;
    },
  });
  const transport = new WsBridgeTransport((m) => receiver.enqueue(JSON.parse(JSON.stringify(m))));
  const handler = new ACPProtocolHandler({
    transport,
    defaultCwd: process.cwd(),
    runTurn: async () => ({ stopReason: 'end_turn' }),
    ...options,
  });
  const updates: unknown[] = [];
  const connection = client()
    .onNotification('session/update', ({ params }) => {
      updates.push(params);
    })
    .connect({
      readable,
      writable: new WritableStream<AnyMessage>({
        write(m) {
          transport.receive(m as ACPMessage);
          void handler.handleMessage(m);
        },
      }),
    });
  cleanups.push(() => {
    handler.close();
    connection.close();
    transport.close();
  });
  return { agent: connection.agent, updates };
}

describe('official SDK v1 interoperability', () => {
  it('rebuilds client MCP configuration on reload, including an explicit empty list', async () => {
    const disposeFor = vi.fn();
    const seedFor = vi.fn();
    const history = [
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'prior turn' } },
    ];
    const runTurn = vi.fn(async () => ({ stopReason: 'end_turn' as const }));
    const { agent } = connect({ disposeFor, seedFor, replayFor: () => history, runTurn });
    await agent.request('initialize', { protocolVersion: 1 });
    const created = await agent.request('session/new', {
      cwd: process.cwd(),
      mcpServers: [{ name: 'tools', command: 'node', args: ['tools.mjs'], env: [] }],
    });
    await agent.request('session/load', {
      sessionId: created.sessionId,
      cwd: process.cwd(),
      mcpServers: [],
    });
    expect(disposeFor).toHaveBeenCalledWith(created.sessionId);
    expect(seedFor).toHaveBeenCalledWith(created.sessionId, history);
    await agent.request('session/prompt', { sessionId: created.sessionId, prompt: [] });
    expect(runTurn).toHaveBeenCalledWith(
      expect.objectContaining({ mcpServers: [] }),
      expect.any(Function),
      expect.any(Object),
    );
    expect((await agent.request('session/list', { cwd: tmpdir() })).sessions).toEqual([]);
  });

  it('rejects overlapping prompts and cancels the original without corrupting the next turn', async () => {
    let running = false;
    const { agent } = connect({
      runTurn: async ({ signal }) => {
        running = true;
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
        return { stopReason: 'end_turn' };
      },
    });
    await agent.request('initialize', { protocolVersion: 1 });
    const created = await agent.request('session/new', { cwd: process.cwd(), mcpServers: [] });
    const params = { sessionId: created.sessionId, prompt: [] };
    const first = agent.request('session/prompt', params);
    await vi.waitFor(() => expect(running).toBe(true));
    await expect(agent.request('session/prompt', params)).rejects.toThrow('already running');
    await agent.notify('session/cancel', { sessionId: created.sessionId });
    await expect(first).resolves.toEqual({ stopReason: 'cancelled' });
  });

  it('returns SDK-compatible mode state for new, load, fork and resume', async () => {
    const { agent, updates } = connect();
    await agent.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    const created = await agent.request('session/new', { cwd: process.cwd(), mcpServers: [] });
    expect(created.modes?.currentModeId).toBe('code');
    for (const method of ['session/load', 'session/resume', 'session/fork'] as const) {
      const result = await agent.request(method, {
        sessionId: created.sessionId,
        cwd: process.cwd(),
        mcpServers: [],
      });
      expect(result.modes?.currentModeId).toBe('code');
    }
    const modeUpdates = updates.filter(
      (u: any) => u?.update?.sessionUpdate === 'current_mode_update',
    );
    expect(modeUpdates.length).toBeGreaterThan(0);
    expect(modeUpdates[0]).toMatchObject({ update: { currentModeId: 'code' } });
  });

  it('only advertises terminal login to capable clients and never promises a no-op logout', async () => {
    const { agent } = connect();
    const init = await agent.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    // An agent-type method is always offered (the ACP registry requires one);
    // the terminal method is not, because this client did not announce it.
    expect((init.authMethods ?? []).map((m) => m.id)).toEqual(['wrongstack-config']);
    expect((init.authMethods ?? []).some((m) => 'type' in m && m.type === 'terminal')).toBe(false);
    expect(init.agentCapabilities?.auth?.logout).toBeUndefined();
  });

  it('keeps config selections isolated between sessions', async () => {
    const { agent } = connect({
      configOptions: [
        {
          id: 'size',
          name: 'Size',
          type: 'select',
          currentValue: 'small',
          options: [
            { value: 'small', name: 'Small' },
            { value: 'large', name: 'Large' },
          ],
        },
      ],
    });
    await agent.request('initialize', { protocolVersion: 1 });
    const a = await agent.request('session/new', { cwd: process.cwd(), mcpServers: [] });
    const b = await agent.request('session/new', { cwd: process.cwd(), mcpServers: [] });
    await agent.request('session/set_config_option', {
      sessionId: a.sessionId,
      configId: 'size',
      value: 'large',
    });
    const loaded = await agent.request('session/load', {
      sessionId: b.sessionId,
      cwd: process.cwd(),
      mcpServers: [],
    });
    expect(loaded.configOptions?.[0]?.currentValue).toBe('small');
  });

  it('cancels a prompt waiting for a client permission response', async () => {
    const sent: ACPMessage[] = [];
    const transport = new WsBridgeTransport((m) => {
      sent.push(m);
    });
    const handler = new ACPProtocolHandler({
      transport,
      defaultCwd: process.cwd(),
      runTurn: async (_, __, api) => {
        await api!.requestPermission({ toolCall: { toolCallId: 't', title: 'edit' }, options: [] });
        return { stopReason: 'end_turn' };
      },
    });
    cleanups.push(() => handler.close());
    await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
    await handler.handleMessage({
      id: 2,
      method: 'session/new',
      params: { cwd: process.cwd(), mcpServers: [] },
    });
    const created = sent.find((m) => m.id === 2);
    expect(created).toBeDefined();
    const sessionId = (created!.result as { sessionId: string }).sessionId;
    const prompt = handler.handleMessage({
      id: 3,
      method: 'session/prompt',
      params: { sessionId, prompt: [] },
    });
    await vi.waitFor(() =>
      expect(sent.some((m) => m.method === 'session/request_permission')).toBe(true),
    );
    await handler.handleMessage({ method: '$/cancel_request', params: { requestId: 3 } });
    await prompt;
    expect(sent.find((m) => m.id === 3)?.result).toEqual({ stopReason: 'cancelled' });
    expect(sent.some((m) => m.method === '$/cancel_request')).toBe(true);
  });

  it('discovers closed sessions across restart, resumes without replay, and deletes durably', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'acp-interop-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const store = new ACPSessionStore({ dir });
    const first = connect({ store });
    await first.agent.request('initialize', { protocolVersion: 1 });
    const created = await first.agent.request('session/new', {
      cwd: process.cwd(),
      mcpServers: [],
    });
    await first.agent.request('session/close', { sessionId: created.sessionId });
    const second = connect({ store });
    await second.agent.request('initialize', { protocolVersion: 1 });
    expect(
      (await second.agent.request('session/list', {})).sessions.map((s) => s.sessionId),
    ).toContain(created.sessionId);
    await second.agent.request('session/resume', {
      sessionId: created.sessionId,
      cwd: process.cwd(),
      mcpServers: [],
    });
    expect(second.updates).toEqual([]);
    await second.agent.request('session/delete', { sessionId: created.sessionId });
    expect(await store.load(created.sessionId)).toBeNull();
    expect((await second.agent.request('session/list', {})).sessions).toEqual([]);
  });
});

it('honors file line ranges through the actual callback dispatcher', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'acp-range-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'file.txt');
  await writeFile(path, 'one\r\ntwo\r\nthree\r\n');
  let result: unknown;
  await handleAcpFsRequest(
    {
      id: 1,
      method: 'fs/read_text_file',
      params: { sessionId: 's', path, line: 2, limit: 1 },
    } as unknown as ACPMessage,
    new FileServer({ projectRoot: dir }),
    async () => ({ outcome: 'cancelled' }),
    {
      sendResult: async (_, value) => {
        result = value;
      },
      sendErrorResponse: async () => {},
    },
  );
  expect(result).toEqual({ content: 'two\r\n' });
});

it('preserves embedded text in text-only prompts and replay history', () => {
  const blocks = [
    {
      type: 'resource' as const,
      resource: { uri: 'file:///buffer.ts', text: 'unsaved buffer content' },
    },
  ];
  expect(serverAgentTurnCoverage.promptToAgentInput(blocks)).toContain('unsaved buffer content');
  expect(serverAgentTurnCoverage.promptToText(blocks)).toContain('unsaved buffer content');
});

it('captures the official agent_thought_chunk discriminator', () => {
  const scratch = createSessionScratch();
  handleAcpSessionUpdate(
    {
      method: 'session/update',
      params: {
        sessionId: 's',
        update: {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: 'thinking' },
        },
      },
    } as unknown as ACPMessage,
    scratch,
    () => {},
  );
  expect(scratch.thoughts).toBe('thinking');
});

it.each([0, -1, 1.5, 2])('rejects unsupported negotiated protocol version %s', async (version) => {
  let receive: ((message: ACPMessage) => void) | undefined;
  const stop = vi.fn();
  await expect(
    ACPSession.connect(
      {
        start: async () => {},
        stop,
        onMessage: (handler) => {
          receive = handler;
          return () => {};
        },
        send: async (message) => {
          receive?.({ id: message.id, result: { protocolVersion: version } } as ACPMessage);
        },
      },
      { command: 'version-test', projectRoot: process.cwd() },
    ),
  ).rejects.toMatchObject({ kind: 'unsupported_capability' });
  expect(stop).toHaveBeenCalled();
});

it('runs WrongStack as a client of an official SDK agent with callbacks and streaming', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'acp-sdk-agent-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'note.txt');
  await writeFile(file, 'first\nsecond\n');
  let incoming!: ReadableStreamDefaultController<AnyMessage>;
  const handlers = new Set<(m: ACPMessage) => void>();
  const connection = sdkAgent()
    .onRequest('initialize', () => ({ protocolVersion: 1, agentCapabilities: {}, authMethods: [] }))
    .onRequest('session/new', () => ({ sessionId: 'sdk-session' }))
    .onRequest('session/prompt', async ({ params, client: peer }) => {
      const { content } = await peer.request('fs/read_text_file', {
        sessionId: params.sessionId,
        path: file,
        line: 2,
        limit: 1,
      });
      await peer.notify('session/update', {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: 'read file' },
        },
      });
      await peer.notify('session/update', {
        sessionId: params.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: content } },
      });
      await expect(
        peer.request('elicitation/create', {
          sessionId: params.sessionId,
          message: 'unsupported',
          requestedSchema: { type: 'object', properties: {} },
        }),
      ).rejects.toMatchObject({ code: -32601 });
      return { stopReason: 'end_turn' };
    })
    .connect({
      readable: new ReadableStream<AnyMessage>({
        start(c) {
          incoming = c;
        },
      }),
      writable: new WritableStream<AnyMessage>({
        write(m) {
          for (const h of handlers) h(m as ACPMessage);
        },
      }),
    });
  cleanups.push(() => connection.close());
  const session = await ACPSession.connect(
    {
      start: async () => {},
      send: async (m) => {
        incoming.enqueue(m as AnyMessage);
      },
      onMessage: (h) => {
        handlers.add(h);
        return () => {
          handlers.delete(h);
        };
      },
      stop: () => {},
    },
    { command: 'sdk-test', projectRoot: dir, timeoutMs: 3000 },
  );
  cleanups.push(() => session.close());
  const result = await session.prompt(
    [{ type: 'text', text: 'read' }],
    new AbortController().signal,
  );
  expect(result.text).toBe('second\n');
  expect(result.thoughts).toBe('read file');
  await expect(
    session.prompt(
      [{ type: 'image', mimeType: 'image/png', data: 'YQ==' }],
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ kind: 'unsupported_capability' });
});
