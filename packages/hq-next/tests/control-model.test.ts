import type { HqClientRecord, HqCommandAuditEntry, HqSessionSnapshotPayload } from '@wrongstack/hq';
import { describe, expect, it } from 'vitest';
import {
  canReceiveControl,
  canSend,
  freezeReview,
  mergeAudit,
  type Review,
  readAudit,
  reviewProblem,
  sessionsForClient,
} from '../src/features/control/model';

const client = (clientId: string, extra: Partial<HqClientRecord> = {}): HqClientRecord => ({
  clientId,
  kind: 'cli',
  machineId: 'm1',
  projectId: 'p1',
  connected: true,
  lastSeenAt: '2026-10-31T00:00:00.000Z',
  capabilities: ['control.receive'],
  ...extra,
});
const session = (sessionId: string, extra: Partial<HqSessionSnapshotPayload> = {}) =>
  ({
    sessionId,
    machineId: 'm1',
    projectId: 'p1',
    agents: [],
    ...extra,
  }) as HqSessionSnapshotPayload;

const review = (extra: Partial<Review> = {}): Review => ({
  clientId: 'c1',
  target: 'atlas › P1',
  sessionId: 's1',
  type: 'abort',
  payload: { target: 'leader', sessionId: 's1' },
  summary: 'Abort the leader run.',
  danger: true,
  confirmWord: 'ABORT',
  ...extra,
});

describe('control targets', () => {
  it('only offers connected clients that accept commands', () => {
    expect(canReceiveControl(client('a'))).toBe(true);
    expect(canReceiveControl(client('b', { connected: false }))).toBe(false);
    expect(canReceiveControl(client('c', { capabilities: [] }))).toBe(false);
  });

  it('finds sessions by client id or by the same process', () => {
    const owner = client('c1', { pid: 42 });
    const found = sessionsForClient(owner, [
      session('by-id', { clientId: 'c1' }),
      session('by-pid', { pid: 42 }),
      session('other-pid', { pid: 7 }),
      session('other-project', { pid: 42, projectId: 'p2' }),
    ]);
    expect(found.map((entry) => entry.sessionId)).toEqual(['by-id', 'by-pid']);
  });
});

describe('the frozen review', () => {
  it('cannot be changed by later edits to the form', () => {
    const payload = { to: 'leader', body: 'stop' };
    const frozen = freezeReview(review({ payload }));
    payload.body = 'rm -rf';
    expect(frozen.payload.body).toBe('stop');
  });

  it('refuses to send when the reviewed client or session went away — never redirects', () => {
    const sessions = [session('s1', { clientId: 'c1' })];
    expect(reviewProblem(review(), [client('c1')], sessions)).toBeNull();
    expect(reviewProblem(review(), [client('c2')], sessions)).toMatch(/disconnected/);
    expect(reviewProblem(review(), [client('c1', { connected: false })], sessions)).toMatch(
      /disconnected/,
    );
    expect(reviewProblem(review(), [client('c1', { capabilities: [] })], sessions)).toMatch(
      /no longer accepts/,
    );
    expect(reviewProblem(review(), [client('c1')], [])).toMatch(/session ended/);
    expect(reviewProblem(review({ sessionId: undefined }), [client('c1')], [])).toBeNull();
  });

  it('needs the exact confirmation word for destructive commands', () => {
    expect(canSend(review(), 'abort', null)).toBe(false);
    expect(canSend(review(), 'ABORT', null)).toBe(true);
    expect(canSend(review(), 'ABORT', 'gone')).toBe(false);
    expect(canSend(review({ confirmWord: null }), '', null)).toBe(true);
  });
});

describe('command audit', () => {
  const entry = (extra: Partial<HqCommandAuditEntry>): HqCommandAuditEntry => ({
    commandId: 'x',
    type: 'steer',
    clientId: 'c1',
    enqueuedBy: 'op',
    enqueuedAt: new Date(0).toISOString(),
    status: 'queued',
    ...extra,
  });

  it('reads the lifecycle in words and flags a command stuck in the queue', () => {
    expect(readAudit(entry({ enqueuedAt: new Date(1_000).toISOString() }), 30_000).stuck).toBe(
      false,
    );
    expect(readAudit(entry({ enqueuedAt: new Date(1_000).toISOString() }), 120_000)).toMatchObject({
      stuck: true,
      tone: 'warn',
    });
    expect(readAudit(entry({ status: 'acked', ackStatus: 'rejected' }), 0)).toMatchObject({
      label: 'Refused by the client',
      tone: 'bad',
    });
    expect(readAudit(entry({ status: 'delivered' }), 0).label).toBe('Delivered, no answer yet');
  });

  it('lets a live update replace the polled row', () => {
    const merged = mergeAudit(
      [
        entry({ commandId: 'a', enqueuedAt: '2026-01-01T00:00:01Z' }),
        entry({ commandId: 'b', enqueuedAt: '2026-01-01T00:00:02Z' }),
      ],
      [entry({ commandId: 'a', enqueuedAt: '2026-01-01T00:00:01Z', status: 'acked' })],
      10,
    );
    expect(merged.map((row) => [row.commandId, row.status])).toEqual([
      ['b', 'queued'],
      ['a', 'acked'],
    ]);
  });
});
