import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CompactionSummaryCache,
  compactionSummaryKey,
  defaultCompactionSummaryCache,
} from '../../src/execution/compaction-summary-cache.js';
import type { Message } from '../../src/types/messages.js';

describe('CompactionSummaryCache', () => {
  beforeEach(() => {
    // Process-wide singleton hygiene: every test starts without retained summaries.
    defaultCompactionSummaryCache.clear();
  });

  it('exports a shared process-local cache that deduplicates concurrent calls', async () => {
    let resolve!: (value: string) => void;
    const create = vi.fn(
      () =>
        new Promise<string>((done) => {
          resolve = done;
        }),
    );
    const first = defaultCompactionSummaryCache.getOrCreate('shared-test-key', create);
    const second = defaultCompactionSummaryCache.getOrCreate('shared-test-key', create);
    resolve('shared summary');

    await expect(first).resolves.toBe('shared summary');
    await expect(second).resolves.toBe('shared summary');
    await expect(
      defaultCompactionSummaryCache.getOrCreate('shared-test-key', async () => 'recomputed'),
    ).resolves.toBe('shared summary');
    expect(create).toHaveBeenCalledOnce();
  });

  it('reuses a successful summary and deduplicates concurrent calls', async () => {
    const cache = new CompactionSummaryCache({ capacity: 2 });
    let resolve!: (value: string) => void;
    const create = vi.fn(
      () =>
        new Promise<string>((done) => {
          resolve = done;
        }),
    );

    const first = cache.getOrCreate('same', create);
    const second = cache.getOrCreate('same', create);
    resolve('compact result');

    await expect(first).resolves.toBe('compact result');
    await expect(second).resolves.toBe('compact result');
    await expect(cache.getOrCreate('same', create)).resolves.toBe('compact result');
    expect(create).toHaveBeenCalledOnce();
  });

  it('clears a rejected creator before rejection observers retry', async () => {
    const cache = new CompactionSummaryCache();
    const create = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('nope'))
      .mockResolvedValueOnce('recovered');

    await expect(
      cache.getOrCreate('retry', create).catch(() => cache.getOrCreate('retry', create)),
    ).resolves.toBe('recovered');
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('does not cache empty or placeholder summaries', async () => {
    for (const placeholder of ['', '   ', '(empty)', '  (empty)  ', '(empty summary)']) {
      const cache = new CompactionSummaryCache();
      await expect(cache.getOrCreate('skip', async () => placeholder)).resolves.toBe(placeholder);
      expect(cache.get('skip')).toBeUndefined();
      await expect(cache.getOrCreate('skip', async () => 'real summary')).resolves.toBe(
        'real summary',
      );
    }
  });

  it('normalizes successful summaries before caching them', async () => {
    const cache = new CompactionSummaryCache();
    await expect(cache.getOrCreate('formatted', async () => '  summary\n')).resolves.toBe(
      '  summary\n',
    );
    expect(cache.get('formatted')).toBe('summary');
    await expect(cache.getOrCreate('formatted', async () => 'recomputed')).resolves.toBe('summary');
  });

  it('does not let a creator that predates clear repopulate the cache', async () => {
    const cache = new CompactionSummaryCache();
    let resolve!: (value: string) => void;
    const pending = cache.getOrCreate(
      'stale',
      () =>
        new Promise<string>((done) => {
          resolve = done;
        }),
    );

    cache.clear();
    resolve('late summary');

    await expect(pending).resolves.toBe('late summary');
    expect(cache.get('stale')).toBeUndefined();
  });

  it('rejects capacities that cannot enforce an integer entry bound', () => {
    for (const capacity of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new CompactionSummaryCache({ capacity })).toThrow(
        /capacity must be a positive integer/,
      );
    }
  });

  it('rejects non-positive or non-finite ttlMs values', () => {
    expect(() => new CompactionSummaryCache({ ttlMs: 0 })).toThrow(
      'CompactionSummaryCache ttlMs must be finite and > 0, got 0',
    );
    expect(() => new CompactionSummaryCache({ ttlMs: Number.NaN })).toThrow(/ttlMs/);
  });

  it('keys semantic message content without transient token estimates', () => {
    const a: Message[] = [{ role: 'user', content: 'same', _estTokens: 10 }];
    const b: Message[] = [{ role: 'user', content: 'same', _estTokens: 999 }];
    expect(compactionSummaryKey('m', 'p', a)).toBe(compactionSummaryKey('m', 'p', b));
    expect(compactionSummaryKey('m', 'p', a)).not.toBe(compactionSummaryKey('other-model', 'p', b));
  });

  it('ignores transient content-block fields while preserving semantic input changes', () => {
    const baseBlock = { type: 'tool_use' as const, id: 'call-1', name: 'read' };
    const a: Message[] = [
      {
        role: 'assistant',
        content: [
          {
            ...baseBlock,
            input: { path: 'src/a.ts' },
            providerMeta: { 'google.thoughtSignature': 'sig-a' },
          },
        ],
      },
    ];
    const b: Message[] = [
      {
        role: 'assistant',
        content: [
          {
            ...baseBlock,
            input: { path: 'src/a.ts' },
            providerMeta: { 'google.thoughtSignature': 'sig-b' },
          },
        ],
      },
    ];
    const changed: Message[] = [
      {
        role: 'assistant',
        content: [
          {
            ...baseBlock,
            input: { path: 'src/b.ts' },
            providerMeta: { 'google.thoughtSignature': 'sig-a' },
          },
        ],
      },
    ];

    expect(compactionSummaryKey('m', 'p', a)).toBe(compactionSummaryKey('m', 'p', b));
    expect(compactionSummaryKey('m', 'p', a)).not.toBe(compactionSummaryKey('m', 'p', changed));
  });
});
