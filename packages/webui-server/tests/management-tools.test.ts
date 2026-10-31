/**
 * The standalone engine registered none of the leader's provider/model/fallback management tools
 * the CLI has (`createFallbackManageTools`). Real tools; config persistence and the live model
 * switch are recorders.
 */
import type { Config } from '@wrongstack/contracts/types';
import { describe, expect, it } from 'vitest';
import { registerEngineManagementTools } from '../src/server/management-tools.js';

type RegisteredTool = { name: string; execute: (input: unknown, ctx: unknown) => Promise<unknown> };

function setup(extra: Partial<Config> = {}) {
  let live = {
    provider: 'zai',
    model: 'glm-a',
    providers: { zai: { type: 'zai' }, other: { type: 'other' } },
    fallbackModels: [],
    tools: {},
    ...extra,
  } as unknown as Config;
  const file: Record<string, unknown> = structuredClone(live) as never;
  const tools: RegisteredTool[] = [];
  const switches: Array<[string, string, string | undefined]> = [];
  let failSwitch = '';
  const registered = registerEngineManagementTools({
    toolRegistry: { registerDefault: (tool: never) => tools.push(tool) } as never,
    getConfig: () => live,
    applyConfig: (next) => {
      live = next;
    },
    persist: async (mutate) => mutate(file),
    switchModel: async (providerId, modelId, sessionId) => {
      if (failSwitch) throw new Error(failSwitch);
      switches.push([providerId, modelId, sessionId]);
    },
  });
  const tool = (name: string) => tools.find((item) => item.name === name)!;
  return {
    registered,
    tool,
    file,
    switches,
    live: () => live,
    failNextSwitch: (message: string) => {
      failSwitch = message;
    },
  };
}
const tab = { eventSessionId: () => 'tab-3', session: { id: 'tab-3' }, meta: {} };

describe('leader management tools in the standalone engine', () => {
  it('registers the CLI set except the separately owned effort tool', () => {
    const { registered } = setup();
    expect(registered).toEqual(
      expect.arrayContaining([
        'leader_model_set',
        'provider_manage',
        'favorite_manage',
        'system_config_view',
        'leader_tier_set',
      ]),
    );
    expect(registered).not.toContain('leader_effort_set');
  });
  it('switches the calling tab, then persists and applies the selection', async () => {
    const h = setup();
    await h
      .tool('leader_model_set')
      .execute({ action: 'set', provider: 'other', model: 'o-1' }, tab);
    expect(h.switches).toEqual([['other', 'o-1', 'tab-3']]);
    expect(h.file).toMatchObject({ provider: 'other', model: 'o-1' });
    expect(h.live()).toMatchObject({ provider: 'other', model: 'o-1' });
  });
  it('changes nothing when the live switch fails', async () => {
    const h = setup();
    h.failNextSwitch('provider has no key');
    await expect(
      h.tool('leader_model_set').execute({ action: 'set', provider: 'other', model: 'o-1' }, tab),
    ).rejects.toThrow('provider has no key');
    expect(h.file).toMatchObject({ provider: 'zai', model: 'glm-a' });
    expect(h.live()).toMatchObject({ provider: 'zai', model: 'glm-a' });
  });
  it('applies a config write to the live config at once', async () => {
    const h = setup();
    await h.tool('favorite_manage').execute({ action: 'add', model: 'other/o-1' }, tab);
    expect(h.file['favoriteModels']).toEqual(['other/o-1']);
    expect(h.live().favoriteModels).toEqual(['other/o-1']);
  });
  it('honours tools.disabledTools', () => {
    const { registered } = setup({ tools: { disabledTools: ['provider_manage'] } } as never);
    expect(registered).not.toContain('provider_manage');
    expect(registered).toContain('leader_model_set');
  });
});
