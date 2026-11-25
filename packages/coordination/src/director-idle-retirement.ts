import type { DefaultMultiAgentCoordinator } from './multi-agent-coordinator.js';

/**
 * Minimum delay for re-arming an idle-retirement check that fired while the
 * subagent was still busy. Re-arms reuse the caller's window; this floor only
 * prevents a retire-on-complete (0ms) check from spinning sub-millisecond
 * while the subagent keeps working.
 */
const BUSY_REARM_FLOOR_MS = 1_000;

/** Above 2^31-1 ms setTimeout fires after ~1 ms (Node and Bun). */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export class DirectorIdleRetirement {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(
    private readonly getCoordinator: () => DefaultMultiAgentCoordinator,
    private readonly remove: (id: string) => Promise<void>,
    private readonly onError: (err: unknown) => void,
  ) {}
  clear(subagentId: string): void {
    const timer = this.timers.get(subagentId);
    if (!timer) return;
    clearTimeout(timer);
    this.timers.delete(subagentId);
  }
  arm(subagentId: string, delayMs: number | undefined): void {
    this.clear(subagentId);
    if (delayMs === undefined || !Number.isFinite(delayMs)) return;
    const safeDelayMs = Math.max(0, delayMs);
    const timerDelayMs = Math.min(safeDelayMs, MAX_TIMER_DELAY_MS);
    const timer = setTimeout(() => {
      this.timers.delete(subagentId);
      const entry = this.getCoordinator()
        .getStatus()
        .subagents.find((a) => a.id === subagentId);
      // Already gone: nothing to retire. (The normal removal path clears the
      // armed timer itself; re-arming here would chain 1s timers on a dead id.)
      if (entry === undefined) return;
      // Busy at the tick: re-arm, never drop. Dropping stranded a resident
      // mid-flight on its only armed timer — it stayed in the fleet forever
      // with nothing left to retire it. Re-arm reuses the SAME window the
      // caller chose; the floor keeps a retire-on-complete (0ms) check from
      // becoming a sub-millisecond spin while the subagent keeps working. A
      // task completing on the subagent re-arms retirement itself
      // (handleTaskCompleted), so this re-arm is only the safety net between
      // status flips.
      if (entry.status !== 'idle') {
        this.arm(subagentId, Math.max(delayMs, BUSY_REARM_FLOOR_MS));
        return;
      }
      if (
        this.getCoordinator()
          .listPendingTasks()
          .some((task) => task.subagentId === subagentId)
      ) {
        this.arm(subagentId, Math.max(delayMs, BUSY_REARM_FLOOR_MS));
        return;
      }
      void this.remove(subagentId).catch((err) => this.onError(err));
    }, timerDelayMs);
    if (typeof timer.unref === 'function') timer.unref();
    this.timers.set(subagentId, timer);
  }
  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
