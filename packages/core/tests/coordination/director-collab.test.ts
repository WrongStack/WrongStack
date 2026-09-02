import { describe, expect, it } from 'vitest';
import { FleetBus } from '../../src/coordination/fleet-bus.js';
import { DirectorCollabController } from '../../src/coordination/director/director-collab.js';
import type { CollabDirectorHost } from '../../src/coordination/collab-director-host.js';
import type { TaskResult } from '../../src/types/multi-agent.js';

/**
 * Unit tests for DirectorCollabController lifecycle.
 *
 * The primary regression test proves that a cancelled session's entry is
 * removed from activeSessions once the session completes naturally — the
 * specific leak that existed when cancel() removed the session.done/error
 * listeners prematurely. Without this test, a regression that re-introduces
 * the premature unsubscribe would leak entries in activeSessions for the
 * Director's lifetime with no test failing.
 */

function makeSuccessResult(subagentId: string, taskId: string): TaskResult {
  return {
    subagentId,
    taskId,
    status: 'success',
    result: '',
    iterations: 0,
    toolCalls: 0,
    durationMs: 0,
  };
}

function makeMockDirector(): {
  director: CollabDirectorHost;
  awaitResolvers: Map<string, (r: TaskResult[]) => void>;
} {
  const awaitResolvers = new Map<string, (r: TaskResult[]) => void>();
  const director: CollabDirectorHost = {
    id: 'mock-director',
    sharedScratchpadPath: null,
    async spawn(cfg) {
      return `${cfg.role}-sub`;
    },
    async assign(task) {
      return `task-for-${task.subagentId}`;
    },
    async awaitTasks(taskIds) {
      // CollabSession always calls awaitTasks with a single-element array.
      // Store the resolver so the test can trigger completion on demand
      // (simulating what coordinator.stop() does in production: aborts the
      // agent → its task completes → awaitTasks resolves).
      return new Promise<TaskResult[]>((resolve) => {
        awaitResolvers.set(taskIds[0] ?? 'unknown', resolve);
      });
    },
    getLeaderBtwNotes() {
      return [];
    },
  };
  return { director, awaitResolvers };
}

describe('DirectorCollabController', () => {
  it('removes the session from activeSessions after cancel + natural completion (regression)', async () => {
    const fleet = new FleetBus();
    const { director, awaitResolvers } = makeMockDirector();
    const stoppedAgents: string[] = [];
    const mockCoordinator = {
      async stop(subagentId: string) {
        stoppedAgents.push(subagentId);
      },
    };

    const controller = new DirectorCollabController({
      director,
      fleet,
      coordinator: mockCoordinator,
    });

    // Start the session — don't await yet; it blocks on awaitTasks.
    const reportPromise = controller.spawn({
      targetPaths: ['src/nonexistent.ts'],
      timeoutMs: 30_000,
    });

    // Wait for spawns + wireFleetBus + awaitTasks to settle.
    await new Promise((r) => setTimeout(r, 50));

    // ── Pre-cancel: session is active ───────────────────────────────
    expect(controller.activeSessionIds()).toHaveLength(1);
    const sessionId = controller.activeSessionIds()[0]!;

    // ── Cancel ──────────────────────────────────────────────────────
    controller.cancel(sessionId, 'test cancel');
    // All three collab agents were stopped via the coordinator.
    expect(stoppedAgents).toHaveLength(3);
    expect(stoppedAgents.sort()).toEqual(['bug-hunter-sub', 'critic-sub', 'refactor-planner-sub']);

    // Entry is STILL present — start() hasn't finished yet (awaitTasks
    // hasn't resolved). cancel() only stops agents + sets cancelled flag;
    // the session's Promise.race is still in flight.
    expect(controller.activeSessionIds()).toHaveLength(1);

    // ── Simulate the stopped agents completing ──────────────────────
    // In production, coordinator.stop() aborts each agent → its task
    // reaches a terminal state → awaitTasks resolves. We trigger that
    // manually here.
    for (const [taskId, resolve] of awaitResolvers) {
      resolve([makeSuccessResult('sub', taskId)]);
    }

    // Wait for session.start() to run to completion: it assembles the
    // report, calls cleanup(), and fires session.done.
    const report = await reportPromise;
    expect(report.disposition).toBe('cancelled');

    // ── The regression assertion ────────────────────────────────────
    // session.done fired → doneHandler ran → entry deleted.
    // OLD CODE (leak): cancel() removed the doneHandler, so session.done
    //   fired into the void and the entry stayed in activeSessions forever.
    // NEW CODE: the handler survives cancel(), so the entry is cleaned up.
    expect(controller.activeSessionIds()).toHaveLength(0);
  });

  it('ownsSubagent tracks active session agents and clears on completion', async () => {
    const fleet = new FleetBus();
    const { director, awaitResolvers } = makeMockDirector();
    const mockCoordinator = { async stop() {} };

    const controller = new DirectorCollabController({
      director,
      fleet,
      coordinator: mockCoordinator,
    });

    const reportPromise = controller.spawn({
      targetPaths: ['src/nonexistent.ts'],
      timeoutMs: 30_000,
    });

    await new Promise((r) => setTimeout(r, 50));

    // While the session is active, ownsSubagent returns true for its agents.
    expect(controller.ownsSubagent('bug-hunter-sub')).toBe(true);
    expect(controller.ownsSubagent('critic-sub')).toBe(true);
    expect(controller.ownsSubagent('random-agent')).toBe(false);

    // Resolve all awaitTasks so the session completes naturally.
    for (const [taskId, resolve] of awaitResolvers) {
      resolve([makeSuccessResult('sub', taskId)]);
    }
    await reportPromise;

    // After completion, no agent is owned.
    expect(controller.ownsSubagent('bug-hunter-sub')).toBe(false);
    expect(controller.activeSessionIds()).toHaveLength(0);
  });

  it('cancel is a no-op for an unknown session id', () => {
    const fleet = new FleetBus();
    const { director } = makeMockDirector();
    const mockCoordinator = { async stop() {} };

    const controller = new DirectorCollabController({
      director,
      fleet,
      coordinator: mockCoordinator,
    });

    // No session was spawned — cancel must not throw.
    expect(() => controller.cancel('never-spawned')).not.toThrow();
    expect(controller.activeSessionIds()).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Partial-spawn cleanup (regression)
  // -------------------------------------------------------------------------
  // When one of the three parallel spawnAgent calls fails after spawning while
  // a sibling is still starting, start() must:
  //   1. emit session.error so the controller reacts
  //   2. surface the already-spawned agents via getSubagentIds() so the
  //      controller's errorHandler can stop them
  //   3. remove the entry from activeSessions
  // Without incremental recording in spawnAgent, getSubagentIds() returns
  // empty at session.error time (the map is only populated after all three
  // succeed), so the orphaned agents run forever and the controller retains
  // a dead session entry for its lifetime.
  it('stops already-spawned agents and clears the entry when a sibling spawn fails', async () => {
    const fleet = new FleetBus();

    // Director that spawns bug-hunter immediately, rejects critic immediately,
    // and spawns refactor-planner slightly later. start() must wait for the late
    // sibling to settle before session.error lets the controller inspect IDs.
    const director: CollabDirectorHost = {
      id: 'mock-director',
      sharedScratchpadPath: null,
      async spawn(cfg) {
        if (cfg.role === 'critic') {
          throw new Error('simulated context overflow on critic');
        }
        if (cfg.role === 'refactor-planner') {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        return `${cfg.role}-sub`;
      },
      async assign(task) {
        return `task-for-${task.subagentId}`;
      },
      // Should never be reached — start() throws before awaitTasks.
      async awaitTasks() {
        return [];
      },
      getLeaderBtwNotes() {
        return [];
      },
    };

    const stoppedAgents: string[] = [];
    const mockCoordinator = {
      async stop(subagentId: string) {
        stoppedAgents.push(subagentId);
      },
    };

    const controller = new DirectorCollabController({
      director,
      fleet,
      coordinator: mockCoordinator,
    });

    // spawn() rejects because the critic spawn threw and start() rethrew.
    await expect(
      controller.spawn({
        targetPaths: ['src/partial-fail.ts'],
        timeoutMs: 30_000,
      }),
    ).rejects.toThrow(/simulated context overflow on critic/);

    // Allow the errorHandler's fire-and-forget coordinator.stop() calls to
    // land (they use .catch so they settle on the microtask queue).
    await new Promise((r) => setTimeout(r, 20));

    // ── The regression assertions ───────────────────────────────────
    // 1. The two agents that spawned successfully (bug-hunter, refactor-planner)
    //    were stopped — they are NOT left as orphans. The old code recorded
    //    subagentIds only after all three spawned, so getSubagentIds() was
    //    empty at session.error time and the errorHandler stopped nothing.
    expect(stoppedAgents.sort()).toEqual(['bug-hunter-sub', 'refactor-planner-sub']);

    // 2. The dead session entry is gone — session.error fired, the
    //    errorHandler deleted it. The old code didn't emit session.error
    //    on the spawn-failure path, so the entry leaked forever.
    expect(controller.activeSessionIds()).toHaveLength(0);
  });

  it('stops a spawned agent when its task assignment fails', async () => {
    const fleet = new FleetBus();
    const director: CollabDirectorHost = {
      id: 'mock-director',
      sharedScratchpadPath: null,
      async spawn(cfg) {
        return `${cfg.role}-sub`;
      },
      async assign(task) {
        if (task.subagentId === 'critic-sub') {
          throw new Error('simulated assignment rejection');
        }
        return `task-for-${task.subagentId}`;
      },
      async awaitTasks() {
        return [];
      },
      getLeaderBtwNotes() {
        return [];
      },
    };
    const stoppedAgents: string[] = [];
    const controller = new DirectorCollabController({
      director,
      fleet,
      coordinator: {
        async stop(subagentId: string) {
          stoppedAgents.push(subagentId);
        },
      },
    });

    await expect(
      controller.spawn({ targetPaths: ['src/assign-fail.ts'], timeoutMs: 30_000 }),
    ).rejects.toThrow(/simulated assignment rejection/);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(stoppedAgents.sort()).toEqual(['bug-hunter-sub', 'critic-sub', 'refactor-planner-sub']);
    expect(controller.activeSessionIds()).toHaveLength(0);
  });
});
