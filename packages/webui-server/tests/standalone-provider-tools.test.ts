/**
 * The standalone engine (WebUI server / desktop) registers the provider-backed
 * tools the CLI registers: `llm`, `council`, `image_generate` through the
 * shared `registerProviderUtilityTools`, and `jev` / `jev_status` through the
 * shared `registerJevTools` — with the same gates. Before, none of them existed
 * on this host: desktop's generated-images card had nothing to show and its Jev
 * settings configured a tool the model was never offered.
 */
import { TOKENS } from '@wrongstack/contracts/kernel';
import type { Config } from '@wrongstack/contracts/types';
import { createContextManagerTool } from '@wrongstack/core/infrastructure';
import { ToolRegistry } from '@wrongstack/core/registry';
import {
  resetSharedTypeSafeRestGatesForTests,
  resetTypeSafeJudgesForTests,
} from '@wrongstack/core/typesafe';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installStandaloneProviderTools } from '../src/server/standalone-provider-tools.js';

const FIVE = ['llm', 'council', 'image_generate', 'jev', 'jev_status'] as const;

function baseConfig(extra: Partial<Config> = {}): Config {
  return { version: 1, provider: 'openai', model: 'gpt-4o', providers: {}, ...extra } as Config;
}

function liveStore(initial: Config) {
  let current = initial;
  const listeners = new Set<(config: Config) => void>();
  return {
    get: () => current,
    watch: (listener: (config: Config) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next: Config) {
      current = next;
      for (const listener of listeners) listener(next);
    },
    listenerCount: () => listeners.size,
  };
}

function setup(options: { config?: Config; withFallbackManager?: boolean } = {}) {
  const store = liveStore(options.config ?? baseConfig());
  const toolRegistry = new ToolRegistry();
  const compactor = { compact: vi.fn() } as never;
  // The canonical host registration put the plain context tool here first.
  toolRegistry.registerDefault(createContextManagerTool({ compactor }));
  const plainContextTool = toolRegistry.get('context_manager');
  const fallbackProfileManager = { resolve: vi.fn() };
  const statusTracker = { status: vi.fn() };
  const container = {
    safeResolve: vi.fn((token: unknown) =>
      token === TOKENS.FallbackProfileManager
        ? options.withFallbackManager === false
          ? undefined
          : fallbackProfileManager
        : token === TOKENS.ProviderModelStatusTracker
          ? statusTracker
          : undefined,
    ),
  };
  const agent = {
    ctx: { session: { id: 's1' } },
    extensions: { wrapProviderRunner: vi.fn((inner: unknown) => inner) },
  };
  const installed = installStandaloneProviderTools({
    agent: agent as never,
    container: container as never,
    toolRegistry,
    providerRegistry: { create: vi.fn(() => ({ id: 'openai' })) } as never,
    modelsRegistry: { getProvider: vi.fn(async () => undefined) },
    compactor,
    getConfig: () => store.get(),
    configStore: store as never,
  });
  return { store, toolRegistry, installed, plainContextTool };
}

const offered = (registry: ToolRegistry) =>
  FIVE.filter((name) => registry.get(name) !== undefined && !registry.isDisabled(name));

afterEach(() => {
  resetTypeSafeJudgesForTests();
  resetSharedTypeSafeRestGatesForTests();
});

describe('installStandaloneProviderTools', () => {
  it('registers llm, council, image_generate and jev_status under the default config', () => {
    const { toolRegistry, installed } = setup();
    // `jev` itself waits for a configured TypeSafe account — the CLI's gate.
    expect(offered(toolRegistry)).toEqual(['llm', 'council', 'image_generate', 'jev_status']);
    expect(installed.memoryCuratorLlm).toBeTypeOf('function');
  });

  it('registers jev once TypeSafe is configured, and drops it when it is turned off again', () => {
    const configured = baseConfig({
      typesafe: { apiKey: 'key', enabled: true },
    } as Partial<Config>);
    const { toolRegistry, store, installed } = setup({ config: configured });
    expect(offered(toolRegistry)).toEqual([...FIVE]);

    store.set(baseConfig({ typesafe: { apiKey: 'key', enabled: false } } as Partial<Config>));
    expect(toolRegistry.get('jev')).toBeUndefined();

    installed.dispose();
    expect(store.listenerCount()).toBe(0);
  });

  it('keeps tools named in tools.disabledTools turned off', () => {
    const { toolRegistry } = setup({
      config: baseConfig({
        tools: { disabledTools: ['council', 'image_generate', 'jev_status'] },
      } as Partial<Config>),
    });
    expect(offered(toolRegistry)).toEqual(['llm']);
    expect(toolRegistry.isDisabled('council')).toBe(true);
  });

  it('gives context_manager the provider-backed summarizer', () => {
    const { toolRegistry, plainContextTool } = setup();
    expect(toolRegistry.get('context_manager')).toBeDefined();
    expect(toolRegistry.get('context_manager')).not.toBe(plainContextTool);
  });

  it('without a fallback manager registers only the Jev tools', () => {
    const { toolRegistry, installed } = setup({ withFallbackManager: false });
    expect(offered(toolRegistry)).toEqual(['jev_status']);
    expect(installed.memoryCuratorLlm).toBeUndefined();
  });
});
