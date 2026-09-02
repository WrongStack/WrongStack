/**
 * The Attention badge is a sum of five independent sources. Its whole value is
 * that an operator does not have to remember which surface a problem lives on,
 * so every source must keep contributing.
 */
import { describe, expect, it } from 'vitest';
import {
  actionableAlertCount,
  attentionCount,
  unreadMailboxCount,
} from '../../src/data/selectors.js';
import { alert, commandEntry, liveSnapshot, snapshot, snapshotWithClient } from '../fixtures/hq.js';

describe('actionableAlertCount', () => {
  it('ignores info alerts — they are history, not a signal', () => {
    expect(
      actionableAlertCount([
        alert({ severity: 'info' }),
        alert({ severity: 'warn' }),
        alert({ severity: 'error' }),
      ]),
    ).toBe(2);
  });
});

describe('attentionCount', () => {
  it('is zero on a quiet fleet', () => {
    expect(attentionCount(snapshot(), [], [])).toBe(0);
  });

  it('counts non-info alerts', () => {
    expect(attentionCount(snapshot(), [alert({ severity: 'error' })], [])).toBe(1);
  });

  it('counts a degraded or unreadable governance signal', () => {
    const withGovernance = {
      ...snapshot(),
      projects: [
        {
          projectId: 'p1',
          projectName: 'P1',
          activeSessions: 0,
          activeSubagents: 0,
          activeClients: 0,
          totalCostUsd: 0,
          governance: { signal: { level: 'warning', code: 'drift', executionDisposition: 'hold' } },
        },
      ],
    } as never;
    expect(attentionCount(withGovernance, [], [])).toBe(1);
  });

  it('counts agents blocked on a human', () => {
    const blocked = liveSnapshot('s1', ['a1']);
    blocked.liveSessions![0]!.agents[0]!.status = 'waiting_user';
    expect(attentionCount(blocked, [], [])).toBe(1);
  });

  it('counts a client the server has lost', () => {
    const lost = snapshotWithClient('c1');
    lost.clients[0]!.connected = false;
    expect(attentionCount(lost, [], [])).toBe(1);
  });

  it.each(['failed', 'rejected'] as const)('counts a %s command', (ackStatus) => {
    expect(attentionCount(snapshot(), [], [commandEntry('c1', { ackStatus })])).toBe(1);
  });

  it('sums every source rather than picking the loudest', () => {
    const lost = snapshotWithClient('c1');
    lost.clients[0]!.connected = false;
    expect(
      attentionCount(
        lost,
        [alert({ severity: 'error' })],
        [commandEntry('c1', { ackStatus: 'failed' })],
      ),
    ).toBe(3);
  });

  it('survives a snapshot that has not arrived yet', () => {
    expect(attentionCount(null, [], [])).toBe(0);
  });
});

describe('unreadMailboxCount', () => {
  it('reads the snapshot total, or zero before the first snapshot', () => {
    expect(unreadMailboxCount(null)).toBe(0);
    const withUnread = snapshot();
    withUnread.totals.unreadMailboxMessages = 4;
    expect(unreadMailboxCount(withUnread)).toBe(4);
  });
});
