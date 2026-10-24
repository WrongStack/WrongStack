import type { Config } from '@wrongstack/contracts/types/config';
import type { Tool } from '@wrongstack/contracts/types/tool';
import { describe, expect, it } from 'vitest';
import { DefaultConfigStore } from '@wrongstack/core/storage';
import { createFallbackManageTools } from '../../src/management/fallback-manage-tools.js';

/**
 * The host wires these tools to `configStore.get()`, which is deep-frozen.
 * Tests that hand the tools a plain mutable object cannot see a tool writing
 * into the live config: `provider_key_set` did exactly that for an existing
 * provider and threw "object is not extensible" on every call (audit
 * 2026-09-15).
 */
function frozenHost() {
  const store = new DefaultConfigStore({
    version: 1,
    provider: 'test-provider',
    model: 'test-model',
    providers: {
      'test-provider': { type: 'openai', apiKey: 'sk-old', models: ['test-model'] },
    },
    favoriteModels: ['test-provider/test-model'],
  } as unknown as Config);
  const tools = createFallbackManageTools({
    getConfig: () => store.get() as Config,
    updateConfig: async (mutate) => {
      const draft = structuredClone(store.get()) as unknown as Record<string, unknown>;
      mutate(draft);
      store.update(draft as Partial<Config>);
    },
  });
  const tool = (name: string) => tools.find((t) => t.name === name) as Tool<never, unknown>;
  return { store, tool };
}

const signal = new AbortController().signal;

describe('fallback management tools against the frozen live config', () => {
  it('provider_key_set stores a key for an already-configured provider', async () => {
    const { store, tool } = frozenHost();
    process.env['WS_FROZEN_CONFIG_TEST_KEY'] = 'sk-from-env';
    try {
      await tool('provider_key_set').execute(
        { provider: 'test-provider', envVar: 'WS_FROZEN_CONFIG_TEST_KEY', label: 'work' } as never,
        {} as never,
        { signal },
      );
    } finally {
      delete process.env['WS_FROZEN_CONFIG_TEST_KEY'];
    }
    const entry = (store.get().providers as unknown as Record<string, Record<string, unknown>>)[
      'test-provider'
    ];
    expect(entry?.['apiKeys']).toEqual([
      expect.objectContaining({ label: 'work', apiKey: 'sk-from-env' }),
    ]);
    expect(entry?.['activeKey']).toBe('work');
    expect(entry && 'apiKey' in entry).toBe(false);
    expect(entry?.['models']).toEqual(['test-model']);
  });

  it('every mutating action writes through the frozen store without throwing', async () => {
    const { store, tool } = frozenHost();
    const run = (name: string, input: Record<string, unknown>) =>
      tool(name).execute(input as never, {} as never, { signal });

    await run('favorite_manage', { action: 'add', model: 'test-provider/other-model' });
    await run('fallback_chain_manage', { action: 'add', model: 'test-provider/other-model' });
    await run('fallback_profile_manage', {
      action: 'set',
      name: 'cheap',
      chain: ['test-provider/other-model', 'test-provider/test-model'],
    });
    await run('agent_model_assign', { role: 'review', model: 'test-provider/other-model' });
    await run('provider_manage', { action: 'add', provider: 'local', type: 'openai' });
    await run('provider_manage', {
      action: 'configure',
      provider: 'local',
      baseUrl: 'http://localhost:11434/v1',
    });
    await run('leader_model_set', { action: 'toggle', toggle: 'fallbackAuto', value: false });
    await run('leader_model_set', {
      action: 'set',
      provider: 'test-provider',
      model: 'other-model',
    });
    await run('fallback_chain_manage', { action: 'clear' });
    await run('fallback_profile_manage', { action: 'delete', name: 'cheap' });
    await run('provider_manage', { action: 'remove', provider: 'local' });
    await run('favorite_manage', { action: 'remove', model: 'test-provider/other-model' });

    const cfg = store.get() as unknown as Record<string, unknown>;
    expect(Object.isFrozen(cfg)).toBe(true);
    expect(cfg['model']).toBe('other-model');
    expect(cfg['favoriteModels']).toEqual(['test-provider/test-model']);
    expect(Object.keys(cfg['providers'] as object)).toEqual(['test-provider']);
  });

  it('leader_model_set requires an action in its schema', () => {
    const { tool } = frozenHost();
    expect(tool('leader_model_set').inputSchema.required).toContain('action');
  });
});
