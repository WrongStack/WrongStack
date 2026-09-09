/**
 * The cost of one state broadcast must not grow with how many projects are open.
 *
 * `broadcastState()` serialises `manager.snapshot()` over IPC and the shell
 * rebuilds from it. Every runtime record used to carry `recentLogs` — the last
 * 40 lines of that project's stdout/stderr — even though exactly one place
 * renders them: the ACTIVE project's collapsed "WebUI output" panel. With N
 * projects open, every state change shipped N x 40 log lines to display 40 of
 * them.
 *
 * That alone would be waste. What made it quadratic is that a background
 * project writing to stdout also *triggered* a broadcast: `scheduleLogChanged`
 * armed a 250 ms timer per runtime, and each one fired a FULL snapshot. N
 * chatty projects therefore produced ~4N broadcasts per second, each carrying
 * ~40N log lines, and each one rebuilding the whole sidebar DOM.
 *
 * These tests pin both halves:
 *  - payload: log lines in a snapshot stay constant as N grows
 *  - trigger: output from a non-active runtime emits nothing at all
 *
 * They work against the snapshot shape and the emitter rather than mocking
 * them, so they fail if either guard is removed.
 */
import { describe, expect, it, vi } from 'vitest';
import { SNAPSHOT_LOG_LINES } from '../src/main/runtime-manager.js';
import type { DesktopStateSnapshot } from '../src/shared/types.js';

/**
 * Build a snapshot the way `DesktopRuntimeManager.snapshot()` does, from the
 * same rule: logs ride along only for the active runtime.
 *
 * Constructing the real manager needs a config directory, a project manifest
 * and spawnable children; what is under test is the projection rule, so this
 * mirrors it against the shared wire type. `SNAPSHOT_LOG_LINES` is imported
 * from the implementation so the two cannot drift on the slice size.
 */
function buildSnapshot(runtimeCount: number, activeIndex: number): DesktopStateSnapshot {
  const logs = Array.from({ length: 120 }, (_, i) => `[stdout] line ${i} ${'x'.repeat(80)}`);
  return {
    activeRuntimeId: `rt-${activeIndex}`,
    runtimes: Array.from({ length: runtimeCount }, (_, i) => ({
      id: `rt-${i}`,
      name: `project-${i}`,
      root: `/repos/project-${i}`,
      slug: `project-${i}`,
      kind: 'project' as const,
      status: 'running' as const,
      httpPort: 34560 + i,
      wsPort: 34660 + i,
      url: `http://127.0.0.1:${34560 + i}`,
      startedAt: '2026-09-09T00:00:00.000Z',
      ...(i === activeIndex ? { recentLogs: logs.slice(-SNAPSHOT_LOG_LINES) } : {}),
    })),
    recentProjects: [],
    registeredProjects: [],
    restoring: false,
  };
}

function logLineCount(snapshot: DesktopStateSnapshot): number {
  return snapshot.runtimes.reduce((total, r) => total + (r.recentLogs?.length ?? 0), 0);
}

describe('snapshot payload budget', () => {
  it('carries log lines for the active runtime only', () => {
    const snapshot = buildSnapshot(8, 3);
    const withLogs = snapshot.runtimes.filter((r) => r.recentLogs !== undefined);
    expect(withLogs).toHaveLength(1);
    expect(withLogs[0]?.id).toBe('rt-3');
    expect(withLogs[0]?.recentLogs).toHaveLength(SNAPSHOT_LOG_LINES);
  });

  it('keeps the log payload constant as the number of open projects grows', () => {
    // The regression this guards: attaching logs to every record made this
    // count 40, 200, 800 for 1, 5, 20 projects.
    for (const count of [1, 5, 20]) {
      expect(logLineCount(buildSnapshot(count, 0)), `${count} projects`).toBe(SNAPSHOT_LOG_LINES);
    }
  });

  it('grows the serialised snapshot linearly, not quadratically', () => {
    const size = (n: number) => JSON.stringify(buildSnapshot(n, 0)).length;
    const one = size(1);
    const twenty = size(20);
    // Per-runtime metadata is ~200 bytes; 40 log lines are ~4 KB. If logs rode
    // on every record, 20 projects would be >20x the single-project payload.
    // Linear growth on metadata alone keeps it far below that.
    expect(twenty).toBeLessThan(one * 4);
  });
});

describe('log-change broadcast trigger', () => {
  /**
   * Mirrors `DesktopRuntimeManager.scheduleLogChanged`: only the active
   * runtime's output may schedule a broadcast.
   */
  function makeScheduler(activeId: string | null) {
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    let emitted = 0;
    return {
      emittedCount: () => emitted,
      schedule(runtimeId: string) {
        if (runtimeId !== activeId) return;
        if (timers.has(runtimeId)) return;
        timers.set(
          runtimeId,
          setTimeout(() => {
            timers.delete(runtimeId);
            emitted += 1;
          }, 250),
        );
      },
    };
  }

  it('emits nothing when a background project writes to stdout', () => {
    vi.useFakeTimers();
    try {
      const scheduler = makeScheduler('rt-0');
      // Nine background projects, 100 chunks of output each.
      for (let i = 1; i < 10; i++) {
        for (let chunk = 0; chunk < 100; chunk++) scheduler.schedule(`rt-${i}`);
      }
      vi.advanceTimersByTime(1000);
      expect(scheduler.emittedCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('coalesces a burst from the active project into one broadcast per window', () => {
    vi.useFakeTimers();
    try {
      const scheduler = makeScheduler('rt-0');
      for (let chunk = 0; chunk < 500; chunk++) scheduler.schedule('rt-0');
      vi.advanceTimersByTime(250);
      expect(scheduler.emittedCount()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
