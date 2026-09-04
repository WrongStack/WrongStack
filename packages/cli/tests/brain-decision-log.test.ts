import { EventBus } from '@wrongstack/core/kernel';
import { describe, expect, it } from 'vitest';
import {
  type BrainDecisionEntry,
  subscribeBrainDecisionLog,
} from '../src/boot/brain-decision-log.js';

/**
 * Co-located unit tests for the rolling brain-decision log subscription.
 *
 * We pass a tiny in-memory event emitter (`listeners`) since the helper
 * only requires `.on(eventName, listener)` to wire the four brain.*
 * events. The 20-entry ring buffer is exercised by publishing 25 events
 * and asserting the oldest ones have been evicted.
 */

class FakeEvents {
  private readonly map = new Map<string, Set<(payload: unknown) => void>>();

  on(eventName: string, listener: (payload: unknown) => void): void {
    let bucket = this.map.get(eventName);
    if (!bucket) {
      bucket = new Set();
      this.map.set(eventName, bucket);
    }
    bucket.add(listener);
  }

  emit(eventName: string, payload: unknown): void {
    const bucket = this.map.get(eventName);
    if (!bucket) return;
    for (const fn of bucket) fn(payload);
  }
}

describe('subscribeBrainDecisionLog', () => {
  it('starts with an empty log', () => {
    const events = new FakeEvents();
    const { brainLog } = subscribeBrainDecisionLog(events);
    expect(brainLog).toEqual([]);
  });

  it('captures brain.decision_answered with question and answer outcome', () => {
    const events = new FakeEvents();
    const { brainLog } = subscribeBrainDecisionLog(events);
    events.emit('brain.decision_answered', {
      at: 1000,
      request: { question: 'Continue?' },
      decision: { type: 'answer', optionId: 'yes' },
    });
    expect(brainLog).toEqual<BrainDecisionEntry[]>([
      { at: 1000, kind: 'answered', question: 'Continue?', outcome: 'yes' },
    ]);
  });

  it('captures brain.decision_ask_human with fixed escalated outcome', () => {
    const events = new FakeEvents();
    const { brainLog } = subscribeBrainDecisionLog(events);
    events.emit('brain.decision_ask_human', {
      at: 2000,
      request: { question: 'Risky delete?' },
    });
    expect(brainLog).toEqual<BrainDecisionEntry[]>([
      { at: 2000, kind: 'ask_human', question: 'Risky delete?', outcome: 'escalated to human' },
    ]);
  });

  it('captures brain.decision_denied with deny reason', () => {
    const events = new FakeEvents();
    const { brainLog } = subscribeBrainDecisionLog(events);
    events.emit('brain.decision_denied', {
      at: 3000,
      request: { question: 'rm -rf /?' },
      decision: { type: 'deny', reason: 'destructive command' },
    });
    expect(brainLog).toEqual<BrainDecisionEntry[]>([
      { at: 3000, kind: 'denied', question: 'rm -rf /?', outcome: 'destructive command' },
    ]);
  });

  it('captures brain.intervention with steered vs observed outcome', () => {
    const events = new FakeEvents();
    const { brainLog } = subscribeBrainDecisionLog(events);
    events.emit('brain.intervention', {
      at: 4000,
      request: { question: 'stuck loop?' },
      intervened: true,
    });
    events.emit('brain.intervention', {
      at: 4001,
      request: { question: 'still stuck?' },
      intervened: false,
    });
    expect(brainLog).toEqual<BrainDecisionEntry[]>([
      { at: 4000, kind: 'intervention', question: 'stuck loop?', outcome: 'steered the agent' },
      { at: 4001, kind: 'intervention', question: 'still stuck?', outcome: 'observed (no action)' },
    ]);
  });

  it('caps the buffer at 20 entries, evicting the oldest', () => {
    const events = new FakeEvents();
    const { brainLog } = subscribeBrainDecisionLog(events);
    for (let i = 0; i < 25; i++) {
      events.emit('brain.decision_answered', {
        at: 5000 + i,
        request: { question: `Q${i}` },
        decision: { type: 'answer', optionId: `A${i}` },
      });
    }
    expect(brainLog).toHaveLength(20);
    expect(brainLog[0]?.question).toBe('Q5');
    expect(brainLog[19]?.question).toBe('Q24');
  });

  it('returns a usable pushBrainLog for external inserts', () => {
    const events = new FakeEvents();
    const { brainLog, pushBrainLog } = subscribeBrainDecisionLog(events);
    pushBrainLog({ at: 9000, kind: 'intervention', question: 'manual', outcome: 'manual entry' });
    expect(brainLog).toEqual<BrainDecisionEntry[]>([
      { at: 9000, kind: 'intervention', question: 'manual', outcome: 'manual entry' },
    ]);
  });

  it('records a council resolution only when it carries integrity warnings', () => {
    const events = new FakeEvents();
    const { brainLog } = subscribeBrainDecisionLog(events);

    // Healthy panel — the orchestrator emits no warnings, so the ring stays
    // clean. With the default `distinctness: 'none'` this is every council.
    events.emit('brain.council_resolved', {
      at: 1000,
      status: 'decided',
      resolution: 'majority',
      requestId: 'r1',
    });
    expect(brainLog).toEqual([]);

    events.emit('brain.council_resolved', {
      at: 2000,
      status: 'decided',
      resolution: 'majority',
      requestId: 'r2',
      warnings: [
        'Council distinctness policy "model" was not met: 1 distinct target(s) served 3 valid vote(s).',
      ],
    });
    expect(brainLog).toEqual<BrainDecisionEntry[]>([
      {
        at: 2000,
        kind: 'council_warn',
        question: 'council decided via majority',
        outcome:
          'Council distinctness policy "model" was not met: 1 distinct target(s) served 3 valid vote(s).',
      },
    ]);
  });

  it('disposes listeners on a real EventBus without losing method binding', () => {
    const events = new EventBus();
    const { brainLog, dispose } = subscribeBrainDecisionLog(events);

    expect(() => dispose()).not.toThrow();
    events.emit('brain.decision_answered', {
      at: 1000,
      request: { question: 'after dispose?' } as never,
      decision: { type: 'answer', optionId: 'no' } as never,
    });

    expect(brainLog).toEqual([]);
  });
});

describe('subscribeBrainDecisionLog — tier provenance', () => {
  it('carries the tier from the event onto the log entry', () => {
    const events = new FakeEvents();
    const { brainLog } = subscribeBrainDecisionLog(events);

    events.emit('brain.decision_answered', {
      at: 1,
      tier: 'council',
      request: { question: 'ship it?' },
      decision: { type: 'answer', optionId: 'ship' },
    });
    events.emit('brain.decision_denied', {
      at: 2,
      tier: 'ledger-guard',
      request: { question: 'extend again?' },
      decision: { type: 'deny', reason: 'streak' },
    });

    expect(brainLog.map((e) => e.tier)).toEqual(['council', 'ledger-guard']);
  });

  it('omits tier when the chain recorded no provenance', () => {
    const events = new FakeEvents();
    const { brainLog } = subscribeBrainDecisionLog(events);

    events.emit('brain.decision_answered', {
      at: 1,
      request: { question: 'q' },
      decision: { type: 'answer', text: 'go' },
    });

    expect(brainLog[0]?.tier).toBeUndefined();
  });

  it('labels a pending escalation apart from a final ask_human', () => {
    const events = new FakeEvents();
    const { brainLog } = subscribeBrainDecisionLog(events);

    events.emit('brain.decision_ask_human', {
      at: 1,
      pending: true,
      request: { question: 'q' },
    });
    events.emit('brain.decision_ask_human', { at: 2, request: { question: 'q' } });

    expect(brainLog.map((e) => e.outcome)).toEqual(['waiting on a human', 'escalated to human']);
  });
});

describe('subscribeBrainDecisionLog — session-lifetime tier stats', () => {
  it('counts every resolution, including ones the 20-entry ring has evicted', () => {
    const events = new FakeEvents();
    const { brainLog, getTierStats } = subscribeBrainDecisionLog(events);

    for (let i = 0; i < 25; i++) {
      events.emit('brain.decision_answered', {
        at: i,
        tier: i % 5 === 0 ? 'llm' : 'rule',
        request: { question: `q${i}` },
        decision: { type: 'answer', text: 'go' },
      });
    }

    expect(brainLog).toHaveLength(20);
    const stats = getTierStats();
    expect(stats.total).toBe(25);
    expect(stats.byTier.rule).toBe(20);
    expect(stats.byTier.llm).toBe(5);
    expect(stats.deterministic).toBe(20);
    expect(stats.llmBacked).toBe(5);
  });

  it('counts an escalation once — the prompt is not a resolution', () => {
    const events = new FakeEvents();
    const { getTierStats } = subscribeBrainDecisionLog(events);

    events.emit('brain.decision_ask_human', {
      at: 1,
      pending: true,
      request: { question: 'q' },
    });
    events.emit('brain.decision_answered', {
      at: 2,
      tier: 'human',
      request: { question: 'q' },
      decision: { type: 'answer', optionId: 'go' },
    });

    expect(getTierStats().total).toBe(1);
    expect(getTierStats().byTier.human).toBe(1);
  });

  it('buckets a decision with no recorded tier as unattributed', () => {
    const events = new FakeEvents();
    const { getTierStats } = subscribeBrainDecisionLog(events);

    events.emit('brain.decision_denied', {
      at: 1,
      request: { question: 'q' },
      decision: { type: 'deny', reason: 'no' },
    });

    expect(getTierStats().unattributed).toBe(1);
  });
});
