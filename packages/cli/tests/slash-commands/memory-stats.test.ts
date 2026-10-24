import type { MemoryEntry } from '@wrongstack/contracts/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runStats } from '../../src/slash-commands/memory-stats.js';

const NOW = Date.parse('2026-09-13T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

function entry(overrides: Partial<MemoryEntry> & { ageDays?: number } = {}): MemoryEntry {
  const { ageDays = 0.5, ...rest } = overrides;
  return {
    scope: 'project-memory',
    text: 'x',
    ts: new Date(NOW - ageDays * DAY).toISOString(),
    ...rest,
  };
}

function ctx(entries: MemoryEntry[], raw = 'raw') {
  return {
    memoryStore: {
      list: vi.fn(async () => entries),
      read: vi.fn(async () => raw),
    },
  } as never;
}

async function stats(entries: MemoryEntry[], raw?: string): Promise<string> {
  return (await runStats(ctx(entries, raw))).message;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('runStats', () => {
  it('reports a missing store and an empty store', async () => {
    expect((await runStats({} as never)).message).toBe('No memory store configured.');
    expect(await stats([])).toContain('Memory is empty');
  });

  it('counts every type, including types outside the canonical order', async () => {
    const out = await stats([
      entry({ type: 'fact' }),
      entry({ type: 'fact' }),
      entry({ type: 'decision' }),
      entry({ type: 'workflow' as never }),
      entry({ type: 'zeta' as never }),
      entry(),
    ]);
    const typeLines = out.split('\n### By Type\n')[1]!.split('\n\n')[0]!.split('\n');
    expect(typeLines).toEqual([
      '- `decision` █ 1',
      '- `fact` ██ 2',
      '- `workflow` █ 1',
      '- `zeta` █ 1',
      '- `untyped` █ 1',
    ]);
    const sum = typeLines.reduce((acc, line) => acc + Number(line.split(' ').pop()), 0);
    expect(sum).toBe(6);
  });

  it('caps the type bar at 20 blocks', async () => {
    const out = await stats(Array.from({ length: 25 }, () => entry({ type: 'fact' })));
    expect(out).toContain(`- \`fact\` ${'█'.repeat(20)} 25`);
  });

  it('sorts priorities by count and uses the unset bucket', async () => {
    const out = await stats([
      entry({ priority: 'low' }),
      entry({ priority: 'critical' }),
      entry({ priority: 'critical' }),
      entry(),
      entry(),
      entry(),
    ]);
    const section = out.split('### By Priority\n')[1]!.split('\n\n')[0];
    expect(section).toBe(['- · `unset`: 3', '- ⚡ `critical`: 2', '- ○ `low`: 1'].join('\n'));
  });

  it('buckets ages at the 1/7/30 day boundaries and always shows <7d', async () => {
    const out = await stats([
      entry({ ageDays: 0 }),
      entry({ ageDays: 1 }),
      entry({ ageDays: 6.9 }),
      entry({ ageDays: 7 }),
      entry({ ageDays: 30 }),
      entry({ ageDays: -2 }), // clock skew: future timestamp counts as fresh
    ]);
    const section = out.split('### By Age\n')[1]!.split('\n\n')[0];
    expect(section).toBe(['- <1d: 2', '- <7d: 2', '- <30d: 1', '- >30d: 1'].join('\n'));

    const onlyOld = await stats([entry({ ageDays: 40 })]);
    expect(onlyOld.split('### By Age\n')[1]!.split('\n\n')[0]).toBe(
      ['- <7d: 0', '- >30d: 1'].join('\n'),
    );
  });

  it('treats an unparseable timestamp as older than 30 days', async () => {
    const out = await stats([{ scope: 'project-memory', text: 'x', ts: 'not-a-date' }]);
    expect(out).toContain('- >30d: 1');
  });

  it('lists at most 10 tags ordered by frequency', async () => {
    const entries = Array.from({ length: 12 }, (_, i) =>
      entry({ tags: [`t${i}`, ...(i < 2 ? ['hot'] : [])] }),
    );
    const out = await stats(entries);
    const tagLines = out.split('### Top Tags\n')[1]!.split('\n\n')[0]!.split('\n');
    expect(tagLines).toHaveLength(10);
    expect(tagLines[0]).toBe('- `#hot`: 2');
  });

  it('omits the tag section when no entry has tags', async () => {
    expect(await stats([entry({ tags: [] })])).not.toContain('### Top Tags');
  });

  it('reports healthy state when everything is typed, prioritized and small', async () => {
    const out = await stats([entry({ type: 'fact', priority: 'high' })], 'tiny');
    expect(out).toContain('- ✅ All entries have types');
    expect(out).toContain('- ✅ All entries have priorities');
    expect(out).toContain('- ✅ Storage 0% full — healthy');
    expect(out).not.toContain('older than 30 days');
  });

  it('distinguishes majority-missing from some-missing metadata', async () => {
    const majority = await stats([entry(), entry(), entry({ type: 'fact', priority: 'low' })]);
    expect(majority).toContain('- ⚠️ 2/3 entries have no type');
    expect(majority).toContain('- ⚠️ 2/3 entries have no priority');

    // Exactly half is not a majority.
    const half = await stats([entry(), entry({ type: 'fact', priority: 'low' })]);
    expect(half).toContain('- ℹ️ 1 entries untyped');
    expect(half).toContain('- ℹ️ 1 entries have no priority set');
  });

  it('warns about stale entries only above five and about storage above 80%', async () => {
    const six = Array.from({ length: 6 }, () =>
      entry({ ageDays: 45, type: 'fact', priority: 'low' }),
    );
    expect(await stats(six)).toContain('- ⚠️ 6 entries older than 30 days');
    expect(await stats(six.slice(0, 5))).not.toContain('older than 30 days');

    const full = await stats([entry({ type: 'fact', priority: 'low' })], 'a'.repeat(25_921));
    expect(full).toContain('- ⚠️ Storage 81% full');
    // Size is measured in UTF-8 bytes, not string length.
    const multibyte = await stats([entry({ type: 'fact', priority: 'low' })], 'é'.repeat(8_000));
    expect(multibyte).toContain('**Total:** 1 entries · 15.6 KB / 31.3 KB (50%)');
  });
});
