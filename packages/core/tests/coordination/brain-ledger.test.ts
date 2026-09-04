import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrainDecision, BrainDecisionRequest } from '../../src/coordination/brain.js';
import {
  BrainDecisionLedger,
  type BrainLedgerEntry,
  brainDecisionKey,
  createLedgerGuardBrainArbiter,
} from '../../src/coordination/brain-ledger.js';
import { EventBus } from '../../src/kernel/events.js';

let dir: string;
let events: EventBus;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'brain-ledger-'));
  events = new EventBus();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const filePath = () => join(dir, 'brain-ledger.jsonl');

const request = (over: Partial<BrainDecisionRequest> = {}): BrainDecisionRequest => ({
  id: 'req-1',
  source: 'director',
  question: 'Should the director extend the tokens budget for subagent w1?',
  risk: 'medium',
  fallback: 'continue',
  ...over,
});

const answered = (req: BrainDecisionRequest, optionId?: string) => {
  const decision: BrainDecision = {
    type: 'answer',
    optionId,
    text: optionId ?? 'ok',
    rationale: 'looks fine',
  };
  events.emit('brain.decision_answered', {
    sessionId: 's1',
    request: req,
    decision,
    at: Date.now(),
  });
};

async function makeLedger(
  opts: Partial<ConstructorParameters<typeof BrainDecisionLedger>[0]> = {},
) {
  const ledger = new BrainDecisionLedger({ events, filePath: filePath(), ...opts });
  await ledger.start();
  return ledger;
}

describe('brainDecisionKey', () => {
  it('collapses id/number-shaped tokens so similar questions group together', () => {
    const a = brainDecisionKey(
      'director',
      'Should the director extend the tokens budget for subagent w1?',
    );
    const b = brainDecisionKey(
      'director',
      'Should the director extend the tokens budget for subagent worker-42?',
    );
    expect(a).toBe(b);
  });

  it('keeps different sources apart', () => {
    expect(brainDecisionKey('director', 'q')).not.toBe(brainDecisionKey('system', 'q'));
  });
});

describe('BrainDecisionLedger — recording + persistence', () => {
  it('records decision events to memory and JSONL', async () => {
    const ledger = await makeLedger();
    answered(request(), 'extend');
    events.emit('brain.decision_denied', {
      sessionId: 's1',
      request: request({ id: 'req-2' }),
      decision: { type: 'deny', reason: 'too many extensions' },
      at: Date.now(),
    });
    await ledger.stop();

    expect(ledger.tail(10).map((e) => e.kind)).toEqual(['answered', 'denied']);
    const rows = (await readFile(filePath(), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as BrainLedgerEntry);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ kind: 'answered', requestId: 'req-1', optionId: 'extend' });
    expect(rows[1]).toMatchObject({ kind: 'denied', requestId: 'req-2' });
  });

  it('seeds a new instance from the JSONL tail (cross-session learning)', async () => {
    const first = await makeLedger();
    answered(request(), 'extend');
    first.recordOutcome('req-1', 'failure', 'task failed after extension');
    await first.stop();

    const second = await makeLedger();
    const digest = second.digestFor(request({ id: 'req-99' }));
    expect(digest).toContain('later FAILED');
    await second.stop();
  });

  it('survives corrupt rows in the file', async () => {
    const first = await makeLedger();
    answered(request(), 'extend');
    await first.stop();
    const { appendFile } = await import('node:fs/promises');
    await appendFile(filePath(), 'NOT-JSON\n{"broken":\n', 'utf8');

    const second = await makeLedger();
    expect(second.tail(10)).toHaveLength(1);
    await second.stop();
  });
});

describe('BrainDecisionLedger — budget outcome correlation', () => {
  it('links a budget extension decision to the subagent task result', async () => {
    const ledger = await makeLedger();
    const outcomes: Array<{ requestId: string; outcome: string }> = [];
    events.on('brain.outcome', (e) =>
      outcomes.push({ requestId: e.requestId, outcome: e.outcome }),
    );

    const req = request({ id: 'director-budget-w1-tokens' });
    answered(req, 'extend');
    events.emit('subagent.budget_extended', {
      sessionId: 's1',
      subagentId: 'w1',
      kind: 'tokens',
      newLimit: 100,
      totalExtensions: 1,
    });
    events.emit('subagent.task_completed', {
      sessionId: 's1',
      subagentId: 'w1',
      taskId: 't1',
      status: 'failed',
      iterations: 3,
      toolCalls: 5,
      durationMs: 1000,
    });

    expect(outcomes).toEqual([{ requestId: 'director-budget-w1-tokens', outcome: 'failure' }]);
    const rows = ledger.tail(10);
    expect(rows.at(-1)).toMatchObject({ kind: 'outcome', outcome: 'failure' });
    await ledger.stop();
  });

  it('ignores extensions the brain never decided on', async () => {
    const ledger = await makeLedger();
    const outcomes: unknown[] = [];
    events.on('brain.outcome', (e) => outcomes.push(e));
    events.emit('subagent.budget_extended', {
      subagentId: 'w9',
      kind: 'tokens',
      newLimit: 100,
      totalExtensions: 1,
    });
    events.emit('subagent.task_completed', {
      subagentId: 'w9',
      taskId: 't1',
      status: 'success',
      iterations: 1,
      toolCalls: 1,
      durationMs: 10,
    });
    expect(outcomes).toEqual([]);
    await ledger.stop();
  });
});

describe('BrainDecisionLedger — intervention re-engagement', () => {
  const intervention = (id: string, at: number, intervened = true) => {
    events.emit('brain.intervention', {
      sessionId: 's1',
      kind: 'tool_failure_streak',
      request: request({ id, question: 'The tool "edit" has failed 3 times in a row.' }),
      decision: { type: 'answer', text: 'steer' },
      intervened,
      at,
    });
  };

  it('marks the previous steer as failed when the same signal re-triggers in the window', async () => {
    let now = 1_000_000;
    const ledger = await makeLedger({ now: () => now, interventionRetryWindowMs: 60_000 });
    const outcomes: Array<{ requestId: string; outcome: string }> = [];
    events.on('brain.outcome', (e) =>
      outcomes.push({ requestId: e.requestId, outcome: e.outcome }),
    );

    intervention('int-1', now);
    now += 30_000;
    intervention('int-2', now);
    expect(outcomes).toEqual([{ requestId: 'int-1', outcome: 'failure' }]);
    await ledger.stop();
  });

  it('does not blame steers outside the retry window', async () => {
    let now = 1_000_000;
    const ledger = await makeLedger({ now: () => now, interventionRetryWindowMs: 60_000 });
    const outcomes: unknown[] = [];
    events.on('brain.outcome', (e) => outcomes.push(e));

    intervention('int-1', now);
    now += 120_000;
    intervention('int-2', now);
    expect(outcomes).toEqual([]);
    await ledger.stop();
  });
});

describe('BrainDecisionLedger — digestFor', () => {
  it('returns undefined with no related history', async () => {
    const ledger = await makeLedger();
    expect(ledger.digestFor(request())).toBeUndefined();
    await ledger.stop();
  });

  it('summarizes similar decisions and their outcomes', async () => {
    const ledger = await makeLedger();
    answered(request({ id: 'r1' }), 'extend');
    answered(
      request({
        id: 'r2',
        question: 'Should the director extend the tokens budget for subagent w7?',
      }),
      'extend',
    );
    ledger.recordOutcome('r1', 'failure');
    events.emit('brain.decision_denied', {
      request: request({ id: 'r3' }),
      decision: { type: 'deny', reason: 'cap' },
      at: Date.now(),
    });

    const digest = ledger.digestFor(request({ id: 'r-new' }));
    expect(digest).toBeDefined();
    expect(digest).toContain('chose [extend]');
    expect(digest).toContain('later FAILED');
    expect(digest).toContain('3 similar decision(s)');
    expect(digest).toContain('1 later failed');
    await ledger.stop();
  });

  it('excludes unrelated questions', async () => {
    const ledger = await makeLedger();
    answered(request({ id: 'r1', source: 'goal', question: 'Resolve merge conflicts?' }));
    expect(ledger.digestFor(request({ id: 'r-new' }))).toBeUndefined();
    await ledger.stop();
  });
});

describe('BrainDecisionLedger — digest injection point', () => {
  it('withDecisionDigest shape reaches the LLM user message', async () => {
    const { createAutonomyBrain } = await import('../../src/execution/autonomy-brain.js');
    const seen: string[] = [];
    const provider = {
      id: 'fake',
      capabilities: {},
      stream: vi.fn(),
      complete: vi.fn(async (reqBody: { messages: Array<{ content: string }> }) => {
        seen.push(reqBody.messages[0]?.content ?? '');
        return { content: [{ type: 'text', text: 'Continue execution.' }] };
      }),
    } as never;
    const brain = createAutonomyBrain({
      provider,
      model: 'm',
      getDecisionDigest: () => '- 2m ago: chose [extend] → later FAILED',
    });
    await brain.decide(request({ question: 'Is the goal complete?' }));
    expect(seen[0]).toContain('Outcome history of similar past decisions');
    expect(seen[0]).toContain('later FAILED');
  });
});

describe('createLedgerGuardBrainArbiter — ladder step', () => {
  it('emits a terminal ledger-guard step naming the failure streak', async () => {
    const steps: Array<Record<string, unknown>> = [];
    events.on('brain.tier_transition', (e) => steps.push(e as Record<string, unknown>));
    const inner = {
      decide: vi.fn(async (): Promise<BrainDecision> => ({ type: 'answer', text: 'go' })),
    };
    const arbiter = createLedgerGuardBrainArbiter({
      inner,
      failureStreakFor: () => 4,
      denyAfter: 3,
      events,
    });

    const decision = await arbiter.decide({
      id: 'g1',
      source: 'director',
      question: 'Extend the budget again?',
      risk: 'high',
      fallback: 'deny',
    });

    expect(decision.type).toBe('deny');
    expect(inner.decide).not.toHaveBeenCalled();
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      tier: 'ledger-guard',
      outcome: 'deny',
      terminal: true,
      reason: '4 consecutive observed failures on record',
    });
  });

  it('emits nothing when the streak is below the threshold', async () => {
    const steps: unknown[] = [];
    events.on('brain.tier_transition', (e) => steps.push(e));
    const arbiter = createLedgerGuardBrainArbiter({
      inner: { decide: async (): Promise<BrainDecision> => ({ type: 'answer', text: 'go' }) },
      failureStreakFor: () => 1,
      denyAfter: 3,
      events,
    });

    await arbiter.decide({
      id: 'g2',
      source: 'director',
      question: 'Extend?',
      risk: 'high',
      fallback: 'deny',
    });

    expect(steps).toEqual([]);
  });
});
