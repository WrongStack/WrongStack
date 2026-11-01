/**
 * Machine health in words: byte and uptime formatting, the low-disk and
 * low-memory thresholds, staleness, the attention item it raises and the
 * newest sample winning on the machine card.
 */
import type { HqSnapshot } from '@wrongstack/hq';
import { hqHostHealthProblems } from '@wrongstack/hq';
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
  it('is quiet for a healthy machine', () => {
    expect(healthProblems(health(), NOW)).toEqual([]);
    expect(healthProblems(undefined, NOW)).toEqual([]);
  });

  it('flags a disk under 5% free or under 2 GB free', () => {
    expect(healthProblems(health({ diskFreeBytes: 20 * GIB }), NOW).map((p) => p.kind)).toEqual([
      'disk',
    ]);
    // 1.5 GB of a 20 GB volume is 7.5%, still under the 2 GB floor.
    expect(
      healthProblems(health({ diskTotalBytes: 20 * GIB, diskFreeBytes: 1.5 * GIB }), NOW)[0]
        ?.summary,
    ).toBe('low on disk space (1.5 GB free of 20 GB)');
    // No disk reading: no disk verdict.
    expect(
      healthProblems(health({ diskTotalBytes: undefined, diskFreeBytes: undefined }), NOW),
    ).toEqual([]);
  });

  it('flags memory under 5% available', () => {
    expect(
      healthProblems(health({ memAvailableBytes: 0.5 * GIB }), NOW).map((p) => p.kind),
    ).toEqual(['memory']);
  });

  it('raises nothing from a stale reading', () => {
    const stale = new Date(NOW - 6 * 60_000).toISOString();
    expect(healthProblems(health({ diskFreeBytes: 0, reportedAt: stale }), NOW)).toEqual([]);
  });
});

describe('healthFacts', () => {
  it('lists memory, disk, CPU, uptime and the process, with meters', () => {
    const facts = healthFacts(health({ diskFreeBytes: 1 * GIB }), NOW);
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
    const cpu = healthFacts(health({ loadAvg1: undefined }), NOW).find((f) => f.label === 'CPU');
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
  });
});

describe('parity with the server verdict', () => {
  it('flags exactly what the server notifies about', () => {
    const grid: MachineHealth[] = [];
    for (const diskFree of [0, 1 * GIB, 1.99 * GIB, 2.01 * GIB, 24 * GIB, 26 * GIB, 400 * GIB]) {
      for (const memAvailable of [0, 0.79 * GIB, 0.81 * GIB, 8 * GIB]) {
        for (const age of [0, 4 * 60_000, 6 * 60_000]) {
          grid.push(
            health({
              diskFreeBytes: diskFree,
              memAvailableBytes: memAvailable,
              reportedAt: new Date(NOW - age).toISOString(),
            }),
          );
        }
      }
    }
    for (const sample of grid) {
      expect(healthProblems(sample, NOW).map((problem) => problem.kind)).toEqual(
        hqHostHealthProblems(sample, NOW),
      );
    }
  });
});
