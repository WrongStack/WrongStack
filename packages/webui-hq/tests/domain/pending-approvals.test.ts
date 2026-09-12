/**
 * Pending-approval derivation.
 *
 * HQ keeps no server-side registry of prompts; the dashboard folds
 * `approval.requested` against `approval.resolved`. That is only sound because
 * a pending approval cannot outlive its own deadline — after it, the Brain
 * arbiter owns the decision. These tests pin that rule, because without it a
 * request whose matching `resolved` fell outside the fetched window would
 * strand a card offering an answer that can never land.
 */
import type { HqEventEnvelope } from '@wrongstack/core/hq';
import { describe, expect, it } from 'vitest';
import { derivePendingApprovals } from '../../src/domain/use-pending-approvals.js';

const NOW = Date.parse('2026-09-12T12:00:00.000Z');

let seq = 0;

function requested(
  toolUseId: string,
  overrides: { deadlineAt?: number; sessionId?: string; clientId?: string } = {},
): HqEventEnvelope {
  seq += 1;
  return {
    id: `evt-${seq}`,
    type: 'approval.requested',
    schemaVersion: 1,
    timestamp: new Date(NOW).toISOString(),
    clientId: overrides.clientId ?? 'client-1',
    projectId: 'proj-1',
    sessionId: overrides.sessionId ?? 'sess-1',
    seq,
    payload: {
      toolUseId,
      toolName: 'bash',
      suggestedPattern: 'bash:rm',
      deadlineAt: overrides.deadlineAt ?? NOW + 60_000,
      destructive: true,
    },
  } as HqEventEnvelope;
}

function resolvedEvent(toolUseId: string): HqEventEnvelope {
  seq += 1;
  return {
    id: `evt-${seq}`,
    type: 'approval.resolved',
    schemaVersion: 1,
    timestamp: new Date(NOW).toISOString(),
    clientId: 'client-1',
    projectId: 'proj-1',
    sessionId: 'sess-1',
    seq,
    payload: { toolUseId, toolName: 'bash', decision: 'yes', source: 'user' },
  } as HqEventEnvelope;
}

describe('derivePendingApprovals', () => {
  it('surfaces a request with its client, session and time remaining', () => {
    const [approval] = derivePendingApprovals([requested('toolu_1')], [], NOW);
    expect(approval).toMatchObject({
      toolUseId: 'toolu_1',
      clientId: 'client-1',
      sessionId: 'sess-1',
      remainingMs: 60_000,
    });
  });

  it('drops a request that was answered anywhere', () => {
    const pending = derivePendingApprovals(
      [requested('toolu_1'), requested('toolu_2')],
      [resolvedEvent('toolu_1')],
      NOW,
    );
    expect(pending.map((a) => a.toolUseId)).toEqual(['toolu_2']);
  });

  it('drops a request whose deadline has passed even with no resolved event', () => {
    // The load-bearing case: the answer happened but its envelope is outside
    // the window we read. The deadline alone has to settle it.
    const pending = derivePendingApprovals([requested('toolu_1', { deadlineAt: NOW })], [], NOW);
    expect(pending).toEqual([]);
  });

  it('collapses a replayed request instead of stacking a duplicate card', () => {
    // The publisher republishes its outstanding set on every reconnect.
    const pending = derivePendingApprovals([requested('toolu_1'), requested('toolu_1')], [], NOW);
    expect(pending).toHaveLength(1);
  });

  it('orders the most urgent first', () => {
    const pending = derivePendingApprovals(
      [
        requested('slow', { deadlineAt: NOW + 90_000 }),
        requested('urgent', { deadlineAt: NOW + 5_000 }),
      ],
      [],
      NOW,
    );
    expect(pending.map((a) => a.toolUseId)).toEqual(['urgent', 'slow']);
  });
});
