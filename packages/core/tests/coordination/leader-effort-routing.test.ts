import type { SubagentConfig, SubagentRunner } from '@wrongstack/contracts/types/multi-agent';
import { REASONING_EFFORT_LEVELS } from '@wrongstack/contracts/types/provider';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Director } from '../../src/coordination/director.js';
import {
  buildKanbanSubagentConfig,
  normalizeKanbanQueueInput,
} from '../../src/coordination/director-kanban-queue-helpers.js';
import {
  LEADER_EFFORT_SCHEMA,
  readLeaderEffort,
  resolveDirectorSpawnModel,
} from '../../src/coordination/director-spawn-model.js';
import {
  __resetAllSessionSubagentModelPlans,
  emptySubagentModelPlan,
  type SubagentSlot,
  setSessionSubagentModelPlanForSession,
} from '../../src/coordination/session-subagent-models.js';

/**
 * The leader picks a worker's reasoning effort the same way it picks the
 * provider/model. A user's locked lane takes the model back, but a lane that
 * names no effort leaves effort with the leader; only a user-authored effort
 * (lane, role overlay, explicit `/setmodel` route) outranks it.
 */

const lane = (slot: SubagentSlot, lock = true) =>
  ({ kind: 'lane', target: slot, lock, slotIndex: 0 }) as const;

function resolve(
  config: SubagentConfig,
  opts: Parameters<typeof resolveDirectorSpawnModel>[1] = {},
): SubagentConfig {
  resolveDirectorSpawnModel(config, opts);
  return config;
}

describe('leader effort in the spawn resolver', () => {
  it('keeps a locked provider-only lane runtime while the matrix fills its model', () => {
    const runtime = { reasoning: { effort: 'max' as const }, cache: { ttl: '1h' as const } };
    const config = resolve(
      { name: 'w', role: 'critic', leaderEffort: 'medium' },
      {
        sessionPlan: lane({ provider: 'p', modelRuntime: runtime }),
        modelMatrix: {
          critic: {
            provider: 'other',
            model: 'route',
            modelRuntime: { reasoning: { effort: 'low' } },
          },
        },
      },
    );
    expect(config).toMatchObject({ provider: 'p', model: 'route', modelRuntime: runtime });
  });

  it('does not treat an ignored matrix effort as a user effort override', () => {
    const config = resolve(
      { name: 'w', role: 'critic', leaderEffort: 'medium' },
      {
        sessionPlan: lane({ provider: 'p', modelRuntime: { cache: { ttl: '1h' } } }),
        modelMatrix: {
          critic: { model: 'route', modelRuntime: { reasoning: { effort: 'low' } } },
        },
      },
    );
    expect(config.modelRuntime).toEqual({ cache: { ttl: '1h' }, reasoning: { effort: 'medium' } });
  });

  it('applies the leader effort when nothing else set one', () => {
    const config = resolve(
      { name: 'w', leaderEffort: 'high' },
      { sessionProvider: 'openai', sessionModel: 'gpt-5' },
    );
    expect(config.modelRuntime?.reasoning?.effort).toBe('high');
  });

  it('survives a locked lane that names no effort, while the model is taken back', () => {
    const config = resolve(
      {
        name: 'w',
        provider: 'openai',
        model: 'gpt-5-mini',
        modelChosenByLeader: true,
        leaderEffort: 'xhigh',
      },
      { sessionPlan: lane({ provider: 'anthropic', model: 'opus' }) },
    );
    expect(config).toMatchObject({ provider: 'anthropic', model: 'opus' });
    expect(config.modelRuntime?.reasoning?.effort).toBe('xhigh');
  });

  it('keeps the rest of the lane runtime when folding the leader effort in', () => {
    const config = resolve(
      { name: 'w', leaderEffort: 'low' },
      {
        sessionPlan: lane({
          provider: 'anthropic',
          model: 'opus',
          modelRuntime: { cache: { ttl: '1h' } },
        }),
      },
    );
    expect(config.modelRuntime).toEqual({ cache: { ttl: '1h' }, reasoning: { effort: 'low' } });
  });

  it('yields to an effort the user set on a locked lane', () => {
    const config = resolve(
      { name: 'w', leaderEffort: 'max' },
      {
        sessionPlan: lane({
          provider: 'anthropic',
          model: 'opus',
          modelRuntime: { reasoning: { effort: 'medium' } },
        }),
      },
    );
    expect(config.modelRuntime?.reasoning?.effort).toBe('medium');
  });

  it('beats an unlocked lane effort, the same way an unlocked lane only fills gaps', () => {
    const config = resolve(
      { name: 'w', leaderEffort: 'high' },
      {
        sessionPlan: lane(
          { provider: 'anthropic', model: 'opus', modelRuntime: { reasoning: { effort: 'low' } } },
          false,
        ),
      },
    );
    expect(config.modelRuntime?.reasoning?.effort).toBe('high');
  });

  it('lets an unlocked lane effort apply when the leader named none', () => {
    const config = resolve(
      { name: 'w' },
      {
        sessionPlan: lane(
          { provider: 'anthropic', model: 'opus', modelRuntime: { reasoning: { effort: 'low' } } },
          false,
        ),
      },
    );
    expect(config.modelRuntime?.reasoning?.effort).toBe('low');
  });

  it('yields to an explicit /setmodel role route effort', () => {
    const config = resolve(
      { name: 'w', role: 'critic', leaderEffort: 'minimal' },
      {
        modelMatrix: {
          critic: {
            provider: 'openai',
            model: 'gpt-5',
            modelRuntime: { reasoning: { effort: 'high' } },
          },
        },
      },
    );
    expect(config.modelRuntime?.reasoning?.effort).toBe('high');
  });

  it('beats the `*` wildcard route effort, which is only a default', () => {
    const config = resolve(
      { name: 'w', role: 'critic', leaderEffort: 'minimal' },
      {
        modelMatrix: {
          '*': {
            provider: 'openai',
            model: 'gpt-5',
            modelRuntime: { reasoning: { effort: 'high' } },
          },
        },
      },
    );
    expect(config.modelRuntime?.reasoning?.effort).toBe('minimal');
  });

  it('leaves the runtime untouched when the leader named no effort', () => {
    const config = resolve({ name: 'w' }, { sessionProvider: 'openai', sessionModel: 'gpt-5' });
    expect(config.modelRuntime).toBeUndefined();
  });
});

describe('readLeaderEffort', () => {
  it('accepts every documented level and treats blanks as unset', () => {
    for (const level of REASONING_EFFORT_LEVELS) expect(readLeaderEffort(level)).toBe(level);
    expect(readLeaderEffort(undefined)).toBeUndefined();
    expect(readLeaderEffort('')).toBeUndefined();
  });

  it('rejects an unknown level with the accepted list', () => {
    expect(() => readLeaderEffort('extreme')).toThrow(/Use one of: none, minimal, low/);
  });

  it('advertises exactly the documented levels', () => {
    expect(LEADER_EFFORT_SCHEMA.enum).toEqual([...REASONING_EFFORT_LEVELS]);
  });
});

describe('Director.spawn reports the effective effort', () => {
  const SESSION = 'sess_leader_effort';
  const runner: SubagentRunner = async (task) => ({
    result: task.description,
    iterations: 0,
    toolCalls: 0,
  });
  let director: Director | undefined;

  beforeEach(() => __resetAllSessionSubagentModelPlans());
  afterEach(async () => {
    await director?.shutdown().catch(() => {});
    director = undefined;
    __resetAllSessionSubagentModelPlans();
  });

  it('reports the lane model with the leader effort', async () => {
    const plan = emptySubagentModelPlan();
    plan.slots[0] = { provider: 'anthropic', model: 'opus' };
    setSessionSubagentModelPlanForSession(SESSION, plan);
    director = new Director({
      sessionId: SESSION,
      config: {
        coordinatorId: 'effort-test',
        doneCondition: { type: 'all_tasks_done' },
        maxConcurrent: 4,
      },
      runner,
    });

    const id = await director.spawn({
      name: 'w1',
      provider: 'openai',
      model: 'gpt-5-mini',
      modelChosenByLeader: true,
      leaderEffort: 'high',
    });

    expect(director.resolvedModelFor(id)).toMatchObject({
      provider: 'anthropic',
      model: 'opus',
      effort: 'high',
    });
  });
});

describe('kanban_dispatch effort', () => {
  it('carries the leader effort onto the worker config without touching the board route', () => {
    const input = normalizeKanbanQueueInput({ action: 'dispatch_ready', effort: 'high' });
    const config = buildKanbanSubagentConfig(
      { id: 't1', title: 'T', assignment: { model: 'gpt-5' } } as never,
      input,
      undefined,
      (_role, base) => base,
    );
    expect(config.leaderEffort).toBe('high');
    expect(config.modelRuntime).toBeUndefined();
  });

  it('rejects an unknown level before anything is claimed', () => {
    expect(() => normalizeKanbanQueueInput({ effort: 'turbo' })).toThrow(/Use one of/);
  });
});

describe('worker effort when nothing chose one', () => {
  it("follows the leader's own conversation effort, not just the project setting", () => {
    const config = resolve(
      { name: 'w', leaderConversationEffort: { reasoningEffort: 'low' } },
      { config: { modelRuntime: { reasoning: { effort: 'high' } } } as never },
    );
    expect(config.modelRuntime?.reasoning?.effort).toBe('low');
  });

  it("follows the leader's own in-force override", () => {
    const config = resolve(
      {
        name: 'w',
        leaderConversationEffort: {
          leaderReasoningEffort: {
            effort: 'xhigh',
            baseProject: 'medium',
            baseConversation: null,
            at: '',
          },
        },
      },
      { config: { modelRuntime: { reasoning: { effort: 'medium' } } } as never },
    );
    expect(config.modelRuntime?.reasoning?.effort).toBe('xhigh');
  });

  it('leaves `auto` to the project setting', () => {
    const config = resolve({ name: 'w', leaderConversationEffort: { reasoningEffort: 'auto' } });
    expect(config.modelRuntime).toBeUndefined();
  });

  it('never beats an explicit leader effort or a lane effort', () => {
    const explicit = resolve({
      name: 'w',
      leaderEffort: 'high',
      leaderConversationEffort: { reasoningEffort: 'low' },
    });
    expect(explicit.modelRuntime?.reasoning?.effort).toBe('high');
    const laned = resolve(
      { name: 'w', leaderConversationEffort: { reasoningEffort: 'low' } },
      {
        sessionPlan: lane({
          provider: 'anthropic',
          model: 'opus',
          modelRuntime: { reasoning: { effort: 'max' } },
        }),
      },
    );
    expect(laned.modelRuntime?.reasoning?.effort).toBe('max');
  });
});
