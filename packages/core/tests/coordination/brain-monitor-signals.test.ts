import { EventBus, type EventMap } from '@wrongstack/contracts/kernel/events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrainArbiter, BrainDecision } from '../../src/brain/brain.js';
import {
  BrainDecisionLedger,
  createLedgerGuardBrainArbiter,
} from '../../src/brain/brain-ledger.js';
import { type BrainInterventionInput, BrainMonitor } from '../../src/brain/brain-monitor.js';

const STEER: BrainDecision = {
  type: 'answer',
  optionId: 'steer',
  text: 'Steer the agent with corrective guidance',
  rationale: 'Stop and reassess.',
};

function okEdit(path: string): EventMap['tool.executed'] {
  return {
    id: `call-edit-${path}`,
    name: 'edit',
    durationMs: 5,
    ok: true,
    input: { file_path: path },
  };
}

describe('BrainMonitor — file churn signal', () => {
  let events: EventBus;
  let interventions: BrainInterventionInput[];
  let monitors: BrainMonitor[];

  beforeEach(() => {
    events = new EventBus();
    interventions = [];
    monitors = [];
  });

  afterEach(() => {
    for (const m of monitors) m.stop();
    vi.useRealTimers();
  });

  function monitor(opts: Partial<ConstructorParameters<typeof BrainMonitor>[0]> = {}) {
    const brain: BrainArbiter = { decide: vi.fn(async () => STEER) };
    const m = new BrainMonitor({
      events,
      brain,
      intervene: async (input) => {
        interventions.push(input);
      },
      stallMs: 0, // keep the stall watchdog out of these tests
      ...opts,
    });
    m.start();
    monitors.push(m);
    return m;
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('allows incremental edits and only consults at the default 20-edit threshold', async () => {
    const brain: BrainArbiter = { decide: vi.fn(async () => STEER) };
    monitor({ brain });
    for (let i = 0; i < 19; i++) events.emit('tool.executed', okEdit('src/a.ts'));
    await settle();
    expect(brain.decide).not.toHaveBeenCalled();

    events.emit('tool.executed', okEdit('src/a.ts'));
    await settle();
    expect(brain.decide).toHaveBeenCalledOnce();
    expect(brain.decide).toHaveBeenCalledWith(
      expect.objectContaining({
        question: expect.stringContaining(
          'Edit frequency alone does not establish an edit/revert loop',
        ),
      }),
    );
  });

  it('does not accumulate edits outside the default ten-minute window', async () => {
    vi.useFakeTimers();
    const brain: BrainArbiter = { decide: vi.fn(async () => STEER) };
    monitor({ brain });
    for (let i = 0; i < 19; i++) events.emit('tool.executed', okEdit('src/a.ts'));
    await vi.advanceTimersByTimeAsync(600_001);
    events.emit('tool.executed', okEdit('src/a.ts'));
    await vi.advanceTimersByTimeAsync(0);
    expect(brain.decide).not.toHaveBeenCalled();
  });

  it('engages when the same file is edited threshold times within the window', async () => {
    const emitted: EventMap['brain.intervention'][] = [];
    events.on('brain.intervention', (e) => emitted.push(e));
    monitor({ fileChurnThreshold: 3 });

    events.emit('tool.executed', okEdit('src/a.ts'));
    events.emit('tool.executed', okEdit('src/a.ts'));
    events.emit('tool.executed', okEdit('src/a.ts'));
    await settle();

    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.kind).toBe('file_churn');
    expect(emitted[0]?.request.question).toContain('src/a.ts');
    expect(interventions).toHaveLength(1);
  });

  it('does not mix different files into one churn count', async () => {
    const emitted: EventMap['brain.intervention'][] = [];
    events.on('brain.intervention', (e) => emitted.push(e));
    monitor({ fileChurnThreshold: 3 });

    events.emit('tool.executed', okEdit('src/a.ts'));
    events.emit('tool.executed', okEdit('src/b.ts'));
    events.emit('tool.executed', okEdit('src/c.ts'));
    await settle();

    expect(emitted).toHaveLength(0);
  });

  it('ignores failed edits and non-edit tools', async () => {
    const emitted: EventMap['brain.intervention'][] = [];
    events.on('brain.intervention', (e) => emitted.push(e));
    monitor({ fileChurnThreshold: 2 });

    events.emit('tool.executed', { ...okEdit('src/a.ts'), ok: false });
    events.emit('tool.executed', {
      id: 'call-read-a',
      name: 'read',
      durationMs: 1,
      ok: true,
      input: { file_path: 'src/a.ts' },
    });
    events.emit('tool.executed', okEdit('src/a.ts'));
    await settle();

    expect(emitted).toHaveLength(0);
  });

  it('counts the files a patch declares, which no input key names', async () => {
    const emitted: EventMap['brain.intervention'][] = [];
    events.on('brain.intervention', (e) => emitted.push(e));
    monitor({ fileChurnThreshold: 3 });

    const okPatch = {
      id: 'call-patch',
      name: 'patch',
      durationMs: 1,
      ok: true,
      input: { patch: '--- a/src/a.ts\n+++ b/src/a.ts\n' },
      writeTargets: ['src/a.ts', 'src/b.ts'],
    };
    events.emit('tool.executed', okPatch);
    events.emit('tool.executed', okEdit('src/a.ts'));
    events.emit('tool.executed', okPatch);
    await settle();

    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.request.question).toContain('src/a.ts');
  });

  it('counts one file however its path is spelled', async () => {
    const emitted: EventMap['brain.intervention'][] = [];
    events.on('brain.intervention', (e) => emitted.push(e));
    monitor({ fileChurnThreshold: 3 });

    events.emit('tool.executed', okEdit('src/a.ts'));
    events.emit('tool.executed', okEdit('./src/a.ts'));
    events.emit('tool.executed', okEdit('src\\a.ts'));
    await settle();

    expect(emitted).toHaveLength(1);
    // The steer names the file as the edit that crossed the threshold spelled it.
    expect(emitted[0]?.request.question).toContain('"src\\a.ts"');
  });
});

describe('BrainMonitor — agent stall signal', () => {
  let events: EventBus;
  let monitors: BrainMonitor[];

  beforeEach(() => {
    vi.useFakeTimers();
    events = new EventBus();
    monitors = [];
  });

  afterEach(() => {
    for (const m of monitors) m.stop();
    vi.useRealTimers();
  });

  const runStarted = () =>
    events.emit('agent.run.started', {
      ctx: {} as never,
      model: 'm',
      at: new Date().toISOString(),
    });
  const runCompleted = () =>
    events.emit('agent.run.completed', {
      ctx: {} as never,
      status: 'done',
      iterations: 1,
      at: new Date().toISOString(),
      durationMs: 1,
    });

  function monitor(opts: Partial<ConstructorParameters<typeof BrainMonitor>[0]> = {}) {
    const brain: BrainArbiter = { decide: vi.fn(async () => STEER) };
    const m = new BrainMonitor({
      events,
      brain,
      intervene: async () => {},
      stallMs: 60_000,
      stallCheckIntervalMs: 10_000,
      ...opts,
    });
    m.start();
    monitors.push(m);
    return m;
  }

  it('engages when an active run makes no progress past the threshold', async () => {
    const emitted: EventMap['brain.intervention'][] = [];
    events.on('brain.intervention', (e) => emitted.push(e));
    monitor();

    runStarted();
    await vi.advanceTimersByTimeAsync(70_000);

    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.kind).toBe('agent_stall');
  });

  // `Agent.run`'s catch path emits `agent.run.error` and then, unconditionally,
  // `agent.run.completed` (core/agent.ts:302 then :310). Treating both as
  // terminators subtracted two for a single failed run, and the `Math.max(0, …)`
  // clamp hid it — so with a second run still live the counter reached zero and
  // the watchdog stopped watching.
  const runFailed = () => {
    events.emit('agent.run.error', {
      ctx: {} as never,
      err: new Error('boom'),
      at: new Date().toISOString(),
      durationMs: 1,
    });
    events.emit('agent.run.completed', {
      ctx: {} as never,
      status: 'failed',
      iterations: 0,
      at: new Date().toISOString(),
      durationMs: 1,
    });
  };

  it('keeps watching the surviving run after a concurrent run fails', async () => {
    const emitted: EventMap['brain.intervention'][] = [];
    events.on('brain.intervention', (e) => emitted.push(e));
    monitor();

    runStarted();
    runStarted();
    runFailed();

    await vi.advanceTimersByTimeAsync(70_000);

    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.kind).toBe('agent_stall');
  });

  it('stops watching once every run has ended', async () => {
    const emitted: EventMap['brain.intervention'][] = [];
    events.on('brain.intervention', (e) => emitted.push(e));
    monitor();

    runStarted();
    runFailed();

    await vi.advanceTimersByTimeAsync(70_000);

    expect(emitted).toHaveLength(0);
  });

  it('stays quiet while tool activity keeps arriving', async () => {
    const emitted: EventMap['brain.intervention'][] = [];
    events.on('brain.intervention', (e) => emitted.push(e));
    monitor();

    runStarted();
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(30_000);
      events.emit('tool.executed', { id: `call-read-${i}`, name: 'read', durationMs: 1, ok: true });
    }
    expect(emitted).toHaveLength(0);
  });

  it.each([true, false])(
    'waits for every parallel tool to settle (last tool ok=%s)',
    async (ok) => {
      const brain: BrainArbiter = { decide: vi.fn(async () => STEER) };
      monitor({ brain, stallMs: 300_000 });
      runStarted();
      events.emit('tool.started', { name: 'bash', id: 'slow' });
      events.emit('tool.started', { name: 'bash', id: 'fast' });
      events.emit('tool.executed', { name: 'bash', id: 'fast', durationMs: 1, ok: true });
      // Duplicate completion must not consume the other in-flight call.
      events.emit('tool.executed', { name: 'bash', id: 'fast', durationMs: 1, ok: true });
      await vi.advanceTimersByTimeAsync(900_000);
      expect(brain.decide).not.toHaveBeenCalled();

      events.emit('tool.executed', { name: 'bash', id: 'slow', durationMs: 900_000, ok });
      await vi.advanceTimersByTimeAsync(290_000);
      expect(brain.decide).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(brain.decide).toHaveBeenCalledOnce();
    },
  );

  it('does not let another session or a filtered subagent suppress a stall', async () => {
    const brain: BrainArbiter = { decide: vi.fn(async () => STEER) };
    monitor({ brain, leaderSessionId: 'leader' });
    runStarted();
    events.emit('tool.started', { sessionId: 'worker', name: 'bash', id: 'slow' });
    await vi.advanceTimersByTimeAsync(70_000);
    expect(brain.decide).toHaveBeenCalledOnce();
  });

  it('keeps a busy session from suppressing a different session stall', async () => {
    const brain: BrainArbiter = { decide: vi.fn(async () => STEER) };
    monitor({ brain });
    runStarted();
    events.emit('agent.run.started', {
      sessionId: 'busy',
      ctx: {} as never,
      model: 'm',
      at: new Date().toISOString(),
    });
    events.emit('tool.started', { sessionId: 'busy', name: 'bash', id: 'slow' });
    await vi.advanceTimersByTimeAsync(70_000);
    expect(brain.decide).toHaveBeenCalledOnce();
  });

  it('clears unfinished tool tracking when the run ends', async () => {
    const brain: BrainArbiter = { decide: vi.fn(async () => STEER) };
    monitor({ brain });
    runStarted();
    events.emit('tool.started', { name: 'bash', id: 'aborted' });
    runCompleted();
    runStarted();
    await vi.advanceTimersByTimeAsync(70_000);
    expect(brain.decide).toHaveBeenCalledOnce();
  });

  it('discards a pending council steer when a tool starts during deliberation', async () => {
    let resolveDecision!: (decision: BrainDecision) => void;
    const brain: BrainArbiter = {
      decide: vi.fn(
        () =>
          new Promise<BrainDecision>((resolve) => {
            resolveDecision = resolve;
          }),
      ),
    };
    const intervene = vi.fn(async () => {});
    monitor({ brain, intervene });
    runStarted();
    await vi.advanceTimersByTimeAsync(70_000);
    expect(brain.decide).toHaveBeenCalledOnce();
    events.emit('tool.started', { name: 'bash', id: 'resumed' });
    resolveDecision(STEER);
    await vi.advanceTimersByTimeAsync(0);
    expect(intervene).not.toHaveBeenCalled();
  });

  it('stays quiet when no run is active', async () => {
    const emitted: EventMap['brain.intervention'][] = [];
    events.on('brain.intervention', (e) => emitted.push(e));
    monitor();

    runStarted();
    runCompleted();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(emitted).toHaveLength(0);
  });
});

describe('createLedgerGuardBrainArbiter', () => {
  const inner: BrainArbiter = {
    decide: vi.fn(async () => ({ type: 'answer', text: 'inner decided' }) as BrainDecision),
  };
  const request = {
    id: 'g1',
    source: 'director' as const,
    question: 'Extend the budget?',
    risk: 'medium' as const,
    fallback: 'ask_human' as const,
  };

  it('denies deterministically at the failure-streak threshold', async () => {
    const guard = createLedgerGuardBrainArbiter({
      inner,
      failureStreakFor: () => 3,
    });
    const d = await guard.decide(request);
    expect(d.type).toBe('deny');
    if (d.type === 'deny') expect(d.reason).toContain('Ledger guard');
  });

  it('passes through below the threshold', async () => {
    const guard = createLedgerGuardBrainArbiter({ inner, failureStreakFor: () => 2 });
    const d = await guard.decide(request);
    expect(d).toMatchObject({ type: 'answer', text: 'inner decided' });
  });

  it('denyAfter: 0 disables the guard entirely', async () => {
    const guard = createLedgerGuardBrainArbiter({
      inner,
      failureStreakFor: () => 99,
      denyAfter: 0,
    });
    const d = await guard.decide(request);
    expect(d.type).toBe('answer');
  });
});

describe('BrainDecisionLedger.failureStreakFor', () => {
  it('counts consecutive failures, skips unknown outcomes, stops at a success', async () => {
    const events = new EventBus();
    const ledger = new BrainDecisionLedger({
      events,
      filePath: 'Z:/nonexistent/never-written.jsonl',
    });
    // No start() — feed events after subscribing manually via start-less API:
    await ledger.start().catch(() => {});

    const answered = (id: string) =>
      events.emit('brain.decision_answered', {
        request: {
          id,
          source: 'director',
          question: 'Should the director extend the tokens budget for subagent w1?',
          risk: 'medium',
          fallback: 'continue',
        },
        decision: { type: 'answer', optionId: 'extend', text: 'Extend' },
        at: Date.now(),
      });

    answered('r1'); // success → breaks the streak
    answered('r2'); // unknown outcome → skipped
    answered('r3'); // failure
    answered('r4'); // failure
    ledger.recordOutcome('r1', 'success');
    ledger.recordOutcome('r3', 'failure');
    ledger.recordOutcome('r4', 'failure');

    const streak = ledger.failureStreakFor({
      id: 'r-new',
      source: 'director',
      question: 'Should the director extend the tokens budget for subagent w9?',
    });
    expect(streak).toBe(2);
    await ledger.stop();
  });
});
