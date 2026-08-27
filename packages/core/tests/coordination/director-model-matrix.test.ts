import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_CATALOG } from '../../src/coordination/agents/index.js';
import { Director } from '../../src/coordination/director.js';
import { phaseForRole } from '../../src/coordination/model-matrix.js';
import type { SubagentRunner } from '../../src/types/multi-agent.js';

/** Owning session for coordinator-scoped work under test. */
const TEST_SESSION_ID = 'sess_test';

const role = Object.keys(AGENT_CATALOG)[0]!;
const phase = phaseForRole(role)!;

// Minimal runner — these tests only exercise spawn(), not task execution.
const noopRunner: SubagentRunner = async (task) => ({
  result: task.description,
  iterations: 0,
  toolCalls: 0,
});

type MatrixSource =
  | Record<string, { provider?: string; model: string }>
  | (() => Record<string, { provider?: string; model: string }> | undefined);

function makeDirector(
  modelMatrix?: MatrixSource,
  session?: { provider?: string; model?: string },
): Director {
  return new Director({
    sessionId: TEST_SESSION_ID,
    config: {
      coordinatorId: 'mm-test',
      doneCondition: { type: 'all_tasks_done' },
      maxConcurrent: 2,
    },
    runner: noopRunner,
    modelMatrix,
    sessionProvider: session?.provider,
    sessionModel: session?.model,
  });
}

/** Capture every `subagent.spawned` payload, in order. */
function captureAllSpawned(d: Director): Array<{ provider?: string; model?: string }> {
  const out: Array<{ provider?: string; model?: string }> = [];
  d.fleet.onAny((e) => {
    if (e.type === 'subagent.spawned') {
      const p = e.payload as { provider?: string; model?: string };
      out.push({ provider: p.provider, model: p.model });
    }
  });
  return out;
}

/** Capture the first `subagent.spawned` payload emitted on the fleet bus. */
function captureSpawned(d: Director): { current?: { provider?: string; model?: string } } {
  const box: { current?: { provider?: string; model?: string } } = {};
  d.fleet.onAny((e) => {
    if (e.type === 'subagent.spawned' && !box.current) {
      const p = e.payload as { provider?: string; model?: string };
      box.current = { provider: p.provider, model: p.model };
    }
  });
  return box;
}

describe('Director model matrix', () => {
  let director: Director | undefined;
  afterEach(async () => {
    await director?.shutdown().catch(() => {});
    director = undefined;
  });

  it('resolves a role entry when no explicit model is set', async () => {
    const d = makeDirector({ [role]: { provider: 'minimax', model: 'minimax-m3' } });
    director = d;
    const spawned = captureSpawned(d);
    await d.spawn({ name: role, role });
    expect(spawned.current).toEqual({ provider: 'minimax', model: 'minimax-m3' });
  });

  it('falls back to the phase entry', async () => {
    const d = makeDirector({ [phase]: { provider: 'zai', model: 'glm-5-turbo' } });
    director = d;
    const spawned = captureSpawned(d);
    await d.spawn({ name: role, role });
    expect(spawned.current).toEqual({ provider: 'zai', model: 'glm-5-turbo' });
  });

  it('does NOT override an explicit per-spawn model', async () => {
    const d = makeDirector({ [role]: { provider: 'minimax', model: 'minimax-m3' } });
    director = d;
    const spawned = captureSpawned(d);
    await d.spawn({ name: role, role, provider: 'anthropic', model: 'claude-haiku-4-5' });
    expect(spawned.current).toEqual({ provider: 'anthropic', model: 'claude-haiku-4-5' });
  });

  it('honors an exact reviewer route so /setmodel set reviewer works', async () => {
    const d = makeDirector({ reviewer: { provider: 'openai', model: 'gpt-5' } });
    director = d;
    const spawned = captureSpawned(d);
    await d.spawn({ name: 'Reviewer', role: 'reviewer' });
    expect(spawned.current).toEqual({ provider: 'openai', model: 'gpt-5' });
  });

  it('does not pre-apply the wildcard route to reviewer so the factory can diversify it', async () => {
    const d = makeDirector({ '*': { provider: 'anthropic', model: 'anthropic-test-model' } });
    director = d;
    const spawned = captureSpawned(d);
    await d.spawn({ name: 'Reviewer', role: 'reviewer' });
    expect(spawned.current?.model).toBeUndefined();
    expect(spawned.current?.provider).toBeUndefined();
  });

  it('leaves model unset when no matrix entry matches', async () => {
    const d = makeDirector({ 'some-other-role': { model: 'x' } });
    director = d;
    const spawned = captureSpawned(d);
    await d.spawn({ name: role, role });
    expect(spawned.current?.model).toBeUndefined();
  });

  it('normalizes blank spawn fields before resolving the matrix', async () => {
    const d = makeDirector({ [role]: { provider: 'minimax', model: 'minimax-m3' } });
    director = d;
    const spawned = captureSpawned(d);
    await d.spawn({ name: role, role, provider: '   ', model: '' });
    expect(spawned.current).toEqual({ provider: 'minimax', model: 'minimax-m3' });
  });

  it('falls back to the session provider and model when the matrix does not resolve', async () => {
    const d = makeDirector(undefined, { provider: 'anthropic', model: 'claude-sonnet' });
    director = d;
    const spawned = captureSpawned(d);
    await d.spawn({ name: role, role });
    expect(spawned.current).toEqual({ provider: 'anthropic', model: 'claude-sonnet' });
  });

  it('preserves a model-only matrix route while filling only its missing provider', async () => {
    const d = makeDirector(
      { [role]: { model: 'role-specific-model' } },
      { provider: 'anthropic', model: 'session-model' },
    );
    director = d;
    const spawned = captureSpawned(d);
    await d.spawn({ name: role, role });
    expect(spawned.current).toEqual({ provider: 'anthropic', model: 'role-specific-model' });
  });

  it('fills only the missing provider from session when matrix provides only model', async () => {
    const d = makeDirector(
      { [role]: { model: 'matrix-model' } },
      { provider: 'anthropic' }, // no sessionModel
    );
    director = d;
    const spawned = captureSpawned(d);
    await d.spawn({ name: role, role });
    // Session provider fills in but session model is absent — matrix model must survive.
    expect(spawned.current).toEqual({ provider: 'anthropic', model: 'matrix-model' });
  });

  it('fills only the missing model from session when matrix provides only provider', async () => {
    const d = makeDirector(
      { [role]: { provider: 'minimax' } },
      { model: 'session-model' }, // no sessionProvider
    );
    director = d;
    const spawned = captureSpawned(d);
    await d.spawn({ name: role, role });
    // Session model fills in but session provider is absent — matrix provider must survive.
    expect(spawned.current).toEqual({ provider: 'minimax', model: 'session-model' });
  });

  it('does not let a partial session override a fully-resolved matrix entry', async () => {
    const d = makeDirector(
      { [role]: { provider: 'zai', model: 'glm-5-turbo' } },
      { provider: 'anthropic' }, // partial session, not needed
    );
    director = d;
    const spawned = captureSpawned(d);
    await d.spawn({ name: role, role });
    // Matrix fully resolved — session provider must not overwrite matrix provider.
    expect(spawned.current).toEqual({ provider: 'zai', model: 'glm-5-turbo' });
  });

  it('fills only the available session field when matrix resolves nothing', async () => {
    const d = makeDirector(undefined, { provider: 'anthropic' }); // no sessionModel
    director = d;
    const spawned = captureSpawned(d);
    await d.spawn({ name: role, role });
    // Only provider field is filled; model remains undefined.
    expect(spawned.current).toEqual({ provider: 'anthropic', model: undefined });
  });

  it('re-reads a live (function) matrix on every spawn', async () => {
    // Simulates a mid-session `/setmodel`: the source mutates between spawns.
    let current: Record<string, { provider?: string; model: string }> = {
      [role]: { provider: 'minimax', model: 'minimax-m3' },
    };
    const d = makeDirector(() => current);
    director = d;
    const spawned = captureAllSpawned(d);

    await d.spawn({ name: role, role });
    current = { [role]: { provider: 'zai', model: 'glm-5-turbo' } };
    await d.spawn({ name: role, role });

    expect(spawned[0]).toEqual({ provider: 'minimax', model: 'minimax-m3' });
    expect(spawned[1]).toEqual({ provider: 'zai', model: 'glm-5-turbo' });
  });
});
