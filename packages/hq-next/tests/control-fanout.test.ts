/**
 * One command to several sessions: never more authority than one-by-one, a
 * typed count before sending, vanished targets skipped, refusals stop the run.
 */
import type { HqClientRecord, HqSessionSnapshotPayload } from '@wrongstack/hq';
import { describe, expect, it } from 'vitest';
import {
  type FanoutOutcome,
  fanoutBlocker,
  fanoutCandidates,
  freezeFanout,
  MAX_FANOUT_TARGETS,
  runFanout,
  vanishedTargets,
} from '../src/features/control/fanout';
import { HqHttpError } from '../src/hq/data/api';

const client = (id: string, extra: Partial<HqClientRecord> = {}): HqClientRecord =>
  ({
    clientId: id,
    kind: 'tui',
    machineId: `m-${id}`,
    hostname: `host-${id}`,
    connected: true,
    lastSeenAt: '2026-11-01T12:00:00.000Z',
    projectId: 'p1',
    capabilities: ['control.receive'],
    ...extra,
  }) as HqClientRecord;

const session = (id: string, clientId: string): HqSessionSnapshotPayload =>
  ({
    sessionId: id,
    clientId,
    clientKind: 'tui',
    machineId: `m-${clientId}`,
    hostname: `host-${clientId}`,
    projectId: 'p1',
    projectName: 'Alpha',
    projectRoot: '/r',
    status: 'active',
    startedAt: '2026-11-01T12:00:00.000Z',
    lastActivityAt: '2026-11-01T12:00:00.000Z',
    agentCount: 1,
    agents: [],
  }) as HqSessionSnapshotPayload;

const clients = [
  client('a'),
  client('b'),
  client('mute', { capabilities: [] }),
  client('gone', { connected: false }),
];
const sessions = [
  session('s-a', 'a'),
  session('s-b', 'b'),
  session('s-mute', 'mute'),
  session('s-gone', 'gone'),
];

describe('fanout targets', () => {
  it('offers only live sessions whose client accepts commands', () => {
    expect(fanoutCandidates(clients, sessions).map((target) => target.sessionId)).toEqual([
      's-a',
      's-b',
    ]);
  });

  it('asks for the count, ABORT plus the count for an abort, and caps the size', () => {
    const targets = fanoutCandidates(clients, sessions);
    expect(freezeFanout({ type: 'steer', payload: {}, summary: '', targets }).confirmWord).toBe(
      '2',
    );
    expect(freezeFanout({ type: 'abort', payload: {}, summary: '', targets }).confirmWord).toBe(
      'ABORT 2',
    );
    expect(fanoutBlocker(0)).toMatch(/at least one/);
    expect(fanoutBlocker(MAX_FANOUT_TARGETS + 1)).toMatch(/At most/);
    expect(fanoutBlocker(2)).toBeNull();
  });

  it('freezes a deep copy of what was reviewed', () => {
    const payload = { body: 'hi' };
    const targets = fanoutCandidates(clients, sessions);
    const review = freezeFanout({ type: 'btw', payload, summary: 's', targets });
    payload.body = 'changed';
    targets.pop();
    expect(review.payload.body).toBe('hi');
    expect(review.targets).toHaveLength(2);
    expect(review.confirmWord).toBe('2');
  });

  it('reports reviewed targets that ended', () => {
    const review = freezeFanout({
      type: 'steer',
      payload: {},
      summary: '',
      targets: fanoutCandidates(clients, sessions),
    });
    expect([...vanishedTargets(review, clients, [session('s-a', 'a')])]).toEqual(['s-b']);
  });
});

describe('runFanout', () => {
  const review = freezeFanout({
    type: 'steer',
    payload: { body: 'stop and summarize' },
    summary: '',
    targets: fanoutCandidates(clients, sessions),
  });

  it('sends one request per session, with that session in the payload', async () => {
    const sent: unknown[] = [];
    const outcomes = new Map<string, FanoutOutcome>();
    await runFanout(
      review,
      async (clientId, type, payload) => {
        sent.push({ clientId, type, payload });
        return { commandId: `cmd-${clientId}` };
      },
      () => true,
      (id, outcome) => outcomes.set(id, outcome),
    );
    expect(sent).toEqual([
      { clientId: 'a', type: 'steer', payload: { body: 'stop and summarize', sessionId: 's-a' } },
      { clientId: 'b', type: 'steer', payload: { body: 'stop and summarize', sessionId: 's-b' } },
    ]);
    expect(outcomes.get('s-b')).toEqual({ state: 'sent', commandId: 'cmd-b' });
  });

  it('skips a session that ended and never redirects its command', async () => {
    const sent: string[] = [];
    const outcomes = new Map<string, FanoutOutcome>();
    await runFanout(
      review,
      async (clientId) => {
        sent.push(clientId);
        return { commandId: 'x' };
      },
      (target) => target.sessionId !== 's-a',
      (id, outcome) => outcomes.set(id, outcome),
    );
    expect(sent).toEqual(['b']);
    expect(outcomes.get('s-a')?.state).toBe('skipped');
  });

  it('stops after an authorization refusal instead of repeating it', async () => {
    let calls = 0;
    const outcomes = new Map<string, FanoutOutcome>();
    await runFanout(
      review,
      async () => {
        calls += 1;
        // The request layer's real shape: the server text, the status beside it.
        throw new HqHttpError(403, 'token lacks control.enqueue capability');
      },
      () => true,
      (id, outcome) => outcomes.set(id, outcome),
    );
    expect(calls).toBe(1);
    expect(outcomes.get('s-a')?.state).toBe('failed');
    expect(outcomes.get('s-b')).toMatchObject({ state: 'skipped' });
  });

  it('keeps going after a per-target failure', async () => {
    const outcomes = new Map<string, FanoutOutcome>();
    await runFanout(
      review,
      async (clientId) => {
        if (clientId === 'a') throw new HqHttpError(404, 'client not connected');
        return { commandId: 'ok' };
      },
      () => true,
      (id, outcome) => outcomes.set(id, outcome),
    );
    expect(outcomes.get('s-a')?.state).toBe('failed');
    expect(outcomes.get('s-b')?.state).toBe('sent');
  });
});
