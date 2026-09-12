import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveDirectorSpawnModel } from '../../src/coordination/director-spawn-model.js';
import {
  __resetAllSessionSubagentModelPlans,
  claimSubagentSlot,
  emptySubagentModelPlan,
  getSessionSubagentModelPlan,
  isSlotConfigured,
  MAX_SUBAGENT_SLOTS,
  normalizeSubagentModelPlan,
  planHasAssignments,
  releaseSubagentSlot,
  restoreSessionSubagentModelPlan,
  type SessionSubagentModelPlan,
  setSessionSubagentModelPlan,
  setSessionSubagentModelPlanForSession,
  subagentSlotOccupancy,
} from '../../src/coordination/session-subagent-models.js';
import type { SubagentConfig } from '../../src/types/multi-agent.js';
import type { SessionEvent } from '../../src/types/session.js';

const SESSION = 'sess_plan';

function planWith(
  ...lanes: Array<{ provider?: string; model?: string }>
): SessionSubagentModelPlan {
  const plan = emptySubagentModelPlan();
  lanes.forEach((lane, i) => {
    plan.slots[i] = lane;
  });
  return plan;
}

beforeEach(() => __resetAllSessionSubagentModelPlans());
afterEach(() => __resetAllSessionSubagentModelPlans());

describe('plan shape', () => {
  it('creates 8 empty lanes by default and reports no assignments', () => {
    const plan = emptySubagentModelPlan();
    expect(plan.slots).toHaveLength(8);
    expect(plan.enabled).toBe(true);
    expect(plan.lock).toBe(true);
    expect(planHasAssignments(plan)).toBe(false);
  });

  it('treats a lane as configured when ANY model field is present', () => {
    expect(isSlotConfigured({})).toBe(false);
    expect(isSlotConfigured({ label: 'just a name' })).toBe(false);
    expect(isSlotConfigured({ provider: 'openai' })).toBe(true);
    expect(isSlotConfigured({ tier: 'budget' })).toBe(true);
    expect(isSlotConfigured({ fallbackProfile: 'cheap' })).toBe(true);
  });

  it('normalizes junk into an inert plan instead of throwing', () => {
    expect(normalizeSubagentModelPlan(undefined).slots).toHaveLength(8);
    expect(normalizeSubagentModelPlan('nope').slots).toHaveLength(8);
    const plan = normalizeSubagentModelPlan({ slots: [{ provider: '  ', model: 'm' }, 42] });
    expect(plan.slots[0]).toEqual({ model: 'm' });
    expect(plan.slots[1]).toEqual({});
  });

  it('clamps the lane count to the hard ceiling', () => {
    const plan = normalizeSubagentModelPlan({
      slots: Array.from({ length: 100 }, () => ({ model: 'm' })),
    });
    expect(plan.slots).toHaveLength(MAX_SUBAGENT_SLOTS);
  });

  it('drops unconfigured role overlay entries', () => {
    const plan = normalizeSubagentModelPlan({
      roles: {
        reviewer: { provider: 'anthropic' },
        executor: { label: 'x' },
        '  ': { model: 'm' },
      },
    });
    expect(plan.roles).toEqual({ reviewer: { provider: 'anthropic' } });
  });
});

describe('lane claiming', () => {
  it('gives concurrent spawns different lanes, in order', () => {
    setSessionSubagentModelPlanForSession(
      SESSION,
      planWith({ model: 'a' }, { model: 'b' }, { model: 'c' }),
    );
    const first = claimSubagentSlot(SESSION);
    const second = claimSubagentSlot(SESSION);
    const third = claimSubagentSlot(SESSION);
    expect([first?.slotIndex, second?.slotIndex, third?.slotIndex]).toEqual([0, 1, 2]);
    expect([first?.target.model, second?.target.model, third?.target.model]).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('skips unconfigured lanes entirely', () => {
    const plan = emptySubagentModelPlan();
    plan.slots[2] = { model: 'c' };
    plan.slots[5] = { model: 'f' };
    setSessionSubagentModelPlanForSession(SESSION, plan);
    expect(claimSubagentSlot(SESSION)?.slotIndex).toBe(2);
    expect(claimSubagentSlot(SESSION)?.slotIndex).toBe(5);
  });

  it('reuses a lane once its subagent is removed', () => {
    setSessionSubagentModelPlanForSession(SESSION, planWith({ model: 'a' }, { model: 'b' }));
    const first = claimSubagentSlot(SESSION);
    first?.bind('sub-1');
    const second = claimSubagentSlot(SESSION);
    second?.bind('sub-2');
    expect(second?.slotIndex).toBe(1);

    releaseSubagentSlot('sub-1');
    const third = claimSubagentSlot(SESSION);
    expect(third?.slotIndex).toBe(0);
  });

  it('returns an abandoned lane immediately', () => {
    setSessionSubagentModelPlanForSession(SESSION, planWith({ model: 'a' }, { model: 'b' }));
    const first = claimSubagentSlot(SESSION);
    first?.abandon();
    expect(claimSubagentSlot(SESSION)?.slotIndex).toBe(0);
  });

  it('spreads onto the least-loaded lane when every lane is busy', () => {
    setSessionSubagentModelPlanForSession(SESSION, planWith({ model: 'a' }, { model: 'b' }));
    claimSubagentSlot(SESSION)?.bind('s1'); // lane 0
    claimSubagentSlot(SESSION)?.bind('s2'); // lane 1
    claimSubagentSlot(SESSION)?.bind('s3'); // wraps to lane 0
    expect(claimSubagentSlot(SESSION)?.slotIndex).toBe(1);
  });

  it('release is idempotent and ignores unknown ids', () => {
    setSessionSubagentModelPlanForSession(SESSION, planWith({ model: 'a' }));
    claimSubagentSlot(SESSION)?.bind('s1');
    releaseSubagentSlot('s1');
    releaseSubagentSlot('s1');
    releaseSubagentSlot('never-spawned');
    expect(subagentSlotOccupancy(SESSION)[0]?.subagentIds).toEqual([]);
  });

  it('prefers a role overlay and burns no lane for it', () => {
    const plan = planWith({ model: 'lane-a' });
    plan.roles = { reviewer: { provider: 'anthropic', model: 'opus' } };
    setSessionSubagentModelPlanForSession(SESSION, plan);

    const reviewer = claimSubagentSlot(SESSION, { role: 'reviewer' });
    expect(reviewer?.slotIndex).toBeUndefined();
    expect(reviewer?.target).toEqual({ provider: 'anthropic', model: 'opus' });

    // The lane is still free for the next non-reviewer spawn.
    expect(claimSubagentSlot(SESSION, { role: 'executor' })?.slotIndex).toBe(0);
  });

  it('claims nothing when the plan is disabled, empty, or absent', () => {
    expect(claimSubagentSlot(SESSION)).toBeUndefined();
    expect(claimSubagentSlot(undefined)).toBeUndefined();

    setSessionSubagentModelPlanForSession(SESSION, emptySubagentModelPlan());
    expect(claimSubagentSlot(SESSION)).toBeUndefined();

    const disabled = planWith({ model: 'a' });
    disabled.enabled = false;
    setSessionSubagentModelPlanForSession(SESSION, disabled);
    expect(claimSubagentSlot(SESSION)).toBeUndefined();
  });

  it('keeps sessions isolated from each other', () => {
    setSessionSubagentModelPlanForSession(SESSION, planWith({ model: 'a' }, { model: 'b' }));
    setSessionSubagentModelPlanForSession('other', planWith({ model: 'x' }, { model: 'y' }));
    claimSubagentSlot(SESSION)?.bind('s1');
    expect(claimSubagentSlot('other')?.slotIndex).toBe(0);
  });

  it('does not hand out a lane index the plan no longer has', () => {
    setSessionSubagentModelPlanForSession(
      SESSION,
      planWith({ model: 'a' }, { model: 'b' }, { model: 'c' }),
    );
    claimSubagentSlot(SESSION)?.bind('s1');
    claimSubagentSlot(SESSION)?.bind('s2');

    const shrunk = normalizeSubagentModelPlan({ slots: [{ model: 'only' }] });
    setSessionSubagentModelPlanForSession(SESSION, shrunk);
    const claim = claimSubagentSlot(SESSION);
    expect(claim?.slotIndex).toBe(0);
    expect(claim?.target.model).toBe('only');
  });
});

describe('persistence', () => {
  it('journals the plan and applies it to the live session', async () => {
    const appended: unknown[] = [];
    const ctx = {
      meta: {} as Record<string, unknown>,
      session: { id: SESSION, append: async (e: unknown) => void appended.push(e) },
    };
    await setSessionSubagentModelPlan(ctx as never, planWith({ provider: 'openai', model: 'g' }));

    expect((appended[0] as { type: string }).type).toBe('subagent_model_plan');
    expect(getSessionSubagentModelPlan(SESSION)?.slots[0]).toEqual({
      provider: 'openai',
      model: 'g',
    });
  });

  it('restores the LAST plan event on resume', () => {
    const events: SessionEvent[] = [
      {
        type: 'subagent_model_plan',
        ts: '2026-01-01T00:00:00.000Z',
        plan: planWith({ model: 'old' }),
      },
      {
        type: 'subagent_model_plan',
        ts: '2026-01-02T00:00:00.000Z',
        plan: planWith({ model: 'new' }),
      },
    ] as SessionEvent[];
    const ctx = {
      meta: {} as Record<string, unknown>,
      session: { id: SESSION, append: async () => {} },
    };
    restoreSessionSubagentModelPlan(ctx as never, events);
    expect(getSessionSubagentModelPlan(SESSION)?.slots[0]?.model).toBe('new');
  });

  it('leaves a session untouched when the journal holds no plan', () => {
    const ctx = {
      meta: {} as Record<string, unknown>,
      session: { id: SESSION, append: async () => {} },
    };
    restoreSessionSubagentModelPlan(
      ctx as never,
      [
        { type: 'subagent_policy', ts: '2026-01-01T00:00:00.000Z', allowed: true },
      ] as SessionEvent[],
    );
    expect(getSessionSubagentModelPlan(SESSION)).toBeUndefined();
  });
});

describe('lock semantics in the resolver', () => {
  const lane = { provider: 'anthropic', model: 'opus' };

  function resolve(config: SubagentConfig, lock: boolean): SubagentConfig {
    // Every pin in this block stands in for a LEADER pin, which is the only
    // kind the lock may override.
    if (config.provider || config.model) config.modelChosenByLeader = true;
    resolveDirectorSpawnModel(config, {
      sessionPlan: { kind: 'lane', target: lane, lock, slotIndex: 0 },
    });
    return config;
  }

  it('drops the fallback chain the leader chose for its own model', () => {
    // The chain's entries were picked to back gpt-5-mini. Keeping it would send
    // this worker straight back to the leader's models on the first 429 — the
    // decision the lock just took away.
    const config = resolve(
      {
        name: 'w',
        provider: 'openai',
        model: 'gpt-5-mini',
        fallbackModels: ['openai/gpt-5', 'openai/gpt-5-nano'],
      },
      true,
    );
    expect(config).toMatchObject({ provider: 'anthropic', model: 'opus' });
    expect(config.fallbackModels).toBeUndefined();
  });

  it('keeps the leader chain when the lock is off', () => {
    const config = resolve(
      { name: 'w', provider: 'openai', model: 'gpt-5-mini', fallbackModels: ['openai/gpt-5'] },
      false,
    );
    expect(config).toMatchObject({ provider: 'openai', model: 'gpt-5-mini' });
    expect(config.fallbackModels).toEqual(['openai/gpt-5']);
  });

  it('drops a leader tier and runtime override along with the pair', () => {
    const config = resolve(
      {
        name: 'w',
        provider: 'openai',
        model: 'gpt-5-mini',
        tier: 'premium',
        fallbackProfile: 'leader-profile',
        modelRuntime: { reasoning: { effort: 'high' } },
      } as SubagentConfig,
      true,
    );
    expect(config.tier).toBeUndefined();
    expect(config.fallbackProfile).toBeUndefined();
    expect(config.modelRuntime).toBeUndefined();
  });

  it('leaves a spawn alone when the lane is empty', () => {
    const config: SubagentConfig = { name: 'w', provider: 'openai', model: 'gpt-5-mini' };
    resolveDirectorSpawnModel(config, {
      sessionPlan: { kind: 'lane', target: {}, lock: true, slotIndex: 0 },
    });
    expect(config).toMatchObject({ provider: 'openai', model: 'gpt-5-mini' });
  });
});
