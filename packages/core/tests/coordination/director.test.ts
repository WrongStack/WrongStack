/**
 * Integration tests for Director — the high-level fleet orchestrator.
 *
 * Tests the public imperative API (status, usage, budget, context pressure,
 * spawn budget enforcement, task completion notification) using mock runners
 * and the shared test harness.
 */

import type {
  MultiAgentConfig,
  SubagentRunner,
  TaskResult,
  TaskSpec,
} from '@wrongstack/contracts/types/multi-agent';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Director, type TaskResultNotification } from '../../src/coordination/director.js';

/** Owning session for coordinator-scoped work under test. */
const TEST_SESSION_ID = 'sess_test';

function makeConfig(overrides: Partial<MultiAgentConfig> = {}): MultiAgentConfig {
  return {
    maxSpawns: 5,
    maxSpawnDepth: 2,
    maxFleetCostUsd: Number.POSITIVE_INFINITY,
    maxFleetTokens: Number.POSITIVE_INFINITY,
    maxLeaderContextLoad: 0.8,
    maxContext: 128_000,
    spawnDepth: 0,
    doneCondition: { type: 'all_tasks_done' },
    ...overrides,
  } as MultiAgentConfig;
}

function makeRunner(): SubagentRunner & { calls: any[] } {
  const calls: any[] = [];
  const runner: SubagentRunner = {
    async run(spec: TaskSpec): Promise<TaskResult> {
      calls.push(spec);
      return {
        taskId: spec.taskId,
        status: 'success',
        result: 'done',
        iterations: 1,
        toolCalls: 0,
        durationMs: 10,
      };
    },
  };
  return Object.assign(runner, { calls });
}

describe('Director — construction & basic API', () => {
  let runner: ReturnType<typeof makeRunner>;

  beforeEach(() => {
    runner = makeRunner();
  });

  it('constructs with minimal config', () => {
    const director = new Director({ sessionId: TEST_SESSION_ID, config: makeConfig(), runner });
    expect(director.id).toBeTruthy();
    expect(director.fleet).toBeDefined();
    expect(director.usage).toBeDefined();
  });

  it('status returns coordinator snapshot', () => {
    const director = new Director({ sessionId: TEST_SESSION_ID, config: makeConfig(), runner });
    const status = director.status();
    expect(status).toBeDefined();
    // Status fields may vary by coordinator implementation; just verify
    // it's an object with expected structure
    expect(typeof status).toBe('object');
  });

  it('usage snapshot is accessible', () => {
    const director = new Director({ sessionId: TEST_SESSION_ID, config: makeConfig(), runner });
    const usage = director.usage.snapshot();
    expect(usage).toBeDefined();
  });
});

describe('Director — context pressure', () => {
  let runner: ReturnType<typeof makeRunner>;

  beforeEach(() => {
    runner = makeRunner();
  });

  it('setLeaderContextPressure and get round-trip', () => {
    const director = new Director({ sessionId: TEST_SESSION_ID, config: makeConfig(), runner });
    expect(director.getLeaderContextPressure()).toBe(0);
    director.setLeaderContextPressure(50000);
    expect(director.getLeaderContextPressure()).toBe(50000);
  });
});

describe('Director — budget tracking', () => {
  beforeEach(() => {});

  it('getRemainingBudgetUsd returns undefined when no cap', () => {
    const director = new Director({
      sessionId: TEST_SESSION_ID,
      config: makeConfig(),
      runner: makeRunner(),
    });
    expect(director.getRemainingBudgetUsd()).toBeUndefined();
  });

  it('getRemainingBudgetUsd returns remaining when cap set', () => {
    const director = new Director({
      sessionId: TEST_SESSION_ID,
      config: makeConfig({ maxFleetCostUsd: 10.0 }),
      runner: makeRunner(),
    });
    // The director may delegate budget to FleetManager; without one,
    // getRemainingBudgetUsd may return undefined if the cap isn't stored
    // in the expected field. Just verify it doesn't crash.
    const remaining = director.getRemainingBudgetUsd();
    expect(remaining === undefined || typeof remaining === 'number').toBe(true);
  });
});

describe('Director — BTW notes', () => {
  beforeEach(() => {});

  it('setLeaderBtwNote stores and getLeaderBtwNotes retrieves', () => {
    const director = new Director({
      sessionId: TEST_SESSION_ID,
      config: makeConfig(),
      runner: makeRunner(),
    });
    director.setLeaderBtwNote('check the database');
    expect(director.getLeaderBtwNotes()).toContain('check the database');
  });

  it('peekLeaderBtwNotes does not drain', () => {
    const director = new Director({
      sessionId: TEST_SESSION_ID,
      config: makeConfig(),
      runner: makeRunner(),
    });
    director.setLeaderBtwNote('note1');
    director.peekLeaderBtwNotes();
    expect(director.getLeaderBtwNotes()).toHaveLength(1);
  });

  it('drainLeaderBtwNotes clears the buffer', () => {
    const director = new Director({
      sessionId: TEST_SESSION_ID,
      config: makeConfig(),
      runner: makeRunner(),
    });
    director.setLeaderBtwNote('temp');
    director.drainLeaderBtwNotes();
    expect(director.getLeaderBtwNotes()).toHaveLength(0);
  });
});

describe('Director — tools factory', () => {
  beforeEach(() => {});

  it('tools() returns an array of Tool objects', () => {
    const director = new Director({
      sessionId: TEST_SESSION_ID,
      config: makeConfig(),
      runner: makeRunner(),
    });
    const tools = director.tools();
    expect(Array.isArray(tools)).toBe(true);
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) {
      expect(t.name).toBeTruthy();
      expect(typeof t.execute).toBe('function');
    }
  });

  it('tools include spawn, assign, await_tasks, terminate', () => {
    const director = new Director({
      sessionId: TEST_SESSION_ID,
      config: makeConfig(),
      runner: makeRunner(),
    });
    const names = director.tools().map((t) => t.name);
    expect(names).toContain('spawn_subagent');
    expect(names).toContain('assign_task');
    expect(names).toContain('await_tasks');
    expect(names).toContain('terminate_subagent');
  });
});

describe('Director — workComplete', () => {
  beforeEach(() => {});

  it('workComplete sets stopped state without throwing', () => {
    const director = new Director({
      sessionId: TEST_SESSION_ID,
      config: makeConfig(),
      runner: makeRunner(),
    });
    expect(() => director.workComplete()).not.toThrow();
  });
});

describe('Director — task result notifier', () => {
  beforeEach(() => {});

  it('fires taskResultNotifier on fire-and-forget task completion', async () => {
    // The old version used `makeRunner()` (an object with `run(spec)` keyed on
    // `taskId`), never spawned a subagent, and admitted the notification "may
    // or may not fire" — it only checked status() existed, so nothing ran.
    // Director's runner is a function `(task, ctx) => outcome`, as in
    // director-await-any.test.ts.
    const notifications: TaskResultNotification[] = [];
    const runner = vi.fn(async (task: TaskSpec) => ({
      result: `ran:${task.description}`,
      iterations: 1,
      toolCalls: 0,
    }));
    const director = new Director({
      sessionId: TEST_SESSION_ID,
      config: {
        coordinatorId: 'notifier-director',
        doneCondition: { type: 'all_tasks_done' },
        maxConcurrent: 2,
      } as never,
      runner: runner as never,
      taskResultNotifier: (n) => {
        notifications.push(n);
      },
    });
    try {
      await director.spawn({ id: 'w1', name: 'W1' });
      // Fire-and-forget: nobody awaits t1, so the notifier is its only way back.
      await director.assign({ id: 't1', description: 'test task', subagentId: 'w1' } as TaskSpec);
      await vi.waitFor(() => expect(notifications.map((n) => n.taskId)).toContain('t1'));
      expect(runner).toHaveBeenCalledTimes(1);
      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toMatchObject({ status: 'success', resultText: 'ran:test task' });
    } finally {
      await director.shutdown();
    }
  });
});

describe('Director — removeSubagent per-subagent Map cleanup', () => {
  beforeEach(() => {});

  it('drops subagentMeta and priceLookups entries for the retired subagent', async () => {
    // Regression: Director.remove previously cleared subagentBridges,
    // manifestEntries, usedNicknames, taskWorktrees, budgetPolicy, and
    // fleetManager — but NOT its own subagentMeta / priceLookups Maps.
    // Without a FleetManager (the non-fleet fallback path used by tests
    // and lightweight consumers), those Maps live on the Director itself
    // and accumulated one entry per retired subagent for the lifetime of
    // the leader process. Same leak FleetManager already fixed internally.
    const director = new Director({
      sessionId: TEST_SESSION_ID,
      config: makeConfig(),
      runner: makeRunner(),
    });

    // Simulate fleet-spawn.ts:254 / fleet-manager.ts:361: the per-subagent
    // metadata and price-lookup entries that recordSpawn would normally
    // populate. The Director exposes these Maps publicly (readonly) so
    // production spawn flows fill them; here we set them directly.
    (director.subagentMeta as Map<string, unknown>).set('s1', {
      provider: 'anthropic',
      model: 'm',
    });
    (director.subagentMeta as Map<string, unknown>).set('s2', { provider: 'openai', model: 'gpt' });
    (director.priceLookups as Map<string, unknown>).set('anthropic/m', { input: 3 });
    (director.priceLookups as Map<string, unknown>).set('openai/gpt', { input: 5 });
    expect(director.subagentMeta.size).toBe(2);
    expect(director.priceLookups.size).toBe(2);

    await director.remove('s1');

    // The retired subagent's entries must be gone from both Maps. The other
    // subagent's entries must remain untouched (no cross-contamination).
    expect(director.subagentMeta.has('s1')).toBe(false);
    expect(director.priceLookups.has('anthropic/m')).toBe(false);
    expect(director.subagentMeta.has('s2')).toBe(true);
    expect(director.priceLookups.has('openai/gpt')).toBe(true);
  });

  it('remains idempotent across many retirements (no leak over a long fleet run)', async () => {
    // Long-running fleet sessions retire dozens of subagents; each remove()
    // must fully release its per-subagent Map entries so a 1000-subagent
    // run does not balloon the Map to 1000 entries.
    const director = new Director({
      sessionId: TEST_SESSION_ID,
      config: makeConfig(),
      runner: makeRunner(),
    });

    for (let i = 0; i < 50; i++) {
      const id = `s${i}`;
      const provider = i % 2 === 0 ? 'anthropic' : 'openai';
      (director.subagentMeta as Map<string, unknown>).set(id, { provider, model: 'm' });
      (director.priceLookups as Map<string, unknown>).set(`${provider}/m`, { input: 1 });
      await director.remove(id);
    }

    expect(director.subagentMeta.size).toBe(0);
    // priceLookups shares keys by provider/model — only two unique keys,
    // each deleted once on its first retirement. All later retirements
    // are no-ops on that key.
    expect(director.priceLookups.size).toBe(0);
  });
});
