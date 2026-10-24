import type { Config } from '@wrongstack/contracts/types/config';
import type { ReasoningConfig, Request } from '@wrongstack/contracts/types/provider';
import { describe, expect, it } from 'vitest';
import { bindRequestConversation } from '../../../core/src/core/request-conversation-binding.js';
import { applyModelRuntime } from '../../../core/src/execution/model-runtime.js';
import { createLeaderEffortSetTool } from '../../src/management/leader-effort-set-tool.js';
import {
  activeLeaderEffort,
  LEADER_EFFORT_META_KEY,
  restoreLeaderEffortOverride,
} from '../../../core/src/utils/leader-effort-override.js';

/**
 * `leader_effort_set` lets the leader change its OWN effort mid-session. The
 * change is conversation-scoped, never persisted, and goes dormant the moment
 * the user changes effort on any surface — the user always has the last word.
 */

const RC: ReasoningConfig = {
  default: 'enabled',
  disableSupported: true,
  effortSupported: true,
  effortLevels: ['low', 'medium', 'high'],
  preserveThinking: 'unsupported',
} as unknown as ReasoningConfig;

function setup(
  opts: { project?: string; conversation?: string; rc?: ReasoningConfig | null } = {},
) {
  let config = {
    provider: 'anthropic',
    model: 'opus',
    ...(opts.project ? { modelRuntime: { reasoning: { effort: opts.project } } } : {}),
  } as unknown as Config;
  const meta: Record<string, unknown> = {};
  if (opts.conversation) meta['reasoningEffort'] = opts.conversation;
  const tool = createLeaderEffortSetTool({
    getConfig: () => config,
    updateConfig: async () => {
      throw new Error('leader_effort_set must never write config');
    },
    getReasoningConfig: async () => (opts.rc === null ? undefined : (opts.rc ?? RC)),
  });
  const ctx = { meta, provider: { id: 'anthropic' }, model: 'opus' } as never;
  const run = (input: Record<string, unknown>) =>
    tool.execute(input as never, ctx, { signal: AbortSignal.timeout(5_000) });
  /** The effort the next leader request would actually carry. */
  const wireEffort = () => {
    const req = { model: 'opus', messages: [] } as unknown as Request;
    bindRequestConversation(req, { meta, sessionId: 's1' });
    return applyModelRuntime(req, {
      getSettings: () => config.modelRuntime,
      getReasoningConfig: () => opts.rc ?? RC,
    }).reasoning?.effort;
  };
  const setProject = (effort: string) => {
    config = { ...config, modelRuntime: { reasoning: { effort } } } as unknown as Config;
  };
  return { run, meta, wireEffort, setProject };
}

describe('leader_effort_set', () => {
  it('changes the effort of the next leader request without touching config', async () => {
    const t = setup({ project: 'medium' });
    const out = await t.run({ action: 'set', effort: 'high', reason: 'root-causing a race' });
    expect(out.effort).toBe('high');
    expect(t.wireEffort()).toBe('high');
  });

  it('maps an unsupported level onto the nearest one the model documents', async () => {
    const t = setup({ project: 'medium' });
    const out = await t.run({ action: 'set', effort: 'max' });
    expect(out.effort).toBe('high');
    expect(out.message).toMatch(/asked for max/);
    expect(t.wireEffort()).toBe('high');
  });

  it('refuses on a model with no effort control', async () => {
    const t = setup({ rc: { ...RC, effortSupported: false, effortLevels: [] } });
    await expect(t.run({ action: 'set', effort: 'high' })).rejects.toThrow(/no effort control/);
    expect(t.meta[LEADER_EFFORT_META_KEY]).toBeUndefined();
  });

  it('rejects an unknown level', async () => {
    const t = setup();
    await expect(t.run({ action: 'set', effort: 'extreme' })).rejects.toThrow(/needs effort/);
  });

  it('yields once the user changes the project effort (/effort, Settings)', async () => {
    const t = setup({ project: 'medium' });
    await t.run({ action: 'set', effort: 'low' });
    t.setProject('high');
    expect(t.wireEffort()).toBe('high');
    const shown = await t.run({ action: 'show' });
    expect(shown.message).toMatch(/no longer applies/);
  });

  it("yields once the user changes this conversation's effort (WebUI composer)", async () => {
    const t = setup({ project: 'medium', conversation: 'medium' });
    await t.run({ action: 'set', effort: 'high' });
    t.meta['reasoningEffort'] = 'low';
    expect(t.wireEffort()).toBe('low');
  });

  it("reset returns to the user's setting", async () => {
    const t = setup({ project: 'medium' });
    await t.run({ action: 'set', effort: 'high' });
    const out = await t.run({ action: 'reset' });
    expect(out.effort).toBe('medium');
    expect(t.wireEffort()).toBe('medium');
  });

  it('show names the source and the supported levels', async () => {
    const t = setup({ project: 'medium' });
    expect((await t.run({ action: 'show' })).message).toMatch(/medium — project setting \(user\)/);
    await t.run({ action: 'set', effort: 'low', reason: 'mechanical renames' });
    const shown = (await t.run({ action: 'show' })).message;
    expect(shown).toMatch(/low — set by you/);
    expect(shown).toMatch(/levels: low, medium, high/);
    expect(shown).toMatch(/reason: mechanical renames/);
  });

  it('forwards any documented level when the catalog does not know the model', async () => {
    const t = setup({ rc: null });
    expect((await t.run({ action: 'set', effort: 'xhigh' })).effort).toBe('xhigh');
  });

  it('announces set and reset to the host observer', async () => {
    const changes: unknown[] = [];
    const tool = createLeaderEffortSetTool({
      getConfig: () => ({ provider: 'p', model: 'm' }) as unknown as Config,
      updateConfig: async () => {},
      getReasoningConfig: async () => RC,
      onEffortChanged: (change) => changes.push(change),
    });
    const ctx = {
      meta: {},
      provider: { id: 'p' },
      model: 'm',
      eventSessionId: () => 's9',
    } as never;
    const signal = AbortSignal.timeout(5_000);
    await tool.execute({ action: 'set', effort: 'high', reason: 'design' }, ctx, { signal });
    await tool.execute({ action: 'reset' }, ctx, { signal });
    await tool.execute({ action: 'reset' }, ctx, { signal });
    expect(changes).toEqual([
      { sessionId: 's9', effort: 'high', reason: 'design' },
      { sessionId: 's9' },
    ]);
  });
});

describe('leader effort across /resume', () => {
  it('journals set and reset, and the last event wins on restore', async () => {
    const appended: Array<{ type: string; override: unknown }> = [];
    const tool = createLeaderEffortSetTool({
      getConfig: () => ({ modelRuntime: { reasoning: { effort: 'medium' } } }) as unknown as Config,
      updateConfig: async () => {},
      getReasoningConfig: async () => RC,
    });
    const meta: Record<string, unknown> = {};
    const ctx = {
      meta,
      provider: { id: 'p' },
      model: 'm',
      session: { append: async (e: { type: string; override: unknown }) => appended.push(e) },
    } as never;
    const signal = AbortSignal.timeout(5_000);
    await tool.execute({ action: 'set', effort: 'high' }, ctx, { signal });

    const resumed: Record<string, unknown> = {};
    restoreLeaderEffortOverride(resumed, appended as never);
    expect(activeLeaderEffort(resumed, 'medium')).toBe('high');

    await tool.execute({ action: 'reset' }, ctx, { signal });
    expect(appended.map((e) => e.override === null)).toEqual([false, true]);
    restoreLeaderEffortOverride(resumed, appended as never);
    expect(resumed[LEADER_EFFORT_META_KEY]).toBeUndefined();
  });

  it('comes back dormant when the user changed effort while the session was closed', () => {
    const meta: Record<string, unknown> = {};
    restoreLeaderEffortOverride(meta, [
      {
        type: 'leader_effort',
        ts: '',
        override: { effort: 'low', baseProject: 'medium', baseConversation: null, at: '' },
      },
    ] as never);
    expect(activeLeaderEffort(meta, 'medium')).toBe('low');
    expect(activeLeaderEffort(meta, 'high')).toBeUndefined();
  });

  it('ignores a malformed journal payload and leaves meta alone without events', () => {
    const meta: Record<string, unknown> = { [LEADER_EFFORT_META_KEY]: 'keep' };
    restoreLeaderEffortOverride(meta, []);
    expect(meta[LEADER_EFFORT_META_KEY]).toBe('keep');
    restoreLeaderEffortOverride(meta, [
      { type: 'leader_effort', ts: '', override: { effort: 'turbo' } },
    ] as never);
    expect(meta[LEADER_EFFORT_META_KEY]).toBeUndefined();
  });
});
