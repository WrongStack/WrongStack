/**
 * Machine summaries: what runs on each box, how its releases compare to the
 * hub, and which queue items belong to it.
 */
import type { HqSnapshot } from '@wrongstack/hq';
import { describe, expect, it } from 'vitest';
import type { AttentionItem } from '../src/features/attention/model';
import { machineSentence, machineSummaries } from '../src/features/machines/model';
import { scopeSnapshot } from '../src/lib/scope';

const T = '2026-11-01T12:00:00.000Z';
const snapshot = {
  hqVersion: '1.3.0',
  clients: [
    {
      clientId: 'c1',
      kind: 'tui',
      machineId: 'm1',
      hostname: 'desk',
      projectId: 'alpha',
      connected: true,
      version: '1.3.0',
      lastSeenAt: T,
      pid: 10,
    },
    {
      clientId: 'c2',
      kind: 'cli',
      machineId: 'm2',
      hostname: 'lab',
      projectId: 'beta',
      connected: true,
      version: '1.2.0',
      lastSeenAt: T,
    },
    {
      clientId: 'c3',
      kind: 'tui',
      machineId: 'm3',
      hostname: 'old',
      projectId: 'beta',
      connected: false,
      lastSeenAt: '2026-11-01T10:00:00.000Z',
    },
  ],
  projects: [
    { projectId: 'alpha', projectName: 'Alpha', machineIds: ['m1'] },
    { projectId: 'beta', projectName: 'Beta', machineIds: ['m2', 'm3'] },
  ],
  machines: [],
  sessions: [
    { sessionId: 's1', clientId: 'c1', projectId: 'alpha', costUsd: 1.25 },
    { sessionId: 's2', clientId: 'c2', projectId: 'beta', costUsd: 0.5 },
  ],
  liveSessions: [
    {
      sessionId: 's1',
      machineId: 'm1',
      projectId: 'alpha',
      agents: [{ status: 'running' }, { status: 'idle' }],
    },
  ],
  mcpServers: [
    { name: 'db', clientId: 'c2', projectId: 'beta', healthState: 'failed' },
    { name: 'gh', clientId: 'c2', projectId: 'beta', healthState: 'healthy' },
  ],
  fleets: [],
  mailboxes: [],
  totals: {},
} as unknown as HqSnapshot;

const item = (id: string, origin: AttentionItem['origin']): AttentionItem =>
  ({
    id,
    kind: 'mcp',
    tone: 'warning',
    title: id,
    context: '',
    at: T,
    href: '/',
    action: '',
    sourceId: id,
    origin,
  }) as AttentionItem;

describe('machineSummaries', () => {
  const machines = machineSummaries(snapshot, [
    item('lab-mcp', { clientId: 'c2', projectId: 'beta' }),
    item('fleet-wide', undefined),
  ]);

  it('puts the machine that needs a person first and offline machines last', () => {
    expect(machines.map((machine) => machine.hostname)).toEqual(['lab', 'desk', 'old']);
    expect(machines[0]?.attention.map((entry) => entry.id)).toEqual(['lab-mcp']);
  });

  it('folds clients, releases, sessions, spend and MCP per machine', () => {
    const lab = machines[0];
    expect(lab).toMatchObject({ online: true, costUsd: 0.5, mcpTotal: 2, mcpFailing: 1 });
    expect(lab?.clients[0]).toMatchObject({
      version: '1.2.0',
      drift: 'behind',
      projectName: 'Beta',
    });
    const desk = machines[1];
    expect(desk).toMatchObject({ sessions: 1, agents: 2, working: 1, costUsd: 1.25 });
    expect(desk?.clients[0]?.drift).toBe('same');
    expect(machines[2]?.clients[0]?.drift).toBe('unknown');
  });

  it('keys each card by hostname and lists only items provably on it', () => {
    expect(machines.map((machine) => machine.key)).toEqual(['host:lab', 'host:desk', 'host:old']);
    // A client that is gone from the snapshot cannot be placed on any card.
    const strict = machineSummaries(snapshot, [item('orphan', { clientId: 'gone' })]);
    expect(strict.flatMap((machine) => machine.attention)).toEqual([]);
  });

  it('folds processes that report different ids on one host into one machine', () => {
    const merged = machineSummaries(
      {
        ...snapshot,
        clients: [
          ...snapshot.clients,
          {
            clientId: 'c4',
            kind: 'cli',
            machineId: 'm1-legacy',
            hostname: 'Desk',
            projectId: 'beta',
            connected: true,
            lastSeenAt: T,
          },
        ],
      } as unknown as HqSnapshot,
      [],
    );
    const desk = merged.find((machine) => machine.key === 'host:desk');
    expect(merged).toHaveLength(3);
    expect(desk?.machineIds).toEqual(['m1', 'm1-legacy']);
    expect(desk?.clients.map((client) => client.clientId)).toEqual(['c1', 'c4']);
    expect(desk?.projects.map((project) => project.projectId)).toEqual(['alpha', 'beta']);
  });

  it('says what each machine is doing', () => {
    expect(machineSentence(machines[1]!)).toBe('1 of 2 agents working');
    expect(machineSentence(machines[0]!)).toBe('Connected, no session open');
    expect(machineSentence(machines[2]!)).toBe('Offline');
  });

  describe('machines HQ only remembers', () => {
    const remembered = {
      ...snapshot,
      offlineMachines: [
        {
          key: 'host:retired',
          hostname: 'RETIRED',
          machineIds: ['m9'],
          projects: [{ projectId: 'gamma', projectName: 'Gamma' }],
          lastVersion: 'v1.1.0',
          firstSeenAt: '2026-10-01T00:00:00.000Z',
          lastSeenAt: '2026-11-01T11:00:00.000Z',
        },
        {
          key: 'host:lab',
          hostname: 'lab',
          machineIds: ['m2'],
          projects: [],
          firstSeenAt: '2026-10-01T00:00:00.000Z',
          lastSeenAt: '2026-10-30T00:00:00.000Z',
        },
      ],
    } as unknown as HqSnapshot;

    it('lists an offline machine from the roster after the live ones, newest seen first', () => {
      const list = machineSummaries(remembered, []);
      // `lab` is connected, so the roster entry for it is not a second card.
      expect(list.map((machine) => machine.key)).toEqual([
        'host:desk',
        'host:lab',
        'host:retired',
        'host:old',
      ]);
      expect(list.find((machine) => machine.key === 'host:retired')).toMatchObject({
        hostname: 'RETIRED',
        online: false,
        remembered: true,
        lastVersion: '1.1.0',
        clients: [],
        projects: [{ projectId: 'gamma', projectName: 'Gamma' }],
      });
      expect(list.filter((machine) => machine.remembered)).toHaveLength(1);
    });

    it('keeps a remembered machine in a project scope only when that project ran there', () => {
      const gamma = scopeSnapshot(remembered, { kind: 'project', id: 'gamma' });
      expect(gamma?.offlineMachines?.map((machine) => machine.key)).toEqual(['host:retired']);
      const alpha = scopeSnapshot(remembered, { kind: 'project', id: 'alpha' });
      expect(alpha?.offlineMachines).toEqual([]);
    });
  });
});
