/**
 * Per-session config options (`ProtocolHandlerOptions.sessionConfigOptions`):
 * the hook a host uses to offer a model picker whose values depend on what is
 * configured when the session opens.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  ACPProtocolHandler,
  type ProtocolHandlerOptions,
  type RunTurn,
  type SessionConfigOption,
  type SessionState,
} from '../src/agent/protocol-handler.js';
import type { AgentServerTransport } from '../src/agent/stdio-transport.js';

const CWD = process.cwd();
const RUN_TURN: RunTurn = async () => ({ stopReason: 'end_turn' });

function modelOption(currentValue = 'openai/gpt-x'): SessionConfigOption {
  return {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue,
    options: [
      {
        group: 'openai',
        name: 'openai',
        options: [
          { value: 'openai/gpt-x', name: 'GPT X' },
          { value: 'openai/gpt-y', name: 'GPT Y' },
        ],
      },
      {
        group: 'openrouter',
        name: 'openrouter',
        options: [{ value: 'openrouter/a/b', name: 'a/b' }],
      },
    ],
  };
}

function memoryStore() {
  const saved = new Map<string, Partial<SessionState>>();
  return {
    saved,
    save: vi.fn(async (state: SessionState) => {
      saved.set(state.id, structuredClone({ ...state, abort: undefined }) as never);
    }),
    load: vi.fn(async (id: string) => (saved.get(id) as never) ?? null),
  };
}

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
    runTurn: RUN_TURN,
    ...opts,
  });
  const call = async (id: number, method: string, params?: unknown) => {
    await handler.handleMessage({ id, method, params });
    return sent.findLast((m) => m['id'] === id) as {
      result?: Record<string, unknown>;
      error?: { code: number; message: string };
    };
  };
  return { handler, sent, call };
}

describe('session config options built per session', () => {
  it('appends the host options to session/new, after the static ones', async () => {
    const builder = vi.fn(async () => [modelOption()]);
    const { call } = makeHandler({
      configOptions: [
        {
          id: 'size',
          name: 'Size',
          type: 'select',
          currentValue: 's',
          options: [{ value: 's', name: 'S' }],
        },
      ],
      sessionConfigOptions: builder,
    });
    await call(1, 'initialize', { protocolVersion: 1 });
    const created = await call(2, 'session/new', { cwd: CWD, mcpServers: [] });
    const ids = ((created.result?.['configOptions'] ?? []) as SessionConfigOption[]).map(
      (o) => o.id,
    );
    expect(ids).toEqual(['size', 'model']);
    expect(builder).toHaveBeenCalledTimes(1);
  });

  it('opens the session without the extra options when the builder fails', async () => {
    const { call } = makeHandler({
      sessionConfigOptions: async () => {
        throw new Error('catalog offline');
      },
    });
    await call(1, 'initialize', { protocolVersion: 1 });
    const created = await call(2, 'session/new', { cwd: CWD, mcpServers: [] });
    expect(created.result?.['sessionId']).toEqual(expect.stringMatching(/^sess_/));
    expect(created.result?.['configOptions']).toEqual([]);
  });

  it('accepts a value from any group and rejects one no group offers', async () => {
    const { call } = makeHandler({ sessionConfigOptions: async () => [modelOption()] });
    await call(1, 'initialize', { protocolVersion: 1 });
    const { result } = await call(2, 'session/new', { cwd: CWD, mcpServers: [] });
    const sessionId = result?.['sessionId'];

    const switched = await call(3, 'session/set_config_option', {
      sessionId,
      configId: 'model',
      value: 'openrouter/a/b',
    });
    const options = switched.result?.['configOptions'] as SessionConfigOption[];
    expect(options[0]?.currentValue).toBe('openrouter/a/b');

    const bogus = await call(4, 'session/set_config_option', {
      sessionId,
      configId: 'model',
      value: 'openai/not-offered',
    });
    expect(bogus.error?.code).toBe(-32602);
  });

  it('hands the selection to the turn', async () => {
    const seen: string[] = [];
    const { call } = makeHandler({
      sessionConfigOptions: async () => [modelOption()],
      runTurn: async (input) => {
        seen.push(input.configOptions?.[0]?.currentValue ?? 'none');
        return { stopReason: 'end_turn' };
      },
    });
    await call(1, 'initialize', { protocolVersion: 1 });
    const { result } = await call(2, 'session/new', { cwd: CWD, mcpServers: [] });
    const sessionId = result?.['sessionId'];
    await call(3, 'session/set_config_option', {
      sessionId,
      configId: 'model',
      value: 'openai/gpt-y',
    });
    await call(4, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hi' }] });
    expect(seen).toEqual(['openai/gpt-y']);
  });

  it('rebuilds the options on a cold load and keeps the saved selection only while it is offered', async () => {
    const store = memoryStore();
    const first = makeHandler({ store, sessionConfigOptions: async () => [modelOption()] });
    await first.call(1, 'initialize', { protocolVersion: 1 });
    const { result } = await first.call(2, 'session/new', { cwd: CWD, mcpServers: [] });
    const sessionId = result?.['sessionId'] as string;
    await first.call(3, 'session/set_config_option', {
      sessionId,
      configId: 'model',
      value: 'openai/gpt-y',
    });

    // Restart: same store, the saved choice is still offered.
    const second = makeHandler({ store, sessionConfigOptions: async () => [modelOption()] });
    await second.call(1, 'initialize', { protocolVersion: 1 });
    const kept = await second.call(2, 'session/load', { sessionId, cwd: CWD, mcpServers: [] });
    expect(((kept.result?.['configOptions'] ?? []) as SessionConfigOption[])[0]?.currentValue).toBe(
      'openai/gpt-y',
    );

    // Restart again: that provider's key was removed, so the model is gone.
    const narrowed: SessionConfigOption = {
      ...modelOption(),
      options: [
        { group: 'openai', name: 'openai', options: [{ value: 'openai/gpt-x', name: 'X' }] },
      ],
    };
    const third = makeHandler({ store, sessionConfigOptions: async () => [narrowed] });
    await third.call(1, 'initialize', { protocolVersion: 1 });
    const reset = await third.call(2, 'session/load', { sessionId, cwd: CWD, mcpServers: [] });
    expect(
      ((reset.result?.['configOptions'] ?? []) as SessionConfigOption[])[0]?.currentValue,
    ).toBe('openai/gpt-x');
  });
});
