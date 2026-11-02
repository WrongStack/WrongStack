/**
 * Machine health in words: byte and uptime formatting, the server's verdict
 * put into words (the dashboard never judges with thresholds of its own), the
 * attention item it raises and the newest sample winning on the machine card.
 */
import type { HqSnapshot } from '@wrongstack/hq';
import { describe, expect, it } from 'vitest';
import { buildAttentionItems } from '../src/features/attention/model';
import {
  formatBytes,
  formatUptime,
  healthFacts,
  healthProblems,
  type MachineHealth,
  platformLabel,
} from '../src/features/machines/health';
import { machineSummaries } from '../src/features/machines/model';

const GIB = 1024 ** 3;
const NOW = Date.parse('2026-11-02T12:00:00.000Z');
const fresh = new Date(NOW - 30_000).toISOString();
const health = (over: Partial<MachineHealth> = {}): MachineHealth => ({
  platform: 'linux',
  arch: 'x64',
  cpuCount: 8,
  loadAvg1: 2,
  memTotalBytes: 16 * GIB,
  memAvailableBytes: 8 * GIB,
  osUptimeSec: 3 * 86_400 + 4 * 3600,
  diskTotalBytes: 500 * GIB,
  diskFreeBytes: 100 * GIB,
  processRssBytes: 300 * 1024 ** 2,
  reportedAt: fresh,
  ...over,
});

describe('formatting', () => {
  it('formats bytes and uptime for people', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1.5 * GIB)).toBe('1.5 GB');
    expect(formatBytes(500 * GIB)).toBe('500 GB');
    expect(formatBytes(-1)).toBe('—');
    expect(formatUptime(59 * 60)).toBe('59m');
    expect(formatUptime(5 * 3600 + 120)).toBe('5h 2m');
    expect(formatUptime(3 * 86_400 + 4 * 3600)).toBe('3d 4h');
    expect(platformLabel(health({ platform: 'win32' }))).toBe('Windows · x64');
  });
});

describe('healthProblems', () => {
  it('says nothing without a verdict, whatever the numbers look like', () => {
    expect(healthProblems(health({ diskFreeBytes: 0, memAvailableBytes: 0 }), undefined)).toEqual(
      [],
    );
    expect(healthProblems(undefined, ['disk'])).toEqual([]);
  });

  it('puts the server verdict into words from the reading', () => {
    expect(
      healthProblems(health({ diskTotalBytes: 20 * GIB, diskFreeBytes: 1.5 * GIB }), ['disk'])[0]
        ?.summary,
    ).toBe('low on disk space (1.5 GB free of 20 GB)');
    expect(
      healthProblems(health({ memAvailableBytes: 0.5 * GIB }), ['memory']).map((p) => p.summary),
    ).toEqual(['short of memory (512 MB available of 16 GB)']);
  });

  it('skips a disk verdict when the reading has no disk', () => {
    expect(
      healthProblems(health({ diskTotalBytes: undefined, diskFreeBytes: undefined }), ['disk']),
    ).toEqual([]);
  });
});

describe('healthFacts', () => {
  it('lists memory, disk, CPU, uptime and the process, with meters', () => {
    const facts = healthFacts(health({ diskFreeBytes: 1 * GIB }), ['disk']);
    expect(facts.map((fact) => fact.label)).toEqual([
      'Memory in use',
      'Project disk',
      'CPU',
      'Up for',
      'WrongStack process',
    ]);
    expect(facts[0]).toMatchObject({ value: '8 GB of 16 GB', used: 0.5, warn: false });
    expect(facts[1]).toMatchObject({ value: '1 GB free of 500 GB', warn: true });
    expect(facts[2]).toMatchObject({ value: 'load 2.00 on 8 cores', used: 0.25 });
  });

  it('says cores only where the OS has no load average', () => {
    const cpu = healthFacts(health({ loadAvg1: undefined }), undefined).find(
      (f) => f.label === 'CPU',
    );
    expect(cpu).toEqual({ label: 'CPU', value: '8 cores' });
  });
});

const snapshotWith = (machines: unknown[]): HqSnapshot =>
  ({
    generatedAt: new Date(NOW).toISOString(),
    clients: [
      {
        clientId: 'c1',
        machineId: 'm1',
        hostname: 'LAB-02',
        projectId: 'p',
        connected: true,
        lastSeenAt: fresh,
      },
    ],
    projects: [],
    sessions: [],
    fleets: [],
    mailboxes: [],
    machines,
    totals: {},
  }) as unknown as HqSnapshot;

describe('attention and machine cards', () => {
  it('raises one host item per problem on a live machine', () => {
    const snapshot = snapshotWith([
      {
        machineId: 'm1',
        hostname: 'LAB-02',
        projectIds: ['p'],
        lastActivityAt: fresh,
        health: health({ diskFreeBytes: 1 * GIB, memAvailableBytes: 0.1 * GIB }),
        healthProblems: ['disk', 'memory'],
      },
      {
        // Looks low, but the operator's thresholds say it is fine.
        machineId: 'm2',
        hostname: 'QUIET',
        projectIds: ['p'],
        lastActivityAt: fresh,
        health: health({ diskFreeBytes: 0 }),
      },
    ]);
    const items = buildAttentionItems({
      snapshot,
      approvals: [],
      questions: [],
      alerts: [],
      commands: [],
    } as unknown as Parameters<typeof buildAttentionItems>[0]).filter((i) => i.kind === 'host');
    expect(items.map((item) => item.id)).toEqual([
      'host-disk:host:lab-02',
      'host-memory:host:lab-02',
    ]);
    expect(items[0]?.title).toBe('LAB-02 is low on disk space (1 GB free of 500 GB)');
    expect(items[0]?.href).toBe('/fleet/machines/?machine=host%3Alab-02');
    expect(items[0]?.origin).toEqual({ machineKey: 'host:lab-02' });
  });

  it('puts the newest sample on the machine card', () => {
    const older = new Date(NOW - 60_000).toISOString();
    const snapshot = snapshotWith([
      {
        machineId: 'm1',
        hostname: 'LAB-02',
        projectIds: [],
        lastActivityAt: fresh,
        health: health({ reportedAt: older, diskFreeBytes: 1 }),
        healthProblems: ['disk'],
      },
      {
        machineId: 'm1b',
        hostname: 'lab-02',
        projectIds: [],
        lastActivityAt: fresh,
        health: health(),
      },
    ]);
    const [card] = machineSummaries(snapshot, []);
    expect(card?.health?.reportedAt).toBe(fresh);
    expect(card?.health?.diskFreeBytes).toBe(100 * GIB);
    // The verdict travels with its own sample, not with an older one.
    expect(card?.healthProblems).toBeUndefined();
  });
});
