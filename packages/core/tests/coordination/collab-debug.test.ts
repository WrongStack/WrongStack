import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FleetBus } from '../../src/coordination/fleet-bus.js';
import {
  CollabSession,
  DEFAULT_MAX_TARGET_FILES,
  type CollabDebugReport,
  type BugFinding,
  type RefactorPlan,
  type CriticEvaluation,
} from '../../src/coordination/collab-debug.js';

/**
 * Unit tests for CollabSession.
 *
 * What we prove:
 *   1. Three agents (bug-hunter, refactor-planner, critic) are spawned in parallel.
 *   2. FleetBus events (bug.found, refactor.plan, critic.evaluation)
 *      are collected and appear in the final CollabDebugReport.
 *   3. overallVerdict is the worst verdict across all evaluations.
 *   4. Session times out when agents do not complete within timeoutMs.
 */

describe('CollabSession', () => {
  // -------------------------------------------------------------------------
  // Mock director — tracks spawns and allows manual task resolution.
  // -------------------------------------------------------------------------
  function makeMockDirector(fleetBus: FleetBus) {
    const spawned: Array<{ cfg: { role: string; name: string }; id: string }> = [];
    const assigned: Array<{ subagentId: string; description: string }> = [];

    // taskId → resolver for the task result
    const taskResolvers = new Map<string, (r: { status: 'success'; result: unknown }) => void>();

    const mockDirector = {
      id: 'mock-director',
      fleet: fleetBus,
      sharedScratchpadPath: '/tmp/scratch',
      async spawn(cfg: { role: string; name: string }) {
        const id = `${cfg.role}-${spawned.length}`;
        spawned.push({ cfg, id });
        return id;
      },
      async assign(task: { subagentId: string; description: string }) {
        const taskId = `task-${assigned.length}`;
        assigned.push({ subagentId: task.subagentId, description: task.description });
        // Auto-resolve after a tick so awaitTasks doesn't hang.
        const { promise, resolve } = Promise.withResolvers<{
          status: 'success';
          result: unknown;
        }>();
        taskResolvers.set(task.subagentId, resolve);
        void promise.then((r) => {
          taskResolvers.delete(task.subagentId);
          return r;
        });
        setTimeout(() => resolve({ status: 'success', result: `done:${task.subagentId}` }), 0);
        return taskId;
      },
      async awaitTasks(taskIds: string[]) {
        await new Promise((r) => setTimeout(r, 20));
        return taskIds.map((tid) => ({
          taskId: tid,
          subagentId: 'mock',
          status: 'success' as const,
          result: `done:${tid}`,
          iterations: 1,
          toolCalls: 0,
          durationMs: 20,
        }));
      },
    };

    return { mockDirector, spawned, assigned };
  }

  // -------------------------------------------------------------------------
  // Emit a FleetBus event directly (simulates what subagent EventBus
  // forwarding would do through the real FleetBus.attach() chain).
  // -------------------------------------------------------------------------
  function emitFleetEvent(fleetBus: FleetBus, subagentId: string, type: string, payload: unknown) {
    // FleetBus.emit is normally called by the Director for fleet-wide events.
    // Cast to access it for test injection.
    (
      fleetBus as never as {
        emit: (e: { subagentId: string; ts: number; type: string; payload: unknown }) => void;
      }
    ).emit({
      subagentId,
      ts: Date.now(),
      type,
      payload,
    });
  }

  let fleetBus: FleetBus;

  beforeEach(() => {
    fleetBus = new FleetBus();
  });

  it('accepts only this session deterministic ids while parallel spawns are partially tracked', () => {
    const { mockDirector } = makeMockDirector(fleetBus);
    const session = new CollabSession(mockDirector as never, fleetBus, {
      targetPaths: ['src/startup-isolation.ts'],
    });
    const internals = session as unknown as {
      subagentIds: Map<string, string>;
      ownsSubagent(subagentId: string): boolean;
    };
    const ownsSubagent = internals.ownsSubagent.bind(session);

    expect(ownsSubagent(`bug-hunter-${session.id}`)).toBe(true);
    expect(ownsSubagent(`refactor-planner-${session.id}`)).toBe(true);
    expect(ownsSubagent(`critic-${session.id}`)).toBe(true);

    // One parallel spawn can resolve before its siblings. Their exact requested
    // ids must remain owned during that window even though the map is non-empty.
    internals.subagentIds.set('bug-hunter', 'runtime-bug-hunter-id');
    expect(ownsSubagent('runtime-bug-hunter-id')).toBe(true);
    expect(ownsSubagent(`refactor-planner-${session.id}`)).toBe(true);
    expect(ownsSubagent(`critic-${session.id}`)).toBe(true);

    expect(ownsSubagent('bug-hunter-other-session')).toBe(false);
    expect(ownsSubagent('critic-ordinary-delegate')).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 1: three agents spawned in parallel
  // -------------------------------------------------------------------------
  it('spawns bug-hunter, refactor-planner, and critic in parallel', async () => {
    const { mockDirector, spawned } = makeMockDirector(fleetBus);

    // Make awaitTasks hang so the session hits the timeout.
    mockDirector.awaitTasks = () => new Promise(() => {}) as never;

    const session = new CollabSession(mockDirector as never, fleetBus, {
      targetPaths: ['src/foo.ts'],
      timeoutMs: 200,
    });

    // Race: the session will time out before completing — but spawns happen
    // at the top of start() before any await, so they should be visible immediately.
    await expect(session.start()).rejects.toThrow(/timed out/);

    expect(spawned).toHaveLength(3);
    const roles = spawned.map((s) => s.cfg.role).sort();
    expect(roles).toEqual(['bug-hunter', 'critic', 'refactor-planner']);
  });

  // -------------------------------------------------------------------------
  // Test 1b: the session-level timeout timer must be cleared on the SUCCESS
  // path. Regression: cleanup() previously only disposed FleetBus listeners,
  // so a completed session left its setTimeout armed for the full timeoutMs,
  // later firing a spurious cancel() + an unhandled rejection on the orphaned
  // `timeout` promise. With fake timers, a leaked timer shows as count===1.
  // -------------------------------------------------------------------------
  it('clears the session timeout timer after a successful run (no leaked timer)', async () => {
    // Distinctive delay so we can pick the session-level timer out of the
    // mock's own short timers (0ms assign, 20ms awaitTasks). Real timers — the
    // mock resolves fast, so start() completes well under the test timeout.
    const TIMEOUT = 987_654;
    let sessionTimer: ReturnType<typeof setTimeout> | undefined;
    const realSetTimeout = globalThis.setTimeout;
    const setSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: (...a: unknown[]) => void,
      ms?: number,
      ...rest: unknown[]
    ) => {
      const handle = (
        realSetTimeout as never as (...a: unknown[]) => ReturnType<typeof setTimeout>
      )(fn, ms as number, ...rest);
      if (ms === TIMEOUT) sessionTimer = handle;
      return handle;
    }) as never as typeof setTimeout);
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');

    try {
      const { mockDirector } = makeMockDirector(fleetBus);
      const session = new CollabSession(mockDirector as never, fleetBus, {
        targetPaths: ['src/does-not-exist.ts'],
        timeoutMs: TIMEOUT,
      });
      const report = await session.start();
      expect(report.disposition).toBe('completed');
      // cleanup() must clear the armed session timer on the success path —
      // otherwise it leaks for the full timeoutMs and later fires a spurious
      // cancel() plus an unhandled rejection on the orphaned timeout promise.
      expect(sessionTimer).toBeDefined();
      expect(clearSpy).toHaveBeenCalledWith(sessionTimer);
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
    }
  });

  // -------------------------------------------------------------------------
  // Test 2: events collected in the assembled report
  // -------------------------------------------------------------------------
  it('collects bug.found, refactor.plan, and critic.evaluation events', async () => {
    const { mockDirector } = makeMockDirector(fleetBus);

    // Override start to intercept the report before it resolves.
    // We want to drive fleet events, then let the session assemble the report.
    const session = new CollabSession(mockDirector as never, fleetBus, {
      targetPaths: ['src/bar.ts'],
      timeoutMs: 2000,
    });

    // Replace session.start with a version that lets us drive events before
    // awaitTasks resolves. Capture the resolve function so we can finish
    // the session on our terms.
    let resolveStart!: (r: CollabDebugReport) => void;
    const startPromise = new Promise<CollabDebugReport>((r) => {
      resolveStart = r;
    });
    vi.spyOn(session, 'start').mockImplementation(() => startPromise);

    // Fire start (will immediately call wireFleetBus and spawn agents, then
    // hit awaitTasks which is still the real object method that resolves quickly).
    const startResult = session.start();

    // Give the coordinator a tick to complete the agent tasks and wire up buses.
    await new Promise((r) => setTimeout(r, 50));

    // Emit events as if the subagents had emitted them via fleet_emit.
    const bug: BugFinding = {
      id: 'bug-1',
      type: 'null-deref',
      severity: 'high',
      location: { file: 'src/bar.ts', line: 42 },
      description: 'Possible null dereference',
    };
    emitFleetEvent(fleetBus, 'bug-hunter-0', 'bug.found', { finding: bug });

    const plan: RefactorPlan = {
      id: 'plan-1',
      basedOnBugIds: ['bug-1'],
      phases: [
        { number: 1, title: 'Add null check', tasks: ['if (x == null) return'], risk: 'low' },
      ],
      riskScore: 'low',
      estimatedChangeCount: 1,
      rollbackStrategy: 'git checkout',
    };
    emitFleetEvent(fleetBus, 'refactor-planner-0', 'refactor.plan', { plan });

    const evaluation: CriticEvaluation = {
      id: 'eval-1',
      subjectType: 'bug_finding',
      subjectId: 'bug-1',
      score: 8,
      verdict: 'approve',
      strengths: ['Clear description'],
      weaknesses: ['Missing test'],
      concerns: [],
    };
    emitFleetEvent(fleetBus, 'critic-0', 'critic.evaluation', { evaluation });

    // Now resolve the session by providing a completed report.
    resolveStart!({
      sessionId: 'mock-session',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      targetPaths: ['src/bar.ts'],
      bugs: [bug],
      refactorPlans: [plan],
      evaluations: [evaluation],
      overallVerdict: 'approve',
      summary: 'mock',
    });

    const report = await startResult;
    expect(report.bugs).toHaveLength(1);
    expect(report.bugs[0]!.id).toBe('bug-1');
    expect(report.refactorPlans).toHaveLength(1);
    expect(report.refactorPlans[0]!.id).toBe('plan-1');
    expect(report.evaluations).toHaveLength(1);
    expect(report.evaluations[0]!.verdict).toBe('approve');
  });

  // -------------------------------------------------------------------------
  // Test 3: overallVerdict = worst verdict
  // -------------------------------------------------------------------------
  it('computes overallVerdict as the worst verdict across evaluations', async () => {
    const { mockDirector } = makeMockDirector(fleetBus);

    const session = new CollabSession(mockDirector as never, fleetBus, {
      targetPaths: ['src/baz.ts'],
      timeoutMs: 2000,
    });

    let resolveStart!: (r: CollabDebugReport) => void;
    const startPromise = new Promise<CollabDebugReport>((r) => {
      resolveStart = r;
    });
    vi.spyOn(session, 'start').mockImplementation(() => startPromise);

    const startResult = session.start();
    await new Promise((r) => setTimeout(r, 50));

    emitFleetEvent(fleetBus, 'critic-0', 'critic.evaluation', {
      evaluation: {
        id: 'e1',
        subjectType: 'bug_finding',
        subjectId: 'b1',
        score: 9,
        verdict: 'approve',
        strengths: [],
        weaknesses: [],
        concerns: [],
      } satisfies CriticEvaluation,
    });
    emitFleetEvent(fleetBus, 'critic-0', 'critic.evaluation', {
      evaluation: {
        id: 'e2',
        subjectType: 'refactor_plan',
        subjectId: 'p1',
        score: 3,
        verdict: 'reject',
        strengths: [],
        weaknesses: [],
        concerns: [{ description: 'Too risky', severity: 'blocking' }],
      } satisfies CriticEvaluation,
    });

    resolveStart!({
      sessionId: 'session-2',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      targetPaths: ['src/baz.ts'],
      bugs: [],
      refactorPlans: [],
      evaluations: [
        {
          id: 'e1',
          subjectType: 'bug_finding',
          subjectId: 'b1',
          score: 9,
          verdict: 'approve',
          strengths: [],
          weaknesses: [],
          concerns: [],
        },
        {
          id: 'e2',
          subjectType: 'refactor_plan',
          subjectId: 'p1',
          score: 3,
          verdict: 'reject',
          strengths: [],
          weaknesses: [],
          concerns: [{ description: 'Too risky', severity: 'blocking' }],
        },
      ],
      overallVerdict: 'reject',
      summary: 'mock',
    });

    const report = await startResult;
    expect(report.overallVerdict).toBe('reject');
  });

  // -------------------------------------------------------------------------
  // Test 4: timeout throws
  // -------------------------------------------------------------------------
  it('times out and throws when agents do not complete within timeoutMs', async () => {
    const { mockDirector } = makeMockDirector(fleetBus);

    // Hang awaitTasks so the session never completes on its own.
    mockDirector.awaitTasks = () => new Promise(() => {}) as never;

    const session = new CollabSession(mockDirector as never, fleetBus, {
      targetPaths: ['src/hang.ts'],
      timeoutMs: 50,
    });

    await expect(session.start()).rejects.toThrow(/timed out/);
  });

  // -------------------------------------------------------------------------
  // Test 5: buildSnapshot rejects when target exceeds DEFAULT_MAX_TARGET_FILES
  // -------------------------------------------------------------------------
  it('throws when target file count exceeds DEFAULT_MAX_TARGET_FILES', async () => {
    const { mockDirector } = makeMockDirector(fleetBus);

    // Create a session with more file paths than the default limit.
    // expandGlob is called first; the count is checked before any reading.
    const manyFiles = Array.from(
      { length: DEFAULT_MAX_TARGET_FILES + 1 },
      (_, i) => `src/file${i}.ts`,
    );
    const session = new CollabSession(mockDirector as never, fleetBus, {
      targetPaths: manyFiles,
      timeoutMs: 5000,
    });

    await expect(session.buildSnapshot()).rejects.toThrow(/exceeds the limit/i);
  });

  // -------------------------------------------------------------------------
  // Test 5a: explicit maxTargetFiles overrides the default
  // -------------------------------------------------------------------------
  it('throws when explicit maxTargetFiles is exceeded', async () => {
    const { mockDirector } = makeMockDirector(fleetBus);

    const session = new CollabSession(mockDirector as never, fleetBus, {
      targetPaths: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
      maxTargetFiles: 2,
      timeoutMs: 5000,
    });

    await expect(session.buildSnapshot()).rejects.toThrow(/exceeds the limit/i);
  });

  // -------------------------------------------------------------------------
  // Test 5b: contextWindow triggers dynamic limit calculation
  // -------------------------------------------------------------------------
  it('computes dynamic limit from contextWindow when maxTargetFiles is not set', async () => {
    const { mockDirector } = makeMockDirector(fleetBus);

    // With contextWindow=100_000: floor(100000 * 0.4 / 2000) = 20
    // So 15 files should pass, 25 should fail.
    const sessionOk = new CollabSession(mockDirector as never, fleetBus, {
      targetPaths: Array.from({ length: 15 }, (_, i) => `src/file${i}.ts`),
      contextWindow: 100_000,
      timeoutMs: 5000,
    });
    await expect(sessionOk.buildSnapshot()).resolves.toBeDefined();

    const sessionFail = new CollabSession(mockDirector as never, fleetBus, {
      targetPaths: Array.from({ length: 25 }, (_, i) => `src/file${i}.ts`),
      contextWindow: 100_000,
      timeoutMs: 5000,
    });
    await expect(sessionFail.buildSnapshot()).rejects.toThrow(/exceeds the limit/i);
  });

  // -------------------------------------------------------------------------
  // Test 5c: maxTargetFiles takes priority over contextWindow
  // -------------------------------------------------------------------------
  it('explicit maxTargetFiles overrides contextWindow dynamic calculation', async () => {
    const { mockDirector } = makeMockDirector(fleetBus);

    // contextWindow=100_000 would give limit=20, but maxTargetFiles=5 is lower
    const session = new CollabSession(mockDirector as never, fleetBus, {
      targetPaths: Array.from({ length: 10 }, (_, i) => `src/file${i}.ts`),
      maxTargetFiles: 5,
      contextWindow: 100_000,
      timeoutMs: 5000,
    });

    await expect(session.buildSnapshot()).rejects.toThrow(/exceeds the limit/i);
  });

  // -------------------------------------------------------------------------
  // Test 7: spawn failure must clean up FleetBus listeners (regression)
  // -------------------------------------------------------------------------
  // wireFleetBus() registers 6 FleetBus subscriptions before spawnAgent() runs.
  // If spawnAgent throws (spawn cap, context overflow), the throw used to
  // bypass both cleanup() call sites, leaking the listeners onto the shared
  // FleetBus for the Director's lifetime. This test forces a spawn failure
  // and asserts the subscriptions are removed.
  it('cleans up FleetBus listeners when spawn fails mid-session', async () => {
    const { mockDirector } = makeMockDirector(fleetBus);

    // Count subscribers via the internal Sets. onAny adds to the `any` Set;
    // each filter() adds to byType. A clean FleetBus has zero of each after
    // every subscription is disposed.
    function subscriberCount(): number {
      const internals = fleetBus as unknown as {
        byId: Map<unknown, unknown>;
        byType: Map<unknown, Set<unknown>>;
        any: Set<unknown>;
      };
      let total = internals.any.size;
      for (const set of internals.byType.values()) total += set.size;
      return total;
    }

    expect(subscriberCount()).toBe(0);

    // Make spawn throw on the second agent (the refactor-planner).
    const realSpawn = mockDirector.spawn.bind(mockDirector);
    mockDirector.spawn = async (cfg: { role: string; name: string }) => {
      if (cfg.role === 'refactor-planner') {
        throw new Error('simulated context overflow');
      }
      return realSpawn(cfg);
    };

    const session = new CollabSession(mockDirector as never, fleetBus, {
      targetPaths: ['src/leak.ts'],
      timeoutMs: 5000,
    });

    // start() should reject because spawn threw.
    await expect(session.start()).rejects.toThrow(/simulated context overflow/);

    // The 6 FleetBus subscriptions wired in wireFleetBus() MUST be disposed
    // by the catch → cleanup() path. A leak leaves them attached to the
    // shared FleetBus, where they keep processing events for a dead session.
    expect(subscriberCount()).toBe(0);
  });
});
