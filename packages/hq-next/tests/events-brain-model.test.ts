import type { HqBrainEventPayload, HqEventEnvelope } from '@wrongstack/hq';
import { describe, expect, it } from 'vitest';
import { buildTrail, filterTrail, summarize } from '../src/features/brain/model';
import { chainRows, eventLabel, groupByDay, payloadFacts } from '../src/features/events/model';

describe('event log', () => {
  it('chains only consecutive rows that share a correlation id', () => {
    const rows = chainRows([
      { correlationId: 'a' },
      { correlationId: 'a' },
      { correlationId: 'b' },
      {},
      { correlationId: 'a' },
    ]);
    expect(rows.map((row) => [row.chainId, row.chainHead, row.chainSize])).toEqual([
      ['a', true, 2],
      ['a', false, 2],
      [undefined, false, 1],
      [undefined, false, 1],
      [undefined, false, 1],
    ]);
  });

  it('groups consecutive rows by local day', () => {
    const at = (day: number, hour: number) => new Date(2026, 9, day, hour).toISOString();
    const days = groupByDay(
      chainRows([{ timestamp: at(31, 9) }, { timestamp: at(31, 1) }, { timestamp: at(30, 23) }]),
    );
    expect(days.map((day) => [day.key, day.rows.length])).toEqual([
      ['2026-10-31', 2],
      ['2026-10-30', 1],
    ]);
  });

  it('reads the interesting scalars of a payload, never ids, at most four', () => {
    expect(
      payloadFacts({
        sessionId: 's1',
        nested: { a: 1 },
        extra: 'x',
        status: 'ok',
        toolName: 'edit',
        durationMs: 12,
        message: '  line\n  two ',
        more: 'y',
      }),
    ).toEqual([
      { key: 'toolName', label: 'Tool', value: 'edit' },
      { key: 'status', label: 'Status', value: 'ok' },
      { key: 'message', label: 'Message', value: 'line two' },
      { key: 'durationMs', label: 'Took', value: '12 ms' },
    ]);
    expect(payloadFacts([1, 2])).toEqual([]);
  });

  it('names keys in words and formats cost, duration and counts', () => {
    const label = (key: string) => payloadFacts({ [key]: 'x' })[0]?.label;
    expect(label('ownerLabel')).toBe('Owner');
    expect(label('baseBranch')).toBe('Base');
    expect(label('exit_code')).toBe('Exit code');
    expect(label('linesAdded')).toBe('Lines added');
    const facts = payloadFacts({
      costUsd: 0.045,
      inputTokens: 16500,
      durationMs: 2400,
      insertions: 120,
    });
    expect(facts.map((fact) => fact.value)).toEqual(['$0.045', '2.4 s', '16,500', '120']);
    expect(payloadFacts({ costUsd: 1.5 })[0]?.value).toBe('$1.50');
    expect(payloadFacts({ costUsd: 0 })[0]?.value).toBe('$0.00');
  });

  it('names types in words and keeps unknown ones', () => {
    expect(eventLabel('tool.completed')).toBe('Tool finished');
    expect(eventLabel('custom.thing')).toBe('custom.thing');
    expect(eventLabel(undefined)).toBe('Unknown event');
  });
});

let seq = 0;
const brain = (
  payload: Partial<HqBrainEventPayload> & Pick<HqBrainEventPayload, 'kind' | 'at'>,
  session = 's1',
): HqEventEnvelope => {
  seq += 1;
  return {
    id: `e${seq}`,
    type: 'brain.event',
    schemaVersion: 1,
    timestamp: new Date(payload.at).toISOString(),
    clientId: 'c1',
    projectId: 'p1',
    sessionId: session,
    payload,
  } as HqEventEnvelope;
};

describe('brain trail', () => {
  it('folds request, escalation and the human answer into one decision', () => {
    const trail = buildTrail([
      brain({ kind: 'human_answered', requestId: 'r1', at: 30, detail: 'ship it' }),
      brain({
        kind: 'decision_requested',
        requestId: 'r1',
        at: 10,
        question: 'Deploy?',
        risk: 'high',
        source: 'autonomy',
      }),
      brain({ kind: 'decision_ask_human', requestId: 'r1', at: 20, pending: true, tier: 'policy' }),
    ]);
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({
      kind: 'decision',
      question: 'Deploy?',
      outcome: 'human',
      humanDetail: 'ship it',
      risk: 'high',
      tier: 'policy',
      startedAt: 10,
      lastAt: 30,
    });
  });

  it('keeps the same request id in two sessions apart and leaves pending escalations waiting', () => {
    const trail = buildTrail([
      brain({ kind: 'decision_requested', requestId: 'r1', at: 1 }, 's1'),
      brain({ kind: 'decision_ask_human', requestId: 'r1', at: 2, pending: true }, 's1'),
      brain({ kind: 'decision_requested', requestId: 'r1', at: 3 }, 's2'),
      brain(
        { kind: 'decision_answered', requestId: 'r1', at: 4, tier: 'council', decision: 'answer' },
        's2',
      ),
    ]);
    expect(trail.map((item) => item.kind === 'decision' && [item.sessionId, item.outcome])).toEqual(
      [
        ['s2', 'answered'],
        ['s1', 'waiting'],
      ],
    );
    expect(filterTrail(trail, 'waiting')).toHaveLength(1);
    expect(filterTrail(trail, 'model')).toHaveLength(1);
  });

  it('flags a council that asked one model several times', () => {
    const [decision] = buildTrail([
      brain({ kind: 'decision_requested', requestId: 'r9', at: 1 }),
      brain({
        kind: 'council_resolved',
        requestId: 'r9',
        at: 2,
        seatCount: 3,
        validVoteCount: 3,
        distinctTargetCount: 1,
        totalTokens: 900,
      }),
      brain({ kind: 'decision_answered', requestId: 'r9', at: 3, tier: 'council' }),
    ]);
    expect(decision?.kind === 'decision' && decision.council?.degraded).toBe(true);
    expect(decision?.kind === 'decision' && decision.outcome).toBe('answered');
  });

  it('summarizes outcomes, cost tiers and interventions', () => {
    const trail = buildTrail([
      brain({ kind: 'decision_answered', requestId: 'a', at: 1, tier: 'rule' }),
      brain({ kind: 'decision_denied', requestId: 'b', at: 2, tier: 'llm', risk: 'critical' }),
      brain({ kind: 'intervention', at: 3, intervened: true }),
      brain({ kind: 'intervention', at: 4, intervened: false }),
    ]);
    expect(summarize(trail)).toMatchObject({
      decisions: 2,
      answered: 1,
      denied: 1,
      highRisk: 1,
      modelBacked: 1,
      free: 1,
      interventions: 2,
      steered: 1,
    });
  });
});
