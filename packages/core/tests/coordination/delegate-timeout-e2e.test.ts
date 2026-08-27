import { describe, expect, it } from 'vitest';
import { Director } from '../../src/coordination/director.js';
import { BudgetThresholdSignal, SubagentBudget } from '../../src/coordination/subagent-budget.js';
import { EventBus } from '../../src/kernel/events.js';
import type {
  SubagentRunContext,
  SubagentRunOutcome,
  TaskSpec,
} from '../../src/types/multi-agent.js';

/** Owning session for coordinator-scoped work under test. */
const TEST_SESSION_ID = 'sess_test';

/**
 * End-to-end proof of the never-die timeout chain that two bugs had broken:
 *
 *   budget.checkTimeout()
 *     → emits budget.threshold_reached on the subagent's own EventBus
 *       → FleetBus.attach's onPattern('*') forwards it to the Director's FleetBus
 *         → Director's filter('budget.threshold_reached') auto-extends (timeout
 *            kind, heartbeat-gated)
 *           → budget patches limits in place → subagent keeps running
 *
 * Uses the REAL Director (its auto-extend handler), the REAL FleetBus wiring,
 * and a REAL SubagentBudget — only the agent run itself is stubbed.
 */
function makeDirector(): Director {
  const runner = async (
    _task: TaskSpec,
    _ctx: SubagentRunContext,
  ): Promise<SubagentRunOutcome> => ({ iterations: 1, toolCalls: 1 });
  return new Director({
    sessionId: TEST_SESSION_ID,
    config: { coordinatorId: 'e2e', doneCondition: { type: 'all_tasks_done' }, maxConcurrent: 4 },
    runner,
  });
}

/** Wire a budget the way makeAgentSubagentRunner does. */
function wireBudget(bus: EventBus, limits: { timeoutMs: number }): SubagentBudget {
  const budget = new SubagentBudget(limits);
  budget._events = bus;
  budget.onThreshold = ({ requestDecision }) => requestDecision();
  budget.start();
  return budget;
}

describe('delegate timeout never-die (end-to-end)', () => {
  it('auto-extends a timeout while the subagent is making progress', async () => {
    const director = makeDirector();
    const bus = new EventBus();
    const detach = director.fleet.attach('sub-1', bus);
    try {
      // Heartbeat: a tool ran, so the director sees progress for sub-1.
      bus.emit('tool.executed', { id: 't1', name: 'bash', durationMs: 5, ok: true });

      const budget = wireBudget(bus, { timeoutMs: 5 });
      await new Promise((r) => setTimeout(r, 15)); // exceed 5ms

      let signal: BudgetThresholdSignal | null = null;
      try {
        budget.checkTimeout();
      } catch (e) {
        signal = e as BudgetThresholdSignal;
      }
      expect(signal).toBeInstanceOf(BudgetThresholdSignal);

      const decision = await signal!.decision;
      // The director granted an extension instead of stopping.
      expect(decision).not.toBe('stop');
      expect((decision as { extend: { timeoutMs: number } }).extend.timeoutMs).toBeGreaterThan(5);
      expect(budget.limits.timeoutMs!).toBeGreaterThan(5);
    } finally {
      detach();
    }
  });

  it('auto-extends a plain delegate critic (collab id prefix, no collab session)', async () => {
    // Regression: DirectorBudgetPolicy used to skip every critic-* id on the
    // assumption CollabSession owned it. Plain delegate({ role: 'critic' })
    // uses the same prefix with no collab listener → budget_timeout with no
    // extension chance. Progressing critics must still get headroom.
    const director = makeDirector();
    const bus = new EventBus();
    const detach = director.fleet.attach('critic-deadbeef', bus);
    try {
      bus.emit('tool.executed', { id: 't1', name: 'read', durationMs: 5, ok: true });

      const budget = wireBudget(bus, { timeoutMs: 5 });
      await new Promise((r) => setTimeout(r, 15));

      let signal: BudgetThresholdSignal | null = null;
      try {
        budget.checkTimeout();
      } catch (e) {
        signal = e as BudgetThresholdSignal;
      }
      expect(signal).toBeInstanceOf(BudgetThresholdSignal);

      const decision = await signal!.decision;
      expect(decision).not.toBe('stop');
      expect((decision as { extend: { timeoutMs: number } }).extend.timeoutMs).toBeGreaterThan(5);
    } finally {
      detach();
    }
  });

  it('extends a tool_calls budget ABOVE the current limit (no reduction)', async () => {
    const director = makeDirector();
    const bus = new EventBus();
    const detach = director.fleet.attach('sub-tc', bus);
    try {
      const budget = wireBudget(bus, { timeoutMs: 60_000 });
      // Patch in a tool_calls limit (wireBudget only sets timeout).
      (budget.limits as { maxToolCalls?: number }).maxToolCalls = 2;

      let signal: BudgetThresholdSignal | null = null;
      // Record tool calls until the budget trips its soft limit.
      for (let i = 0; i < 5 && !signal; i++) {
        try {
          budget.recordToolCall();
        } catch (e) {
          signal = e as BudgetThresholdSignal;
        }
      }
      expect(signal).toBeInstanceOf(BudgetThresholdSignal);

      const decision = await signal!.decision;
      expect(decision).not.toBe('stop');
      // The grant must be strictly above the old limit of 2 — the old
      // min(used+100, 800)/min(limit*2, 1500) formula could land below a
      // large roster budget; the new max(limit,used)*1.5 never reduces.
      expect(budget.limits.maxToolCalls!).toBeGreaterThan(2);
    } finally {
      detach();
    }
  });

  it('emits budget.extended on the FleetBus and increments extensionsFor on a grant', async () => {
    const director = makeDirector();
    const bus = new EventBus();
    const detach = director.fleet.attach('sub-ext', bus);
    const extendedEvents: Array<{ kind: string; newLimit: number; totalExtensions: number }> = [];
    const offExtended = director.fleet.filter('budget.extended', (e) => {
      extendedEvents.push(e.payload as { kind: string; newLimit: number; totalExtensions: number });
    });
    try {
      // Heartbeat so the timeout grant is allowed (progress > lastProgress).
      bus.emit('tool.executed', { id: 't1', name: 'bash', durationMs: 5, ok: true });

      const budget = wireBudget(bus, { timeoutMs: 5 });
      await new Promise((r) => setTimeout(r, 15));

      let signal: BudgetThresholdSignal | null = null;
      try {
        budget.checkTimeout();
      } catch (e) {
        signal = e as BudgetThresholdSignal;
      }
      const decision = await signal!.decision;
      expect(decision).not.toBe('stop');

      // The grant broadcast a budget.extended event and bumped the counter.
      expect(extendedEvents.length).toBeGreaterThan(0);
      expect(extendedEvents[0]!.kind).toBe('timeout');
      expect(extendedEvents[0]!.totalExtensions).toBe(1);
      expect(director.extensionsFor('sub-ext')).toBe(1);
    } finally {
      offExtended();
      detach();
    }
  });

  it('denies a timeout when the subagent has made no progress since the last grant', async () => {
    const director = makeDirector();
    const bus = new EventBus();
    const detach = director.fleet.attach('sub-2', bus);
    try {
      // First timeout: no tool has run yet, but the first grant is always
      // allowed (progress 0 > lastProgress -1).
      const budget = wireBudget(bus, { timeoutMs: 5 });
      await new Promise((r) => setTimeout(r, 15));
      let sig1: BudgetThresholdSignal | null = null;
      try {
        budget.checkTimeout();
      } catch (e) {
        sig1 = e as BudgetThresholdSignal;
      }
      expect(await sig1!.decision).not.toBe('stop');

      // Second timeout with STILL no new tool activity → director denies.
      await new Promise((r) => setTimeout(r, budget.limits.timeoutMs! + 10));
      let sig2: BudgetThresholdSignal | null = null;
      try {
        budget.checkTimeout();
      } catch (e) {
        sig2 = e as BudgetThresholdSignal;
      }
      expect(await sig2!.decision).toBe('stop');
    } finally {
      detach();
    }
  });
});
