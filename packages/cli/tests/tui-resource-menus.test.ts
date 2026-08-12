import { ProviderModelStatusTracker } from '@wrongstack/core/coordination';
import type { Config, ConfigStore } from '@wrongstack/core/types';
import type { WstackPaths } from '@wrongstack/core/utils';
import { describe, expect, it } from 'vitest';
import { createTuiResourceMenuGetter } from '../src/tui-resource-menus.js';
import { makeFakeMemoryStore } from './fake-memory-store.js';

function configStore(config: Partial<Config>): ConfigStore {
  const value = {
    version: 1,
    provider: 'openai',
    model: 'gpt-test',
    context: {},
    tools: {},
    features: {},
    ...config,
  } as Config;
  return {
    get: () => value,
    getSection: (key) => value[key] as never,
    getExtension: () => ({}),
    update: () => value,
    watch: () => () => {},
  };
}

function getter(options: {
  config?: Partial<Config>;
  tracker?: ProviderModelStatusTracker;
  memory?: ReturnType<typeof makeFakeMemoryStore>;
}) {
  return createTuiResourceMenuGetter({
    configStore: configStore(options.config ?? {}),
    paths: { profileName: 'default' } as WstackPaths,
    statusTracker: options.tracker,
    memoryStore: options.memory,
    projectRoot: process.cwd(),
  });
}

describe('TUI resource menu snapshots', () => {
  it('builds actionable fallback chain, profile, and favorite rows', async () => {
    const menu = await getter({
      config: {
        fallbackModels: ['anthropic/claude-test'],
        fallbackProfiles: { fast: ['openai/gpt-fast'] },
        favoriteModels: ['openai/gpt-fast'],
        fallbackAuto: true,
      },
    })('fallback');

    expect(menu.items.find((item) => item.id === 'chain:0')?.actions?.[0]).toMatchObject({
      command: '/fallback remove 1',
      confirm: true,
    });
    expect(menu.items.find((item) => item.id === 'profile:fast')?.body).toContain('gpt-fast');
    expect(menu.subtitle).toContain('1 explicit');
  });

  it('maps live provider failures and recovery actions', async () => {
    const tracker = new ProviderModelStatusTracker();
    tracker.recordFailure('anthropic', 'claude-test', 'rate_limit', 429, 'try later');
    const menu = await getter({ tracker })('provider-status');
    const item = menu.items[0];

    expect(item).toMatchObject({ label: 'anthropic/claude-test', status: 'bad' });
    expect(item?.actions?.map((action) => action.key)).toEqual(['r', 'x']);
    expect(menu.subtitle).toContain('1 blocked');
  });

  it('shows memory metadata and requires confirmation for exact forget', async () => {
    const memory = makeFakeMemoryStore();
    await memory.remember('Use pnpm for workspace commands', 'project-memory', {
      type: 'convention',
      priority: 'high',
      tags: ['build'],
    });
    const menu = await getter({ memory })('memory');

    expect(menu.items[0]?.details).toContainEqual({ label: 'type', value: 'convention' });
    expect(menu.items[0]?.actions?.[0]).toMatchObject({
      command: '/memory forget Use pnpm for workspace commands --exact',
      confirm: true,
    });
  });

  it('lists real git worktrees with branch, path, cleanliness, and safe actions', async () => {
    const menu = await getter({})('worktree');
    expect(menu.items.length).toBeGreaterThan(0);
    expect(menu.items[0]?.details.map((detail) => detail.label)).toEqual(
      expect.arrayContaining(['path', 'branch', 'HEAD', 'working tree']),
    );
    expect(menu.items[0]?.actions?.map((action) => action.key)).toEqual(['p', 'x']);
    expect(menu.items[0]?.actions?.[1]).toMatchObject({ confirm: true });
  });
});
