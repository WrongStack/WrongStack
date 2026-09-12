import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Director } from '../../src/coordination/director.js';
import {
  __resetAllSessionSubagentModelPlans,
  emptySubagentModelPlan,
  type SessionSubagentModelPlan,
  type SubagentSlot,
  setSessionSubagentModelPlanForSession,
} from '../../src/coordination/session-subagent-models.js';
import type { SubagentRunner } from '../../src/types/multi-agent.js';

const TEST_SESSION_ID = 'sess_plan_director';

const noopRunner: SubagentRunner = async (task) => ({
  result: task.description,
  iterations: 0,
  toolCalls: 0,
});

function makeDirector(
  opts: {
    matrix?: Record<string, never>;
    session?: { provider?: string; model?: string };
    /** Live session target, mirroring the getter the CLI host wires. */
    liveSession?: () => { provider: string; model: string };
  } = {},
): Director {
  if (opts.liveSession) {
    const live = opts.liveSession;
    return new Director({
      sessionId: TEST_SESSION_ID,
      config: {
        coordinatorId: 'plan-test',
        doneCondition: { type: 'all_tasks_done' },
        maxConcurrent: 8,
      },
      runner: noopRunner,
      ...(opts.matrix ? { modelMatrix: opts.matrix } : {}),
      sessionProvider: () => live().provider,
      sessionModel: () => live().model,
    });
  }
  return new Director({
    sessionId: TEST_SESSION_ID,
    config: {
      coordinatorId: 'plan-test',
      doneCondition: { type: 'all_tasks_done' },
      maxConcurrent: 8,
    },
    runner: noopRunner,
    ...(opts.matrix ? { modelMatrix: opts.matrix } : {}),
    ...(opts.session?.provider ? { sessionProvider: opts.session.provider } : {}),
    ...(opts.session?.model ? { sessionModel: opts.session.model } : {}),
  });
}

/** Every `subagent.spawned` payload, in spawn order. */
function captureSpawned(d: Director): Array<{ provider?: string; model?: string }> {
  const out: Array<{ provider?: string; model?: string }> = [];
  d.fleet.onAny((e) => {
    if (e.type === 'subagent.spawned') {
      const p = e.payload as { provider?: string; model?: string };
      out.push({ provider: p.provider, model: p.model });
    }
  });
  return out;
}

function installPlan(
  lanes: SubagentSlot[],
  overrides: Partial<SessionSubagentModelPlan> = {},
): void {
  const plan = emptySubagentModelPlan();
  lanes.forEach((lane, i) => {
    plan.slots[i] = lane;
  });
  Object.assign(plan, overrides);
  setSessionSubagentModelPlanForSession(TEST_SESSION_ID, plan);
}

describe('Director session subagent model plan', () => {
  let director: Director | undefined;

  beforeEach(() => __resetAllSessionSubagentModelPlans());
  afterEach(async () => {
    await director?.shutdown().catch(() => {});
    director = undefined;
    __resetAllSessionSubagentModelPlans();
  });

  it('runs parallel spawns on different lanes', async () => {
    installPlan([
      { provider: 'anthropic', model: 'opus' },
      { provider: 'openai', model: 'gpt-5' },
      { provider: 'zai', model: 'glm-5' },
    ]);
    const d = makeDirector();
    director = d;
    const spawned = captureSpawned(d);

    await d.spawn({ name: 'w1' });
    await d.spawn({ name: 'w2' });
    await d.spawn({ name: 'w3' });

    expect(spawned).toEqual([
      { provider: 'anthropic', model: 'opus' },
      { provider: 'openai', model: 'gpt-5' },
      { provider: 'zai', model: 'glm-5' },
    ]);
  });

  it('overrides a leader-supplied provider/model while locked', async () => {
    installPlan([{ provider: 'anthropic', model: 'opus' }]);
    const d = makeDirector();
    director = d;
    const spawned = captureSpawned(d);

    // `modelChosenByLeader` is what `spawn_subagent` / `delegate` stamp when
    // the LEADER filled in the provider/model fields.
    await d.spawn({
      name: 'w1',
      provider: 'openai',
      model: 'gpt-5-mini',
      modelChosenByLeader: true,
    });

    expect(spawned[0]).toEqual({ provider: 'anthropic', model: 'opus' });
  });

  it('leaves a HUMAN pin alone even while locked', async () => {
    // `/spawn --model=…`, an ACP flag, a Kanban route someone authored: a
    // one-off the person typed is more specific than a standing lane, so the
    // lock — which exists to take the decision back from the LEADER — does not
    // touch it.
    installPlan([{ provider: 'anthropic', model: 'opus' }]);
    const d = makeDirector();
    director = d;
    const spawned = captureSpawned(d);

    await d.spawn({ name: 'w1', provider: 'openai', model: 'typed-by-hand' });

    expect(spawned[0]).toEqual({ provider: 'openai', model: 'typed-by-hand' });
  });

  it('steps aside wholesale for a half-pinned human spawn', async () => {
    // Only a model was typed. Filling the provider from the lane would name a
    // pair that exists in neither place, so the lane stays out of it and the
    // session provider fills the gap, exactly as before the plan existed.
    installPlan([{ provider: 'anthropic', model: 'opus' }]);
    const d = makeDirector({ session: { provider: 'zai', model: 'session-model' } });
    director = d;
    const spawned = captureSpawned(d);

    await d.spawn({ name: 'w1', model: 'typed-by-hand' });

    expect(spawned[0]).toEqual({ provider: 'zai', model: 'typed-by-hand' });
  });

  it('leaves the lane free when a human-pinned spawn goes past', async () => {
    installPlan([{ provider: 'anthropic', model: 'opus' }]);
    const d = makeDirector();
    director = d;
    const spawned = captureSpawned(d);

    await d.spawn({ name: 'pinned', provider: 'openai', model: 'typed-by-hand' });
    await d.spawn({ name: 'plain' });

    expect(spawned[1]).toEqual({ provider: 'anthropic', model: 'opus' });
  });

  it('still fills a human spawn that named no model', async () => {
    installPlan([{ provider: 'anthropic', model: 'opus' }]);
    const d = makeDirector();
    director = d;
    const spawned = captureSpawned(d);

    await d.spawn({ name: 'w1' });

    expect(spawned[0]).toEqual({ provider: 'anthropic', model: 'opus' });
  });

  it('leaves the leader pin alone when the lock is off', async () => {
    installPlan([{ provider: 'anthropic', model: 'opus' }], { lock: false });
    const d = makeDirector();
    director = d;
    const spawned = captureSpawned(d);

    await d.spawn({
      name: 'w1',
      provider: 'openai',
      model: 'gpt-5-mini',
      modelChosenByLeader: true,
    });

    expect(spawned[0]).toEqual({ provider: 'openai', model: 'gpt-5-mini' });
  });

  it('still fills an unpinned spawn when the lock is off', async () => {
    installPlan([{ provider: 'anthropic', model: 'opus' }], { lock: false });
    const d = makeDirector();
    director = d;
    const spawned = captureSpawned(d);

    await d.spawn({ name: 'w1' });

    expect(spawned[0]).toEqual({ provider: 'anthropic', model: 'opus' });
  });

  it('never pairs a locked lane provider with the leader model', async () => {
    // The lane names only a provider. The leader's model must NOT survive next
    // to it — that pair exists in neither place. The session model fills in.
    installPlan([{ provider: 'anthropic' }]);
    const d = makeDirector({ session: { provider: 'openai', model: 'session-model' } });
    director = d;
    const spawned = captureSpawned(d);

    await d.spawn({
      name: 'w1',
      provider: 'openai',
      model: 'gpt-5-mini',
      modelChosenByLeader: true,
    });

    expect(spawned[0]).toEqual({ provider: 'anthropic', model: 'session-model' });
  });

  it('beats the global model matrix', async () => {
    installPlan([{ provider: 'anthropic', model: 'opus' }]);
    const d = makeDirector({
      matrix: { '*': { provider: 'matrix-provider', model: 'matrix-model' } } as never,
    });
    director = d;
    const spawned = captureSpawned(d);

    await d.spawn({ name: 'w1' });

    expect(spawned[0]).toEqual({ provider: 'anthropic', model: 'opus' });
  });

  it('keeps a lane provider when the matrix would have overwritten it', async () => {
    installPlan([{ provider: 'anthropic' }]);
    const d = makeDirector({
      matrix: { '*': { provider: 'matrix-provider', model: 'matrix-model' } } as never,
    });
    director = d;
    const spawned = captureSpawned(d);

    await d.spawn({ name: 'w1' });

    expect(spawned[0]).toEqual({ provider: 'anthropic', model: 'matrix-model' });
  });

  it('applies a role overlay ahead of the lanes, consuming none', async () => {
    installPlan([{ provider: 'anthropic', model: 'opus' }], {
      roles: { reviewer: { provider: 'openai', model: 'gpt-5' } },
    });
    const d = makeDirector();
    director = d;
    const spawned = captureSpawned(d);

    await d.spawn({ name: 'rev', role: 'reviewer' });
    await d.spawn({ name: 'exec', role: 'executor' });

    expect(spawned).toEqual([
      { provider: 'openai', model: 'gpt-5' },
      { provider: 'anthropic', model: 'opus' },
    ]);
  });

  it('steps aside for an explicit /setmodel role route', async () => {
    // Routing stays routing: a role the user deliberately pinned is not a
    // "plain" spawn, so the lane does not take it.
    installPlan([{ provider: 'anthropic', model: 'opus' }]);
    const d = makeDirector({
      matrix: { reviewer: { provider: 'routed-provider', model: 'routed-model' } } as never,
    });
    director = d;
    const spawned = captureSpawned(d);

    await d.spawn({ name: 'rev', role: 'reviewer' });

    expect(spawned[0]).toEqual({ provider: 'routed-provider', model: 'routed-model' });
  });

  it('keeps the lane free for the next plain spawn when a route took one', async () => {
    installPlan([{ provider: 'anthropic', model: 'opus' }]);
    const d = makeDirector({
      matrix: { reviewer: { provider: 'routed-provider', model: 'routed-model' } } as never,
    });
    director = d;
    const spawned = captureSpawned(d);

    await d.spawn({ name: 'rev', role: 'reviewer' });
    await d.spawn({ name: 'plain' });

    expect(spawned[1]).toEqual({ provider: 'anthropic', model: 'opus' });
  });

  it('lets a session role override beat an explicit route', async () => {
    installPlan([], {
      roles: { reviewer: { provider: 'session-role', model: 'session-role-model' } },
    });
    const d = makeDirector({
      matrix: { reviewer: { provider: 'routed-provider', model: 'routed-model' } } as never,
    });
    director = d;
    const spawned = captureSpawned(d);

    await d.spawn({ name: 'rev', role: 'reviewer' });

    expect(spawned[0]).toEqual({ provider: 'session-role', model: 'session-role-model' });
  });

  it('runs every plain spawn on the session model when asked to', async () => {
    installPlan([{ provider: 'anthropic', model: 'opus' }], { followSessionModel: true });
    const d = makeDirector({ session: { provider: 'openai', model: 'session-model' } });
    director = d;
    const spawned = captureSpawned(d);

    // Beats the lanes (the coarser statement of the same intent) and the
    // leader's own pin.
    await d.spawn({
      name: 'w1',
      provider: 'leader-provider',
      model: 'leader-model',
      modelChosenByLeader: true,
    });
    await d.spawn({ name: 'w2' });

    expect(spawned).toEqual([
      { provider: 'openai', model: 'session-model' },
      { provider: 'openai', model: 'session-model' },
    ]);
  });

  it('leaves a routed role alone even while following the session model', async () => {
    installPlan([], { followSessionModel: true });
    const d = makeDirector({
      matrix: { reviewer: { provider: 'routed-provider', model: 'routed-model' } } as never,
      session: { provider: 'openai', model: 'session-model' },
    });
    director = d;
    const spawned = captureSpawned(d);

    await d.spawn({ name: 'rev', role: 'reviewer' });
    await d.spawn({ name: 'plain' });

    expect(spawned).toEqual([
      { provider: 'routed-provider', model: 'routed-model' },
      { provider: 'openai', model: 'session-model' },
    ]);
  });

  it('frees the lane when the subagent is removed', async () => {
    installPlan([
      { provider: 'anthropic', model: 'opus' },
      { provider: 'openai', model: 'gpt-5' },
    ]);
    const d = makeDirector();
    director = d;
    const spawned = captureSpawned(d);

    const first = await d.spawn({ name: 'w1' });
    await d.remove(first);
    await d.spawn({ name: 'w2' });

    expect(spawned[1]).toEqual({ provider: 'anthropic', model: 'opus' });
  });

  it('follows the ASKING conversation, not the host that booted', async () => {
    // Several WebUI tabs share one Director process: the host's own session is
    // the boot tab, and `spawn_subagent` / `delegate` stamp the caller's
    // session on the config. A lane plan must resolve against THAT stamp, or
    // every tab would route through the boot tab's lanes.
    const otherSession = 'sess_other_tab';
    installPlan([{ provider: 'anthropic', model: 'boot-tab-model' }]);
    const otherPlan = emptySubagentModelPlan();
    otherPlan.slots[0] = { provider: 'openai', model: 'other-tab-model' };
    setSessionSubagentModelPlanForSession(otherSession, otherPlan);

    const d = makeDirector();
    director = d;
    const spawned = captureSpawned(d);

    await d.spawn({ name: 'from-other-tab', originSessionId: otherSession });
    await d.spawn({ name: 'from-boot-tab' });

    expect(spawned).toEqual([
      { provider: 'openai', model: 'other-tab-model' },
      { provider: 'anthropic', model: 'boot-tab-model' },
    ]);
  });

  it('frees the lane of the session that owned it', async () => {
    const otherSession = 'sess_other_tab';
    const otherPlan = emptySubagentModelPlan();
    otherPlan.slots[0] = { provider: 'openai', model: 'a' };
    otherPlan.slots[1] = { provider: 'openai', model: 'b' };
    setSessionSubagentModelPlanForSession(otherSession, otherPlan);

    const d = makeDirector();
    director = d;
    const spawned = captureSpawned(d);

    const first = await d.spawn({ name: 'w1', originSessionId: otherSession });
    await d.remove(first);
    await d.spawn({ name: 'w2', originSessionId: otherSession });

    expect(spawned[1]).toEqual({ provider: 'openai', model: 'a' });
  });

  it('reports the lane model back to the leader, not what it asked for', async () => {
    // `spawn_subagent` echoes the spawn's provider/model to the leader. The
    // ladder resolves inside `spawn()` on a COPY, so echoing the request would
    // describe a worker that does not exist.
    installPlan([{ provider: 'anthropic', model: 'opus' }]);
    const d = makeDirector();
    director = d;

    const subagentId = await d.spawn({
      name: 'w1',
      provider: 'openai',
      model: 'gpt-5-mini',
      modelChosenByLeader: true,
    });

    expect(d.resolvedModelFor(subagentId)).toMatchObject({
      provider: 'anthropic',
      model: 'opus',
    });
  });

  it('follows a mid-session /model switch', async () => {
    // The host wires the session target as a GETTER. A snapshot taken when the
    // fleet was built would pin every later worker — and the "use my model"
    // switch — to the model the leader happened to run on back then.
    installPlan([], { followSessionModel: true });
    const live = { provider: 'anthropic', model: 'before-switch' };
    const d = makeDirector({ liveSession: () => live });
    director = d;
    const spawned = captureSpawned(d);

    await d.spawn({ name: 'w1' });
    live.provider = 'openai';
    live.model = 'after-switch';
    await d.spawn({ name: 'w2' });

    expect(spawned).toEqual([
      { provider: 'anthropic', model: 'before-switch' },
      { provider: 'openai', model: 'after-switch' },
    ]);
  });

  it('follows a mid-session switch through the plain session fallback too', async () => {
    const live = { provider: 'anthropic', model: 'before-switch' };
    const d = makeDirector({ liveSession: () => live });
    director = d;
    const spawned = captureSpawned(d);

    await d.spawn({ name: 'w1' });
    live.model = 'after-switch';
    await d.spawn({ name: 'w2' });

    expect(spawned[1]).toEqual({ provider: 'anthropic', model: 'after-switch' });
  });

  it('changes nothing when no plan is installed', async () => {
    const d = makeDirector({ session: { provider: 'openai', model: 'session-model' } });
    director = d;
    const spawned = captureSpawned(d);

    await d.spawn({ name: 'w1' });

    expect(spawned[0]).toEqual({ provider: 'openai', model: 'session-model' });
  });
});
