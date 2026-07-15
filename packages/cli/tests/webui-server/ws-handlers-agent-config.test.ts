import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import type { AgentConfigContext } from '../../src/webui-server/ws-handlers/agent-config.js';
import type { WsServerMessage } from '../../src/webui-server/ws-handlers/index.js';
import {
  handleModelRefine,
  handleModelSwitch,
  handleModeSwitch,
  handleModesList,
} from '../../src/webui-server/ws-handlers/index.js';

/**
 * PR 5e of Issue #30: agent-config ws-handler unit tests.
 *
 * modes/mode.switch run against a stub mode store; model.switch/refine
 * use a fake agent ctx. buildSessionStart is a spy so no real
 * session.start payload is constructed.
 */

const FAKE_WS = {} as WebSocket;

function makeModeStore(modes: Array<{ id: string; name: string; description: string }>) {
  let active: string | null = null;
  return {
    listModes: async () => modes,
    getActiveMode: async () => (active ? modes.find((m) => m.id === active) : null),
    getMode: async (id: string) => modes.find((m) => m.id === id) ?? null,
    setActiveMode: async (id: string | null) => {
      active = id;
    },
    _active: () => active,
  };
}

function makeCtx(over: Partial<AgentConfigContext> = {}): {
  ctx: AgentConfigContext;
  sent: WsServerMessage[];
  bc: WsServerMessage[];
  builtWith: Array<Record<string, unknown> | undefined>;
  agentCtx: {
    meta: Record<string, unknown>;
    model: string;
    provider: unknown;
    messages: unknown[];
  };
} {
  const sent: WsServerMessage[] = [];
  const bc: WsServerMessage[] = [];
  const builtWith: Array<Record<string, unknown> | undefined> = [];
  const agentCtx = {
    meta: {} as Record<string, unknown>,
    model: 'old-model',
    provider: {},
    messages: [],
  };
  const ctx: AgentConfigContext = {
    agent: { ctx: agentCtx } as never,
    modeStore: undefined,
    globalConfigPath: undefined,
    buildSessionStart: async (o) => {
      builtWith.push(o);
      return { sessionStart: true, o };
    },
    send: (_ws, m) => sent.push(m),
    broadcast: (m) => bc.push(m),
    log: () => {},
    ...over,
  };
  return { ctx, sent, bc, builtWith, agentCtx };
}

const result = (sent: WsServerMessage[]) =>
  sent.filter((m) => m.type === 'key.operation_result').at(-1)?.payload as
    | { success: boolean; message: string }
    | undefined;
const lastOf = (msgs: WsServerMessage[], type: string) =>
  msgs.filter((m) => m.type === type).at(-1);

describe('handleModesList', () => {
  it('errors when no mode store is wired', async () => {
    const { ctx, sent } = makeCtx({ modeStore: undefined });
    await handleModesList(ctx, FAKE_WS);
    expect(lastOf(sent, 'modes.list')?.payload).toMatchObject({
      error: 'Mode store not available',
    });
  });

  it('lists modes and marks the active one', async () => {
    const store = makeModeStore([
      { id: 'plan', name: 'Plan', description: 'planning' },
      { id: 'build', name: 'Build', description: 'building' },
    ]);
    await store.setActiveMode('build');
    const { ctx, sent } = makeCtx({ modeStore: store as never });
    await handleModesList(ctx, FAKE_WS);
    const p = lastOf(sent, 'modes.list')?.payload as {
      modes: Array<{ id: string; isActive: boolean }>;
      activeId: string;
    };
    expect(p.activeId).toBe('build');
    expect(p.modes.find((m) => m.id === 'build')?.isActive).toBe(true);
  });
});

describe('handleModeSwitch', () => {
  it('rejects when no mode store is wired', async () => {
    const { ctx, sent } = makeCtx({ modeStore: undefined });
    await handleModeSwitch(ctx, FAKE_WS, 'plan');
    expect(result(sent)).toMatchObject({ success: false });
  });

  it('switches to a known mode, sets meta, broadcasts session.start', async () => {
    const store = makeModeStore([{ id: 'plan', name: 'Plan', description: 'p' }]);
    const { ctx, sent, bc, builtWith, agentCtx } = makeCtx({ modeStore: store as never });
    await handleModeSwitch(ctx, FAKE_WS, 'plan');
    expect(result(sent)?.success).toBe(true);
    expect(agentCtx.meta['mode']).toBe('plan');
    expect(store._active()).toBe('plan');
    expect(builtWith).toEqual([{ mode: 'plan' }]);
    expect(lastOf(bc, 'session.start')).toBeDefined();
  });

  it('switching to default clears the active mode', async () => {
    const store = makeModeStore([{ id: 'plan', name: 'Plan', description: 'p' }]);
    await store.setActiveMode('plan');
    const { ctx } = makeCtx({ modeStore: store as never });
    await handleModeSwitch(ctx, FAKE_WS, 'default');
    expect(store._active()).toBeNull();
  });

  it('rejects an unknown mode', async () => {
    const store = makeModeStore([{ id: 'plan', name: 'Plan', description: 'p' }]);
    const { ctx, sent } = makeCtx({ modeStore: store as never });
    await handleModeSwitch(ctx, FAKE_WS, 'nope');
    expect(result(sent)?.success).toBe(false);
    expect(result(sent)?.message).toContain('Unknown mode');
  });
});

describe('handleModelSwitch', () => {
  it('updates ctx.model and emits a result', async () => {
    const { ctx, sent, agentCtx } = makeCtx({ globalConfigPath: undefined });
    await handleModelSwitch(ctx, FAKE_WS, { provider: 'anthropic', model: 'claude-test' });
    // model is set before the provider step, regardless of provider construction outcome
    expect(agentCtx.model).toBe('claude-test');
    expect(result(sent)).toBeDefined();
  });

  it('delegates resolved maxContext to the host callback without duplicate broadcast', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-webui-agent-config-'));
    const configPath = path.join(tmp, 'config.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        providers: {
          local: {
            family: 'openai-compatible',
            baseUrl: 'http://127.0.0.1:1234/v1',
            apiKey: 'test-key',
          },
        },
      }),
    );
    const onMaxContextResolved = vi.fn();
    const modelsRegistry = {
      refresh: async () => undefined,
      getModel: async () => ({ capabilities: { maxContext: 1_000_000 } }),
    } as never;
    const { ctx, bc } = makeCtx({
      globalConfigPath: configPath,
      modelsRegistry,
      onMaxContextResolved,
    });

    await handleModelSwitch(ctx, FAKE_WS, { provider: 'local', model: 'local-model' });

    expect(onMaxContextResolved).toHaveBeenCalledWith('local', 'local-model', 1_000_000);
    expect(lastOf(bc, 'ctx.max_context')).toBeUndefined();
    expect(lastOf(bc, 'session.start')).toBeDefined();
    await fs.rm(tmp, { recursive: true, force: true });
  });
});

describe('handleModelRefine', () => {
  it('rejects empty text without calling the provider', async () => {
    const { ctx, sent } = makeCtx();
    await handleModelRefine(ctx, FAKE_WS, { text: '   ' });
    expect(lastOf(sent, 'model.refine_result')?.payload).toMatchObject({ error: 'Empty text' });
  });

  it('forwards a gated low-effort reasoning hint resolved from the registry', async () => {
    let captured: { reasoning?: unknown } | undefined;
    const provider = {
      id: 'openai',
      capabilities: { reasoning: true } as never,
      stream: () => (async function* () {})(),
      complete: async (req: { reasoning?: unknown }) => {
        captured = req;
        return {
          content: [{ type: 'text', text: 'Refined.' }],
          stopReason: 'end_turn',
          usage: { input: 1, output: 1 },
          model: 'gpt-x',
        };
      },
    };
    const modelsRegistry = {
      getModel: async () => ({
        capabilities: {
          reasoningConfig: {
            default: 'adaptive',
            disableSupported: false,
            effortSupported: true,
            effortLevels: ['low', 'medium', 'high'],
            preserveThinking: 'unsupported',
          },
        },
      }),
    } as never;
    const { ctx, sent, agentCtx } = makeCtx({ modelsRegistry });
    agentCtx.provider = provider;
    agentCtx.model = 'gpt-x';
    await handleModelRefine(ctx, FAKE_WS, { text: 'please refine this text' });
    expect(captured?.reasoning).toEqual({ effort: 'low' });
    expect(lastOf(sent, 'model.refine_result')?.payload).toMatchObject({
      refined: 'Refined.',
      english: 'Refined.',
    });
  });

  it('reports the failure kind and offers a fallback ref on a provider error', async () => {
    const provider = {
      id: 'openai',
      capabilities: { reasoning: true } as never,
      stream: () => (async function* () {})(),
      complete: async () => {
        throw new Error('upstream 500');
      },
    };
    const { ctx, sent, agentCtx } = makeCtx({
      getConfig: () =>
        ({
          provider: 'openai',
          model: 'gpt-x',
          providers: {},
          fallbackModels: ['anthropic/claude-haiku-4-5'],
        }) as never,
    });
    agentCtx.provider = provider;
    agentCtx.model = 'gpt-x';
    await handleModelRefine(ctx, FAKE_WS, { text: 'please refine this text' });
    expect(lastOf(sent, 'model.refine_result')?.payload).toMatchObject({
      refined: 'please refine this text',
      english: 'please refine this text',
      errorKind: 'provider_error',
      fallbackRef: 'anthropic/claude-haiku-4-5',
    });
  });

  it('never offers the live model as its own fallback ref', async () => {
    const provider = {
      id: 'openai',
      capabilities: { reasoning: true } as never,
      stream: () => (async function* () {})(),
      complete: async () => {
        throw new Error('nope');
      },
    };
    const { ctx, sent, agentCtx } = makeCtx({
      // The only configured fallback IS the active model → must resolve to none.
      getConfig: () =>
        ({
          provider: 'openai',
          model: 'gpt-x',
          providers: {},
          fallbackModels: ['openai/gpt-x'],
        }) as never,
    });
    agentCtx.provider = provider;
    agentCtx.model = 'gpt-x';
    await handleModelRefine(ctx, FAKE_WS, { text: 'please refine this text' });
    const payload = lastOf(sent, 'model.refine_result')?.payload as { fallbackRef?: string };
    expect(payload.fallbackRef).toBeUndefined();
  });

  it('sends no reasoning field when no registry is wired', async () => {
    let captured: { reasoning?: unknown } | undefined;
    const provider = {
      id: 'openai',
      capabilities: { reasoning: true } as never,
      stream: () => (async function* () {})(),
      complete: async (req: { reasoning?: unknown }) => {
        captured = req;
        return {
          content: [{ type: 'text', text: 'Refined.' }],
          stopReason: 'end_turn',
          usage: { input: 1, output: 1 },
          model: 'gpt-x',
        };
      },
    };
    const { ctx, agentCtx } = makeCtx(); // no modelsRegistry
    agentCtx.provider = provider;
    await handleModelRefine(ctx, FAKE_WS, { text: 'please refine this text' });
    expect(captured?.reasoning).toBeUndefined();
  });
});
