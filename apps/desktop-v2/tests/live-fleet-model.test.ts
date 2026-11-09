import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { fleetMailboxAddress, fleetNodeId, projectFleet } from '../src/live-fleet-model';

const session = {
  sessionId: '2026-10-28/sess_a',
  projectRoot: 'D:\\Project Alpha',
  status: 'idle',
  pid: 12,
  startedAt: '2026-10-28T00:00:00Z',
  lastHeartbeatAt: '2026-10-28T00:01:00Z',
  agents: [{ id: 'leader', name: 'Leader', status: 'idle', iterations: 2, toolCalls: 3 }],
};
it('preserves the external agent identity for graph, list and detail badges', () => {
  const [result] = projectFleet(
    [{ ...session, agents: [{ ...session.agents[0], provider: 'acp', model: 'pi-acp' }] }],
    session.projectRoot,
    '',
  );
  expect(result?.agents[0]).toMatchObject({ provider: 'acp', model: 'pi-acp' });
  expect(projectFleet([session], session.projectRoot, '')[0]?.agents[0]).not.toHaveProperty(
    'provider',
  );
});
it('uses exact normalized project ownership and excludes the private service carrier', () => {
  const rows = projectFleet(
    [
      session,
      { ...session, sessionId: 'carrier' },
      { ...session, projectRoot: 'D:\\Project Alpha Other' },
    ],
    '\\\\?\\D:\\Project Alpha\\',
    'carrier',
  );
  expect(rows.map((row) => row.sessionId)).toEqual([session.sessionId]);
  expect(rows[0]?.agents[0]?.toolCalls).toBe(3);
  expect(fleetNodeId('a:b', 'c')).not.toBe(fleetNodeId('a', 'b:c'));
});
it('refuses invalid owned metadata instead of creating graph nodes from it', () => {
  expect(() => projectFleet({}, session.projectRoot, '')).toThrow('catalog');
  expect(() => projectFleet([{ ...session, pid: NaN }], session.projectRoot, '')).toThrow(
    'identity',
  );
  expect(() =>
    projectFleet(
      [{ ...session, agents: [{ ...session.agents[0], iterations: NaN }] }],
      session.projectRoot,
      '',
    ),
  ).toThrow('counters');
});
it('matches the canonical mailbox session tag without loading server code into the renderer', async () => {
  expect(await fleetMailboxAddress(session.sessionId)).toBe(
    `leader@${createHash('sha256').update(session.sessionId).digest('hex').slice(0, 8)}`,
  );
});

it('rejects duplicate graph identities and malformed catalog records', () => {
  for (const rows of [
    [session, session],
    [null],
    [{ ...session, pid: -1 }],
    [{ ...session, agents: [session.agents[0], session.agents[0]] }],
    [{ ...session, agents: [{ ...session.agents[0], iterations: -1 }] }],
  ]) {
    expect(() => projectFleet(rows, session.projectRoot, '')).toThrow();
  }
});
