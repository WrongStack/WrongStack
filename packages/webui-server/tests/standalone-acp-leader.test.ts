/**
 * The standalone engine (WebUI server / desktop) leads with an ACP agent the
 * way the CLI does: `provider: "acp"` resolves to the ACP leader provider at
 * boot and on a switch (without the catalog overlay), the pickers offer it, its
 * turns run against this engine's host services (each tab's own agent), and the
 * agent sessions close on shutdown. No real agent process: `@wrongstack/acp` is
 * a fake.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventBus } from '@wrongstack/contracts/kernel';
import type {
  Config,
  ModelsRegistry,
  Provider,
  StreamEvent,
  Tool,
} from '@wrongstack/contracts/types';
import { ProviderRegistry } from '@wrongstack/core/registry';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const acp = vi.hoisted(() => ({
  starts: [] as Array<Record<string, unknown>>,
  prompts: [] as string[],
  closes: [] as Array<{ graceMs?: number }>,
}));

// `@wrongstack/acp` is not a dependency of this package, so its bare id does not
// resolve from here: mock the module the runtime's import resolves to instead.
vi.mock('../../acp/dist/index.js', () => ({
  textContent: (text: string) => ({ type: 'text', text }),
  findAgentDescriptor: (id: string) =>
    id === 'claude-code' ? { id, displayName: 'Claude Code', contextWindow: 1_000_000 } : undefined,
  resolveAcpAgentCommand: (id: string) =>
    id === 'claude-code' ? { command: 'npx', args: ['adapter'], role: id } : null,
  classifyAgentFailure: () => undefined,
  ACPSession: {
    start: async (opts: Record<string, unknown>) => {
      acp.starts.push(opts);
      return {
        openSession: async () => ({ sessionId: 'agent_sess_1', resumed: false }),
        prompt: async (blocks: Array<{ text: string }>) => {
          acp.prompts.push(blocks[0]?.text ?? '');
          return {
            text: 'done',
            stopReason: 'end_turn',
            toolCalls: [],
            diffs: [],
            thoughts: '',
            hasText: true,
          };
        },
        canSteer: () => false,
        steer: async () => 'rejected',
        close: async (opts: { graceMs?: number } = {}) => {
          acp.closes.push(opts);
        },
      };
    },
  },
}));

// Which ACP agents are installed here: whatever the test config names.
vi.mock('@wrongstack/fleet', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@wrongstack/fleet')>()),
  installedBridgeAgents: (cfg: { agents?: Record<string, unknown> } | undefined) =>
    cfg?.agents ? Object.keys(cfg.agents) : [],
  // The pickers also list WrongForge: none here, whatever this machine has set up.
  resolveWrongForgeEndpoint: () => undefined,
}));

const { AcpLeaderProvider, acpLeaderHost, acpLeaderSessionAgent, bindAcpLeaderHost } = await import(
  '@wrongstack/runtime/acp-leader'
);
const { bindStandaloneAcpLeaderHost, registerStandaloneAcpLeaderProvider } = await import(
  '../src/server/standalone-acp-leader.js'
);
const { resolveSetupProvider } = await import('../src/server/setup-screen.js');
const { buildConversationProvider } = await import('../src/server/conversation-fallback.js');
const { createProviderHandlers } = await import('../src/server/provider-handlers.js');

const SIGNAL = new AbortController().signal;

function leaderConfig(overrides: Record<string, unknown> = {}): Config {
  return {
    provider: 'acp',
    model: 'claude-code',
    providers: { zai: { type: 'zai' } },
    features: { modelsRegistry: true },
    // A command that cannot start: should the fake above ever stop applying,
    // the real client fails to spawn instead of launching the user's agent.
    acp: {
      agents: { 'claude-code': { command: 'wrongstack-test-no-such-acp-agent' } },
      leader: { sideModel: 'zai/glm-5' },
    },
    ...overrides,
  } as unknown as Config;
}

/** A registry with the ACP leader registered as the engine does, plus a `zai` side model. */
function engineRegistry(config: Config, sideCalls: string[] = []): ProviderRegistry {
  const registry = new ProviderRegistry();
  registerStandaloneAcpLeaderProvider(registry, config);
  registry.register({
    type: 'zai',
    family: 'openai-compatible',
    create: (cfg) =>
      ({
        id: (cfg as { type?: string }).type ?? 'zai',
        capabilities: {} as Provider['capabilities'],
        async *stream() {},
        async complete(req) {
          sideCalls.push(`complete ${req.model}`);
          return {
            content: [],
            stopReason: 'end_turn',
            usage: { input: 0, output: 0 },
            model: req.model,
          };
        },
      }) as Provider,
  });
  return registry;
}

function fakeAgent(label: string) {
  return {
    ctx: { label, meta: {}, projectRoot: '/proj', cwd: '/proj' },
    permission: { label, evaluate: vi.fn(), trust: vi.fn(), deny: vi.fn() },
    toolExecutor: { executeBatch: vi.fn(), executeTool: vi.fn() },
    perIterationOutputCapBytes: 1_000,
  };
}

function leaderTurn(text: string, sessionId = 'tab-2') {
  return {
    model: 'claude-code',
    messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text }] }],
    cache: { sessionId, threadId: sessionId },
  };
}

async function drain(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

let stateDir: string;
beforeEach(() => {
  acp.starts.length = 0;
  acp.prompts.length = 0;
  acp.closes.length = 0;
  stateDir = mkdtempSync(path.join(tmpdir(), 'acp-leader-standalone-'));
});
afterEach(() => {
  bindAcpLeaderHost(undefined);
  rmSync(stateDir, { recursive: true, force: true });
});

describe('the engine resolves provider `acp` to the ACP leader', () => {
  it('boots a profile whose provider is acp, with or without the models.dev catalog', () => {
    for (const modelsRegistry of [true, false]) {
      const config = leaderConfig({ features: { modelsRegistry } });
      const { provider, needsSetup } = resolveSetupProvider({
        config,
        needsProvider: false,
        providerRegistry: engineRegistry(config),
      });
      expect(needsSetup).toBe(false);
      expect(provider).toBeInstanceOf(AcpLeaderProvider);
      expect(provider.id).toBe('acp');
      expect(provider.capabilities.streaming).toBe(true);
    }
  });

  it('switches a conversation to acp/claude-code without the catalog overlay', async () => {
    const config = leaderConfig();
    const catalogCalls: string[] = [];
    // Any read of the catalog is the overlay running: it would replace the
    // leader's own capabilities with the unsupported-family defaults.
    const modelsRegistry = new Proxy({} as ModelsRegistry, {
      get: (_target, key) => {
        catalogCalls.push(String(key));
        return async () => undefined;
      },
    });
    const { provider } = await buildConversationProvider(
      { providerRegistry: engineRegistry(config), modelsRegistry },
      config,
      'acp',
      'claude-code',
    );
    expect(provider).toBeInstanceOf(AcpLeaderProvider);
    expect(catalogCalls).toEqual([]);
    expect(provider.capabilities.streaming).toBe(true);
    expect(provider.capabilities.maxContext).toBe(1_000_000);
  });

  it('sends side requests to acp.leader.sideModel, built from the saved provider', async () => {
    const config = leaderConfig();
    const sideCalls: string[] = [];
    const provider = engineRegistry(config, sideCalls).create({ type: 'acp' }, 'acp');
    await provider.complete(
      { model: 'claude-code', messages: [], cache: { sessionId: 's1', threadId: 's1' } } as never,
      { signal: SIGNAL },
    );
    expect(sideCalls).toEqual(['complete glm-5']);
  });
});

describe('the engine offers acp in its pickers', () => {
  it('lists acp with the installed agents beside the saved providers', async () => {
    const { standaloneHostProviders } = await import('../src/server/standalone-acp-leader.js');
    const handlers = createProviderHandlers({
      profileConfigPath: path.join(stateDir, 'missing-config.json'),
      vault: {} as never,
      getConfigWriteLock: () => Promise.resolve(),
      setConfigWriteLock: () => {},
      broadcast: () => {},
      clients: new Map(),
      hostProviders: () => standaloneHostProviders(leaderConfig()),
    });
    const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const ws = {
      readyState: 1,
      bufferedAmount: 0,
      send: (data: string) => sent.push(JSON.parse(data)),
    } as never;
    await handlers.handleProvidersSaved(ws);
    await handlers.handleProviderModels(ws, 'acp');
    const saved = sent.find((frame) => frame.type === 'providers.saved');
    expect(saved?.payload['providers']).toEqual([
      expect.objectContaining({ id: 'acp', type: 'acp', models: ['claude-code'] }),
    ]);
    const models = sent.find((frame) => frame.type === 'provider.models');
    expect(models?.payload['models']).toEqual([
      expect.objectContaining({ id: 'claude-code', name: 'Claude Code', contextWindow: 1_000_000 }),
    ]);
  });

  it('lists nothing when no ACP agent is installed', async () => {
    const { standaloneHostProviders } = await import('../src/server/standalone-acp-leader.js');
    expect(standaloneHostProviders(leaderConfig({ acp: {} }))).toEqual([]);
  });
});

describe('the engine binds the leader host', () => {
  const fleetStatus = { name: 'fleet_status', description: 'Fleet', inputSchema: {} } as Tool;

  function bind(events = new EventBus()) {
    const leader = fakeAgent('leader');
    const tab = fakeAgent('tab-2');
    const config = leaderConfig();
    const handle = bindStandaloneAcpLeaderHost({
      agent: leader as never,
      events,
      projectRoot: '/proj',
      stateDir,
      getConfig: () => config,
      toolRegistry: {
        get: (name: string) => (name === 'fleet_status' ? fleetStatus : undefined),
        list: () => [fleetStatus],
      } as never,
      peekAgent: (sessionId) => (sessionId === 'tab-2' ? (tab as never) : undefined),
    });
    return { handle, leader, tab, config, events };
  }

  it("answers each tab with that tab's agent and asks through the engine's prompt", () => {
    const { handle, leader, tab, events } = bind();
    const host = acpLeaderHost();
    expect(host?.events).toBe(events);
    expect(host?.projectRoot).toBe('/proj');
    expect(host?.stateDir).toBe(stateDir);
    expect(host?.permission('tab-2')).toBe(tab.permission);
    expect(host?.context('tab-2')).toBe(tab.ctx);
    expect(host?.permission('closed-tab')).toBe(leader.permission);
    expect(host?.permission()).toBe(leader.permission);
    expect(acpLeaderSessionAgent('tab-2')).toBe(tab);
    // No terminal here: the agent's permission requests become tool.confirm_needed.
    expect(host?.confirmAwaiter).toBeUndefined();
    expect(host?.confirmThroughEvents).toBe(true);
    void handle.dispose();
  });

  it("runs a leader turn under the tab's policy, with the fleet tools, and closes it on dispose", async () => {
    const { handle, config } = bind();
    const provider = engineRegistry(config).create({ type: 'acp' }, 'acp');
    const events = await drain(provider.stream(leaderTurn('fix the bug'), { signal: SIGNAL }));

    expect(events.at(-1)).toMatchObject({ type: 'message_stop', stopReason: 'end_turn' });
    expect(acp.prompts.at(-1)).toContain('fix the bug');
    const start = acp.starts[0];
    expect(start?.['cwd']).toBe('/proj');
    // The bound host is what gives the agent a permission policy (and the
    // `default` mode it asks in); an unbound provider runs read-only.
    expect(start?.['permissionPolicy']).toBeDefined();
    expect(start?.['initialModeId']).toBe('default');
    expect(start?.['mcpServers']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'http',
          name: 'wrongstack-fleet',
          url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+/),
        }),
      ]),
    );

    await handle.dispose();
    expect(acp.closes).toEqual([{ graceMs: 500 }]);
    expect(acpLeaderHost()).toBeUndefined();
    expect(acpLeaderSessionAgent('tab-2')).toBeUndefined();
    // Idempotent: a second shutdown path finds nothing left to close.
    await handle.dispose();
    expect(acp.closes).toHaveLength(1);
  });

  it('leaves a binding made after it in place', async () => {
    const first = bind();
    const second = bind();
    const secondHost = acpLeaderHost();
    await first.handle.dispose();
    expect(acpLeaderHost()).toBe(secondHost);
    await second.handle.dispose();
    expect(acpLeaderHost()).toBeUndefined();
  });

  it('starts an unbound agent without a permission policy (the gate the binding opens)', async () => {
    const config = leaderConfig();
    const provider = engineRegistry(config).create({ type: 'acp' }, 'acp');
    await drain(provider.stream(leaderTurn('hello', 's9'), { signal: SIGNAL }));
    expect(acp.starts[0]?.['permissionPolicy']).toBeUndefined();
    await (provider as InstanceType<typeof AcpLeaderProvider>).closeAll();
  });
});
