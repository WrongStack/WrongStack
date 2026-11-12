import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HqMachineRoster,
  hqMachineKey,
  parseHqMachineLabels,
} from '../src/persistence/machine-roster.js';
import type { HqClientRecord, HqSnapshot } from '../src/protocol.js';

const T0 = Date.parse('2026-11-01T10:00:00.000Z');

function client(over: Partial<HqClientRecord> & { clientId: string }): HqClientRecord {
  return {
    kind: 'cli',
    projectId: 'p1',
    projectRootDisplay: '/w/p1',
    machineId: 'm1',
    connected: true,
    connectedAt: new Date(T0).toISOString(),
    lastSeenAt: new Date(T0).toISOString(),
    capabilities: [],
    ...over,
  } as HqClientRecord;
}

function snapshot(at: number, clients: HqClientRecord[]): HqSnapshot {
  return {
    generatedAt: new Date(at).toISOString(),
    clients,
    projects: [
      {
        projectId: 'p1',
        projectName: 'Alpha',
        projectRootDisplay: '/w/p1',
        machineIds: [],
        activeClients: 0,
        activeSessions: 0,
        activeSubagents: 0,
        totalCostUsd: 0,
        lastActivityAt: new Date(at).toISOString(),
        status: 'active',
      },
    ],
    sessions: [],
    fleets: [],
    mailboxes: [],
    totals: {
      activeProjects: 1,
      activeClients: clients.length,
      activeSessions: 0,
      activeSubagents: 0,
      unreadMailboxMessages: 0,
      incompleteMailboxMessages: 0,
      totalCostUsd: 0,
    },
  } as HqSnapshot;
}

describe('HqMachineRoster', () => {
  let dataDir: string;
  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-roster-'));
  });
  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('remembers a machine after its clients disconnect', () => {
    const roster = new HqMachineRoster({ dataDir });
    roster.observe(
      snapshot(T0, [client({ clientId: 'a', hostname: 'LAB-02', version: '1.2.0' })]),
      T0,
    );
    expect(roster.offline(T0)).toEqual([]);
    expect(roster.isLive('host:lab-02')).toBe(true);

    roster.observe(snapshot(T0 + 60_000, []), T0 + 60_000);
    const [gone] = roster.offline(T0 + 60_000);
    expect(gone).toMatchObject({
      key: 'host:lab-02',
      hostname: 'LAB-02',
      machineIds: ['m1'],
      projects: [{ projectId: 'p1', projectName: 'Alpha' }],
      lastVersion: '1.2.0',
      lastSeenAt: new Date(T0).toISOString(),
    });
  });

  it('folds processes with different ids on one hostname into one machine', () => {
    const roster = new HqMachineRoster({ dataDir });
    roster.observe(
      snapshot(T0, [
        client({ clientId: 'a', hostname: 'Desk', machineId: 'm1' }),
        client({ clientId: 'b', hostname: 'desk', machineId: 'm1-legacy' }),
      ]),
      T0,
    );
    roster.observe(snapshot(T0 + 1, []), T0 + 1);
    const offline = roster.offline(T0 + 1);
    expect(offline).toHaveLength(1);
    expect(offline[0]?.machineIds).toEqual(['m1', 'm1-legacy']);
  });

  it('refuses to forget a connected machine and forgets an offline one', async () => {
    const roster = new HqMachineRoster({ dataDir });
    roster.observe(snapshot(T0, [client({ clientId: 'a', hostname: 'lab' })]), T0);
    expect(roster.forget('host:lab', T0)).toBe('live');
    roster.observe(snapshot(T0 + 1, []), T0 + 1);
    expect(roster.forget('host:lab', T0 + 1)).toBe('forgotten');
    expect(roster.forget('host:lab', T0 + 1)).toBe('unknown');
    expect(roster.offline(T0 + 1)).toEqual([]);
  });

  it('keeps operator labels across sightings, restarts and a clear', async () => {
    const first = new HqMachineRoster({ dataDir });
    first.observe(snapshot(T0, [client({ clientId: 'a', hostname: 'lab' })]), T0);
    expect(first.setLabels('host:lab', ['gpu', 'prod'], T0)).toBe('saved');
    expect(first.setLabels('host:nowhere', ['gpu'], T0)).toBe('unknown');
    // A later sighting from the client does not wipe what the operator set.
    first.observe(snapshot(T0 + 1, [client({ clientId: 'a', hostname: 'lab' })]), T0 + 1);
    expect(first.labelMap()).toEqual({ 'host:lab': ['gpu', 'prod'] });
    await first.drain();

    const second = new HqMachineRoster({ dataDir });
    await second.load(T0 + 5_000);
    expect(second.offline(T0 + 5_000)[0]?.labels).toEqual(['gpu', 'prod']);
    second.setLabels('host:lab', [], T0 + 5_000);
    expect(second.labelMap()).toEqual({});
    expect(second.offline(T0 + 5_000)[0]).not.toHaveProperty('labels');
  });

  it('accepts labels only in their stored form, and says no rather than dropping one', () => {
    expect(parseHqMachineLabels([' Prod ', 'gpu', 'prod', 'eu-west.1'])).toEqual([
      'eu-west.1',
      'gpu',
      'prod',
    ]);
    expect(parseHqMachineLabels([])).toEqual([]);
    expect(parseHqMachineLabels('prod')).toBeNull();
    expect(parseHqMachineLabels(['two words'])).toBeNull();
    expect(parseHqMachineLabels(['-dash-first'])).toBeNull();
    expect(parseHqMachineLabels(['a'.repeat(33)])).toBeNull();
    expect(parseHqMachineLabels([1])).toBeNull();
    expect(parseHqMachineLabels(Array.from({ length: 9 }, (_, i) => `l${i}`))).toBeNull();
  });

  it('survives a restart through machines.json', async () => {
    const first = new HqMachineRoster({ dataDir });
    first.observe(snapshot(T0, [client({ clientId: 'a', hostname: 'lab' })]), T0);
    await first.drain();

    const second = new HqMachineRoster({ dataDir });
    await second.load(T0 + 5_000);
    expect(second.offline(T0 + 5_000).map((entry) => entry.key)).toEqual(['host:lab']);
  });

  // The machine key is an IDENTITY, not a display string. `parseEntry()` used to
  // run it through the same MAX_TEXT (255) clip as the client-supplied fields,
  // while `observe()` persisted whatever `hqMachineKey()` derived. A hostname
  // long enough to push `host:<hostname>` past the bound (a legal 253-char FQDN
  // does) therefore came back from machines.json RENAMED, and since every
  // consumer re-derives the unbounded key — the snapshot grouping, the notify
  // label match, session history, hq-next's `machineKeyOf` — the next
  // observation missed its own previous entry and the truncated one, never in
  // `live`, was reported as an offline machine that is actually connected.
  it("keeps a long hostname's machine identity across a restart", async () => {
    const host = 'lab-node-01.internal.example.com'.repeat(8).slice(0, 300).toLowerCase();
    expect(`host:${host}`.length).toBeGreaterThan(255);
    const key = hqMachineKey(host, 'm1');

    const first = new HqMachineRoster({ dataDir });
    first.observe(snapshot(T0, [client({ clientId: 'a', hostname: host })]), T0);
    await first.drain();

    const second = new HqMachineRoster({ dataDir });
    await second.load(T0 + 5_000);
    expect(second.offline(T0 + 5_000).map((entry) => entry.key)).toEqual([key]);

    // The display bound the clip was written for still applies to that field.
    expect(second.offline(T0 + 5_000)[0]?.hostname).toHaveLength(255);

    // Same machine reporting again is live, not a second permanently-offline entry.
    second.observe(snapshot(T0 + 10_000, [client({ clientId: 'a', hostname: host })]), T0 + 10_000);
    expect(second.offline(T0 + 10_000)).toEqual([]);
    expect(second.isLive(key)).toBe(true);
  });

  it('drops machines unseen past the retention window', () => {
    const roster = new HqMachineRoster({ dataDir, retentionMs: 1_000 });
    roster.observe(snapshot(T0, [client({ clientId: 'a', hostname: 'old' })]), T0);
    roster.observe(snapshot(T0 + 500, []), T0 + 500);
    expect(roster.offline(T0 + 500)).toHaveLength(1);
    expect(roster.offline(T0 + 5_000)).toEqual([]);
  });

  it('caps the roster, evicting the longest-unseen offline machine', () => {
    const roster = new HqMachineRoster({ dataDir, maxMachines: 2 });
    for (const [i, host] of ['a', 'b', 'c'].entries()) {
      roster.observe(snapshot(T0 + i, [client({ clientId: host, hostname: host })]), T0 + i);
    }
    roster.observe(snapshot(T0 + 10, []), T0 + 10);
    expect(roster.offline(T0 + 10).map((entry) => entry.key)).toEqual(['host:c', 'host:b']);
  });

  it('ignores a corrupt or hostile machines.json', async () => {
    await fs.writeFile(
      path.join(dataDir, 'machines.json'),
      JSON.stringify({
        machines: [
          { key: '__proto__', firstSeenAt: 'x', lastSeenAt: 'y' },
          {
            key: 'host:ok',
            machineIds: ['m', 7],
            projects: [{ projectId: 'p' }, 'bad'],
            firstSeenAt: new Date(T0).toISOString(),
            lastSeenAt: new Date(T0).toISOString(),
            hostname: 'x'.repeat(5_000),
          },
        ],
      }),
    );
    const roster = new HqMachineRoster({ dataDir });
    await roster.load(T0);
    const [entry] = roster.offline(T0);
    expect(roster.offline(T0)).toHaveLength(1);
    expect(entry?.machineIds).toEqual(['m']);
    expect(entry?.projects).toEqual([{ projectId: 'p', projectName: 'p' }]);
    expect(entry?.hostname).toHaveLength(255);
  });

  it('a hostname-less record lands on the machine that shares its id', () => {
    const roster = new HqMachineRoster({ dataDir });
    const snap = snapshot(T0, [client({ clientId: 'a', hostname: 'lab', machineId: 'm9' })]);
    roster.observe(
      {
        ...snap,
        machines: [
          {
            machineId: 'm9',
            clientCount: 0,
            sessionCount: 1,
            agentCount: 1,
            projectIds: ['p1'],
            lastActivityAt: snap.generatedAt,
          },
        ],
      },
      T0,
    );
    roster.observe(snapshot(T0 + 1, []), T0 + 1);
    expect(roster.offline(T0 + 1).map((entry) => entry.key)).toEqual(['host:lab']);
  });
});

describe('HqMachineRoster load ordering', () => {
  it('never overwrites machines.json with what it saw before the load finished', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-roster-order-'));
    try {
      const first = new HqMachineRoster({ dataDir });
      first.observe(snapshot(T0, [client({ clientId: 'a', hostname: 'lab-02' })]), T0);
      first.observe(snapshot(T0 + 1, []), T0 + 1);
      await first.drain();

      // A restart: the first snapshot is built before load() resolves.
      const second = new HqMachineRoster({ dataDir });
      const loading = second.load(T0 + 2);
      second.observe(snapshot(T0 + 2, []), T0 + 2);
      await loading;
      await second.drain();

      const third = new HqMachineRoster({ dataDir });
      await third.load(T0 + 3);
      expect(third.offline(T0 + 3).map((entry) => entry.key)).toEqual(['host:lab-02']);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});
