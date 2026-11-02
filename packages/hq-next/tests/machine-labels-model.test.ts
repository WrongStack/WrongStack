/**
 * Operator labels on machine cards: the snapshot's label map reaches live and
 * offline machines alike, the filter counts what is in use, and a stale
 * `?label=` link never empties the list.
 */
import type { HqSnapshot } from '@wrongstack/hq';
import { describe, expect, it } from 'vitest';
import { labelCounts, machineSummaries, machinesWithLabel } from '../src/features/machines/model';

const NOW = '2026-11-02T12:00:00.000Z';

const snapshot = {
  generatedAt: NOW,
  clients: [
    {
      clientId: 'c1',
      machineId: 'm1',
      hostname: 'LAB-02',
      projectId: 'p',
      connected: true,
      lastSeenAt: NOW,
    },
    {
      clientId: 'c2',
      machineId: 'm2',
      hostname: 'DESK',
      projectId: 'p',
      connected: true,
      lastSeenAt: NOW,
    },
  ],
  projects: [],
  sessions: [],
  fleets: [],
  mailboxes: [],
  offlineMachines: [
    {
      key: 'host:old-box',
      hostname: 'OLD-BOX',
      machineIds: ['m3'],
      projects: [],
      labels: ['lab'],
      firstSeenAt: NOW,
      lastSeenAt: NOW,
    },
  ],
  machineLabels: { 'host:lab-02': ['gpu', 'lab'], 'host:old-box': ['lab'] },
  totals: {},
} as unknown as HqSnapshot;

describe('machine labels', () => {
  const machines = machineSummaries(snapshot, []);
  const byHost = (host: string) => machines.find((machine) => machine.hostname === host);

  it('puts each machine its labels, live or remembered', () => {
    expect(byHost('LAB-02')?.labels).toEqual(['gpu', 'lab']);
    expect(byHost('OLD-BOX')?.labels).toEqual(['lab']);
    expect(byHost('DESK')?.labels).toEqual([]);
  });

  it('counts the labels in use, by name', () => {
    expect(labelCounts(machines)).toEqual([
      { label: 'gpu', count: 1 },
      { label: 'lab', count: 2 },
    ]);
  });

  it('filters by a label, and a label nobody carries filters nothing', () => {
    expect(
      machinesWithLabel(machines, 'lab')
        .map((machine) => machine.hostname)
        .sort(),
    ).toEqual(['LAB-02', 'OLD-BOX']);
    expect(machinesWithLabel(machines, null)).toHaveLength(3);
    expect(machinesWithLabel(machines, 'gone')).toHaveLength(3);
  });
});
