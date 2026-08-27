/**
 * Regression coverage for the Chimera spawn-budget lockup (2026-08):
 * ephemeral reviewer/cascade spawns are marked `spawnBudgetExempt` and must
 * neither consume nor be blocked by the leader director's lifetime
 * `maxSpawns` budget. Before this fix, every ladder rung spawned a real
 * subagent against the shared lifetime counter (increment-only, never
 * decremented on terminate), so ~16–30 auto-reviews permanently exhausted
 * the default budget of 64 and bricked every subsequent spawn in the
 * session — including the leader's own delegations.
 *
 * Covers both enforcement paths: FleetManager (default production path)
 * and the Director's inline fallback (no FleetManager).
 */
import { describe, expect, it } from 'vitest';
import { Director, FleetSpawnBudgetError } from '../../src/coordination/director.js';
import { FleetManager } from '../../src/coordination/fleet-manager.js';
import type {
  MultiAgentConfig,
  SubagentRunner,
  SubagentRunOutcome,
} from '../../src/types/multi-agent.js';

/** Owning session for coordinator-scoped work under test. */
const TEST_SESSION_ID = 'sess_test';

function makeConfig(): MultiAgentConfig {
  return {
    coordinatorId: 'spawn-budget-exempt',
    doneCondition: { type: 'all_tasks_done' },
  };
}

/** These tests only spawn and terminate, so the runner is never invoked. */
function makeRunner(): SubagentRunner {
  return async (): Promise<SubagentRunOutcome> => ({
    result: 'done',
    iterations: 1,
    toolCalls: 0,
  });
}

/** A full reviewer-ladder exhaustion: 4 exempt rungs, each terminated. */
async function runExhaustedLadder(d: Director): Promise<void> {
  for (let rung = 0; rung < 4; rung++) {
    const id = await d.spawn({
      name: `chimera-review-rung-${rung}`,
      role: 'reviewer',
      spawnBudgetExempt: true,
    });
    await d.terminate(id);
  }
}

describe('spawnBudgetExempt — FleetManager path (production default)', () => {
  it('ladder exhaustion + rung termination does not consume the leader spawn budget', async () => {
    const fleetManager = new FleetManager({ maxSpawns: 1 });
    const d = new Director({
      sessionId: TEST_SESSION_ID,
      config: makeConfig(),
      runner: makeRunner(),
      maxSpawns: 1,
      fleetManager,
    });

    await runExhaustedLadder(d);

    // The leader's lifetime budget is untouched: its one real spawn lands.
    const leaderSpawn = await d.spawn({ name: 'leader-worker' });
    expect(leaderSpawn).toBeTruthy();
    expect(fleetManager.budgetSnapshot().usedSpawns).toBe(1);

    // And the cap still binds real leader spawns afterwards.
    await expect(d.spawn({ name: 'leader-worker-2' })).rejects.toBeInstanceOf(
      FleetSpawnBudgetError,
    );
  });

  it('admits exempt spawns even when the leader budget is already exhausted', async () => {
    const fleetManager = new FleetManager({ maxSpawns: 1 });
    const d = new Director({
      sessionId: TEST_SESSION_ID,
      config: makeConfig(),
      runner: makeRunner(),
      maxSpawns: 1,
      fleetManager,
    });

    // Exhaust the leader budget with a real spawn.
    await d.spawn({ name: 'leader-worker' });
    await expect(d.spawn({ name: 'leader-worker-2' })).rejects.toBeInstanceOf(
      FleetSpawnBudgetError,
    );

    // Reviews keep running: exempt spawns bypass only the max_spawns check.
    await runExhaustedLadder(d);
    expect(fleetManager.budgetSnapshot().usedSpawns).toBe(1);
  });
});

describe('spawnBudgetExempt — inline path (no FleetManager)', () => {
  it('does not increment Director.spawnCount and bypasses only the max_spawns check', async () => {
    const d = new Director({
      sessionId: TEST_SESSION_ID,
      config: makeConfig(),
      runner: makeRunner(),
      maxSpawns: 1,
    });

    await runExhaustedLadder(d);
    expect(d.spawnCount).toBe(0);

    await d.spawn({ name: 'leader-worker' });
    expect(d.spawnCount).toBe(1);
    await expect(d.spawn({ name: 'leader-worker-2' })).rejects.toBeInstanceOf(
      FleetSpawnBudgetError,
    );

    // Exempt spawns still admitted with the budget exhausted.
    const id = await d.spawn({ name: 'chimera-review', spawnBudgetExempt: true });
    expect(id).toBeTruthy();
    expect(d.spawnCount).toBe(1);
  });
});
