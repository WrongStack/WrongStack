/**
 * The console header's agent line and the governance card's wording.
 */
import type { HqGovernanceSnapshotPayload, HqSessionSnapshotPayload } from '@wrongstack/hq';
import { describe, expect, it } from 'vitest';
import { governanceDetail, governanceLabel } from '../src/features/attention/governance';
import { agentFacts } from '../src/features/console/model';

type Agent = HqSessionSnapshotPayload['agents'][number];
const agent = (id: string, extra: Partial<Agent> = {}): Agent => ({
  id,
  name: id,
  status: 'running',
  iterations: 1,
  toolCalls: 0,
  lastActivityAt: '2026-11-01T12:00:00.000Z',
  ...extra,
});
const session = (agents: Agent[]) => ({ agents }) as unknown as HqSessionSnapshotPayload;

describe('agentFacts', () => {
  it('describes the leader on a session view', () => {
    const facts = agentFacts(
      session([
        agent('worker'),
        agent('leader', {
          model: 'claude-fable-5',
          ctxPct: 38.4,
          tokensIn: 182_000,
          tokensOut: 24_500,
          costUsd: 0.43,
        }),
      ]),
      null,
      null,
    );
    expect(facts).toEqual({
      model: 'claude-fable-5',
      contextPct: 38,
      contextTone: 'ok',
      tokens: '182k in · 24.5k out',
      costUsd: 0.43,
    });
  });

  it('warns as the context fills, and says nothing about an unknown agent', () => {
    expect(agentFacts(undefined, agent('a', { ctxPct: 85 }), 'a')?.contextTone).toBe('warn');
    expect(agentFacts(undefined, agent('a', { ctxPct: 120 }), 'a')).toMatchObject({
      contextPct: 100,
      contextTone: 'bad',
    });
    expect(agentFacts(session([agent('leader')]), null, 'missing')).toBeNull();
    expect(agentFacts(undefined, agent('a', { tokensIn: 1_250_000 }), 'a')?.tokens).toBe(
      '1.3M in · 0 out',
    );
  });
});

describe('governance wording', () => {
  const payload = (extra: Partial<HqGovernanceSnapshotPayload>): HqGovernanceSnapshotPayload => ({
    schemaVersion: 1,
    projectId: 'p1',
    observedAt: '2026-11-01T12:00:00.000Z',
    available: true,
    signal: {
      level: 'warning',
      code: 'attachment_broker_audit_unhealthy',
      operatorAction: 'investigate',
      executionDisposition: 'continue',
    },
    ...extra,
  });

  it('names the code in words', () => {
    expect(governanceLabel('broker_missing')).toBe('No broker');
  });

  it('explains the signal, advises, and flags the broker facts that are wrong', () => {
    const detail = governanceDetail(
      payload({
        attachmentBroker: {
          state: 'retry_wait',
          health: 'degraded',
          consecutiveFailures: 4,
          pendingRevocations: 0,
          auditHealthy: false,
        },
        daemon: { pid: 912, startedAt: '2026-11-01T10:00:00.000Z' },
      }),
    );
    expect(detail.sentence).toBe(
      'The broker cannot write its audit log, so decisions are not being recorded. Look at the governance daemon on that machine.',
    );
    expect(detail.facts.map((fact) => [fact.label, fact.warn ?? false])).toEqual([
      ['Broker', true],
      ['Failures in a row', true],
      ['Audit log', true],
      ['Daemon', false],
      ['Observed', false],
    ]);
    expect(detail.facts[0]?.value).toBe('retry wait · degraded');
  });
});
