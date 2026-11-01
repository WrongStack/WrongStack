import type { HqSessionHistoryEntry } from '@wrongstack/hq';
import { describe, expect, it } from 'vitest';
import {
  groupByDay,
  historyCsv,
  sessionDuration,
  summarizeHistory,
} from '../src/features/telemetry/session-history-model';

const entry = (over: Partial<HqSessionHistoryEntry>): HqSessionHistoryEntry => ({
  sessionId: 's',
  projectId: 'p',
  projectName: 'P',
  machineKey: 'host:lab',
  clientKind: 'tui',
  startedAt: '2026-11-01T10:00:00.000Z',
  lastActivityAt: '2026-11-01T10:00:00.000Z',
  endedAt: '2026-11-01T12:00:00.000Z',
  outcome: 'ended',
  lastStatus: 'idle',
  costUsd: 0,
  tokensIn: 0,
  tokensOut: 0,
  toolCalls: 0,
  agents: 1,
  models: [],
  ...over,
});

describe('session history model', () => {
  it('sums cost and tool calls and counts lost sessions', () => {
    expect(
      summarizeHistory([
        entry({ costUsd: 1.5, toolCalls: 4 }),
        entry({ costUsd: Number.NaN, toolCalls: 2, outcome: 'lost' }),
      ]),
    ).toEqual({ count: 2, costUsd: 1.5, toolCalls: 6, lost: 1 });
  });

  it('says how long a session ran', () => {
    const at = (iso: string) => entry({ lastActivityAt: iso });
    expect(sessionDuration(at('2026-11-01T10:00:42.000Z'))).toBe('42s');
    expect(sessionDuration(at('2026-11-01T10:12:00.000Z'))).toBe('12m');
    expect(sessionDuration(at('2026-11-01T13:05:00.000Z'))).toBe('3h 05m');
    expect(sessionDuration(at('2026-11-04T14:00:00.000Z'))).toBe('3d 4h');
    expect(sessionDuration(at('2026-11-01T09:00:00.000Z'))).toBe('—');
  });

  it('groups consecutive entries by the day they ended', () => {
    const groups = groupByDay([
      entry({ sessionId: 'a', endedAt: '2026-11-02T09:00:00.000Z' }),
      entry({ sessionId: 'b', endedAt: '2026-11-02T08:00:00.000Z' }),
      entry({ sessionId: 'c', endedAt: '2026-11-01T08:00:00.000Z' }),
    ]);
    expect(groups.map((group) => group.entries.map((e) => e.sessionId))).toEqual([
      ['a', 'b'],
      ['c'],
    ]);
  });
});

describe('history CSV', () => {
  it('writes one row per session and defuses spreadsheet formulas in client text', () => {
    const csv = historyCsv([
      entry({
        projectName: '=HYPERLINK("https://evil.example","x")',
        costUsd: 1.23456,
        models: ['a', 'b'],
      }),
      entry({ projectName: 'Data, pipe', hostname: '-LAB' }),
    ]);
    const [header, first, second] = csv.trimEnd().split('\r\n');
    expect(header?.startsWith('ended_at,started_at,')).toBe(true);
    expect(first).toContain(`"'=HYPERLINK(""https://evil.example"",""x"")"`);
    expect(first).toContain('1.2346');
    expect(first).toContain('a b');
    expect(second).toContain('"Data, pipe"');
    expect(second).toContain("'-LAB");
  });
});
