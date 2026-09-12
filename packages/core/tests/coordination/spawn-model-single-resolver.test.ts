import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Director } from '../../src/coordination/director.js';
import { spawn as fleetSpawn } from '../../src/coordination/fleet-spawn.js';
import {
  __resetAllSessionSubagentModelPlans,
  emptySubagentModelPlan,
  setSessionSubagentModelPlanForSession,
} from '../../src/coordination/session-subagent-models.js';
import type { SubagentRunner } from '../../src/types/multi-agent.js';

/**
 * One resolver, one precedence order.
 *
 * `resolveDirectorSpawnModel` is the only place a subagent's provider/model is
 * decided. fleet-spawn.ts used to carry a partial COPY of the matrix step, and
 * that copy re-applied `entry.provider` unconditionally — so a provider pinned
 * by a higher-precedence layer (the session lane plan, or the caller) could be
 * silently overwritten on the way to the coordinator.
 *
 * These tests probe the seam by INJECTION rather than by reading the happy
 * path: seeing the plan applied on a normal spawn proves nothing about a second
 * resolver hiding downstream.
 */

const TEST_SESSION_ID = 'sess_single_resolver';

const noopRunner: SubagentRunner = async (task) => ({
  result: task.description,
  iterations: 0,
  toolCalls: 0,
});

describe('spawn model resolution has a single owner', () => {
  beforeEach(() => __resetAllSessionSubagentModelPlans());
  afterEach(() => __resetAllSessionSubagentModelPlans());

  it('fleet-spawn does not import the matrix resolver', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../src/coordination/fleet-spawn.ts', import.meta.url)),
      'utf8',
    );
    // Comments are stripped first: the file explains WHY resolution does not
    // live here, and naming the resolver in prose must not trip the guard.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/resolveModelMatrix|resolveDirectorSpawnModel|resolveTier/);
  });

  it('fleet-spawn leaves an already-resolved config untouched', async () => {
    // Inject a config that a lane has already claimed, with a matrix that would
    // have overwritten it if any resolution still happened here.
    const host = {
      id: 'director-probe',
      coordinator: {
        spawn: async () => ({ subagentId: 'sub-1' }),
        setSubagentBridge: () => {},
      },
      fleet: { emit: () => {} },
      transport: { connect: () => {} },
      stateCheckpoint: { recordSpawn: () => {} },
      workCompleteFlag: false,
      spawnCount: 0,
      maxSpawns: 10,
      maxSpawnDepth: 5,
      spawnDepth: 0,
      maxFleetCostUsd: Number.POSITIVE_INFINITY,
      maxLeaderContextLoad: 1,
      leaderContextPressure: 0,
      usage: { snapshot: () => ({ total: { cost: 0 } }), addSubagent: () => {} },
      fleetManager: undefined,
      manifestEntries: new Map(),
      subagentBridges: new Map(),
      subagentMeta: new Map(),
      priceLookups: new Map(),
      usedNicknames: new Set(),
      modelMatrix: { '*': { provider: 'matrix-provider', model: 'matrix-model' } },
      resolveMaxContext: () => 128_000,
      scheduleManifest: () => {},
    } as never;

    const config = { name: 'worker', provider: 'lane-provider', model: 'lane-model' };
    await fleetSpawn(host, config as never).catch(() => {
      // Host stubs may refuse later in the pipeline; the assertion below is
      // about what happened to `config` before that point.
    });

    expect(config.provider).toBe('lane-provider');
    expect(config.model).toBe('lane-model');
  });

  it('a lane still wins when the leader pins a model AND the matrix has a route', async () => {
    const plan = emptySubagentModelPlan();
    plan.slots[0] = { provider: 'lane-provider', model: 'lane-model' };
    setSessionSubagentModelPlanForSession(TEST_SESSION_ID, plan);

    const director = new Director({
      sessionId: TEST_SESSION_ID,
      config: {
        coordinatorId: 'probe',
        doneCondition: { type: 'all_tasks_done' },
        maxConcurrent: 2,
      },
      runner: noopRunner,
      modelMatrix: { '*': { provider: 'matrix-provider', model: 'matrix-model' } } as never,
      sessionProvider: 'session-provider',
      sessionModel: 'session-model',
    });

    const spawned: Array<{ provider?: string; model?: string }> = [];
    director.fleet.onAny((e) => {
      if (e.type === 'subagent.spawned') {
        const payload = e.payload as { provider?: string; model?: string };
        spawned.push({ provider: payload.provider, model: payload.model });
      }
    });

    try {
      await director.spawn({
        name: 'w1',
        provider: 'leader-provider',
        model: 'leader-model',
        // What `spawn_subagent` stamps when the leader fills the fields in.
        modelChosenByLeader: true,
      });
      expect(spawned[0]).toEqual({ provider: 'lane-provider', model: 'lane-model' });
    } finally {
      await director.shutdown().catch(() => {});
    }
  });
});
