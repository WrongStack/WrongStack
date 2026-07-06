import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_CATALOG } from '../../src/coordination/agents/index.js';
import { Director } from '../../src/coordination/director.js';
import { phaseForRole } from '../../src/coordination/model-matrix.js';
import type { SubagentRunner } from '../../src/types/multi-agent.js';

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

function makeDirector(modelMatrix?: MatrixSource): Director {
  return new Director({
    config: {
      coordinatorId: 'mm-test',
      doneCondition: { type: 'all_tasks_done' },
      maxConcurrent: 2,
    },
    runner: noopRunner,
    modelMatrix,
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
