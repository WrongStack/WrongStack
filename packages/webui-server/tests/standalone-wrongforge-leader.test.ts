/**
 * The standalone engine (WebUI server / desktop) leads with the machine's
 * WrongForge the way the CLI does (`--provider wrongforge`): a profile whose
 * provider is `wrongforge` boots, a conversation switches to it without the
 * catalog overlay, and the pickers offer it with the models WrongForge serves.
 * No WrongForge server: the endpoint and its model list are faked.
 */
import type { Config, ModelsRegistry } from '@wrongstack/contracts/types';
import { ProviderRegistry } from '@wrongstack/core/registry';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const wf = vi.hoisted(() => ({
  endpoint: undefined as { url: string; apiKey: string } | undefined,
  info: undefined as { models: string[]; defaultModel?: string; features: string[] } | undefined,
}));

vi.mock('@wrongstack/fleet', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@wrongstack/fleet')>()),
  resolveWrongForgeEndpoint: () => wf.endpoint,
  readCachedWrongForgeInfo: () => wf.info,
  refreshWrongForgeInfoCache: () => {},
  reportWrongForgeQuota: async () => false,
  // No ACP agent installed: only WrongForge is offered.
  installedBridgeAgents: () => [],
}));

const { registerStandaloneAcpLeaderProvider, standaloneHostProviders } = await import(
  '../src/server/standalone-acp-leader.js'
);
const { resolveSetupProvider } = await import('../src/server/setup-screen.js');
const { buildConversationProvider } = await import('../src/server/conversation-fallback.js');

function forgeConfig(overrides: Record<string, unknown> = {}): Config {
  return {
    provider: 'wrongforge',
    model: 'claude-opus-5-5',
    providers: {},
    features: { modelsRegistry: true },
    ...overrides,
  } as unknown as Config;
}

/** The provider registry as the engine fills it before the boot provider resolves. */
function engineRegistry(config: Config): ProviderRegistry {
  const registry = new ProviderRegistry();
  registerStandaloneAcpLeaderProvider(registry, config);
  return registry;
}

beforeEach(() => {
  wf.endpoint = { url: 'http://127.0.0.1:8787', apiKey: 'k'.repeat(32) };
  wf.info = {
    models: ['claude-opus-5-5', 'claude-haiku-5-5'],
    defaultModel: 'claude-opus-5-5',
    features: [],
  };
});

describe('the engine resolves provider `wrongforge` to the WrongForge leader', () => {
  it('boots a profile whose provider is wrongforge, with or without the models.dev catalog', () => {
    for (const modelsRegistry of [true, false]) {
      const config = forgeConfig({ features: { modelsRegistry } });
      const { provider, needsSetup } = resolveSetupProvider({
        config,
        needsProvider: false,
        providerRegistry: engineRegistry(config),
      });
      expect(needsSetup).toBe(false);
      expect(provider.id).toBe('wrongforge');
      // WrongForge keeps the conversation itself: the leader's own capabilities.
      expect(provider.capabilities.keepsOwnContext).toBe(true);
      expect(provider.capabilities.streaming).toBe(true);
    }
  });

  it('switches a conversation to wrongforge without the catalog overlay', async () => {
    const config = forgeConfig();
    const catalogCalls: string[] = [];
    const modelsRegistry = new Proxy({} as ModelsRegistry, {
      get: (_target, key) => {
        catalogCalls.push(String(key));
        return async () => undefined;
      },
    });
    const { provider } = await buildConversationProvider(
      { providerRegistry: engineRegistry(config), modelsRegistry },
      config,
      'wrongforge',
      'claude-haiku-5-5',
    );
    expect(provider.id).toBe('wrongforge');
    expect(catalogCalls).toEqual([]);
    expect(provider.capabilities.keepsOwnContext).toBe(true);
  });
});

describe('the engine offers wrongforge in its pickers', () => {
  it('lists wrongforge with the models it serves', () => {
    expect(standaloneHostProviders(forgeConfig())).toEqual([
      expect.objectContaining({
        id: 'wrongforge',
        type: 'wrongforge',
        models: [
          expect.objectContaining({
            id: 'claude-opus-5-5',
            name: 'claude-opus-5-5 (WrongForge default)',
          }),
          expect.objectContaining({ id: 'claude-haiku-5-5' }),
        ],
      }),
    ]);
  });

  it('lists nothing when no WrongForge is set up on this machine', () => {
    wf.endpoint = undefined;
    expect(standaloneHostProviders(forgeConfig())).toEqual([]);
  });
});
