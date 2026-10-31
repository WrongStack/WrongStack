/**
 * The standalone engine registered none of the leader's provider/model/fallback management tools
 * the CLI has (`createFallbackManageTools`). Real tools; config persistence and the live model
 * switch are recorders.
 */
import { EventBus } from '@wrongstack/contracts/kernel';
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

describe('leader_tier_set guards per conversation', () => {
  // Declaration order is the ladder: budget is the cheaper rung.
  const tiers = (mode = 'auto') => ({
    modelTiers: {
      enabled: true,
      levels: {
        budget: { provider: 'other', model: 'o-cheap' },
        premium: { provider: 'zai', model: 'glm-big' },
      },
      leader: { mode, dwellTurns: 2 },
    },
  });
  const prices: Record<string, { cost: { input: number }; capabilities: { maxContext: number } }> =
    {
      'glm-a': { cost: { input: 0.05 }, capabilities: { maxContext: 200_000 } },
      'glm-big': { cost: { input: 10 }, capabilities: { maxContext: 1_000_000 } },
      'o-cheap': { cost: { input: 0.1 }, capabilities: { maxContext: 100_000 } },
    };
  function tiered(mode = 'auto') {
    const events = new EventBus();
    const priced: string[] = [];
    const proposals: Array<[string | undefined, unknown]> = [];
    const switched: string[] = [];
    const tools: RegisteredTool[] = [];
    let live = {
      provider: 'zai',
      model: 'glm-a',
      providers: { zai: { type: 'zai' }, other: { type: 'other' } },
      fallbackModels: [],
      tools: {},
      ...tiers(mode),
    } as unknown as Config;
    registerEngineManagementTools({
      toolRegistry: { registerDefault: (tool: never) => tools.push(tool) } as never,
      getConfig: () => live,
      applyConfig: (next) => {
        live = next;
      },
      persist: async () => {},
      switchModel: async (_provider, model) => {
        switched.push(model);
      },
      onTierProposed: (sessionId, proposal) => proposals.push([sessionId, proposal]),
      events,
      // Every tab runs the premium model; the profile default is the cheap glm-a.
      sessionModel: () => ({ provider: 'zai', model: 'glm-big' }),
      modelsRegistry: {
        getModel: async (_provider: string, model: string) => {
          priced.push(model);
          return prices[model];
        },
      } as never,
    });
    const tierTool = tools.find((item) => item.name === 'leader_tier_set')!;
    const tabCtx = (id: string) => ({ eventSessionId: () => id, session: { id }, meta: {} });
    return {
      priced,
      proposals,
      switched,
      turn: (id: string) => events.emit('iteration.started', { index: 0, sessionId: id } as never),
      size: (id: string, tokens: number) =>
        events.emit('ctx.pct', { sessionId: id, tokens, load: 0, maxContext: 0 } as never),
      set: (id: string, tier: string) =>
        tierTool.execute({ action: 'set', tier }, tabCtx(id)) as Promise<{ status: string }>,
    };
  }

  it('holds a conversation to the dwell window after its own switch, not its neighbours', async () => {
    const h = tiered();
    h.turn('tab-3');
    h.size('tab-3', 10_000);
    await expect(h.set('tab-3', 'budget')).resolves.toMatchObject({ status: 'ok' });
    await expect(h.set('tab-3', 'premium')).rejects.toThrow(/Refused \(dwell\)/);
    await expect(h.set('tab-4', 'budget')).resolves.toMatchObject({ status: 'ok' });
    h.turn('tab-3');
    h.turn('tab-3');
    await expect(h.set('tab-3', 'premium')).resolves.toMatchObject({ status: 'ok' });
  });

  it("refuses a downgrade into a window the conversation's context no longer fits", async () => {
    const h = tiered();
    h.size('tab-5', 90_000);
    await expect(h.set('tab-5', 'budget')).rejects.toThrow(/Refused \(context-window\)/);
    // Another conversation's size does not count against tab-6.
    await expect(h.set('tab-6', 'budget')).resolves.toMatchObject({ status: 'ok' });
  });

  it("prices the switch from the conversation's own model", async () => {
    const h = tiered();
    h.size('tab-7', 10_000);
    await h.set('tab-7', 'budget');
    expect(h.priced).toEqual(expect.arrayContaining(['glm-big', 'o-cheap']));
    expect(h.priced).not.toContain('glm-a');
  });

  it('hands a propose-mode verdict to the calling conversation without switching', async () => {
    const h = tiered('propose');
    await expect(h.set('tab-8', 'budget')).resolves.toMatchObject({ status: 'proposed' });
    expect(h.switched).toEqual([]);
    expect(h.proposals).toEqual([
      [
        'tab-8',
        expect.objectContaining({
          toTier: 'budget',
          target: { provider: 'other', model: 'o-cheap' },
        }),
      ],
    ]);
  });
});
