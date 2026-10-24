import type { MemoryEntry } from '@wrongstack/contracts/types/memory';
import { describe, test } from 'vitest';
import { buildInvertedIndex, searchIndex } from '../../src/storage/memory-backend.js';

/**
 * Locks in the O(1) exact-lookup fast path in `searchIndex`.
 *
 * Before the fix, every query needle walked the ENTIRE vocabulary
 * (`for (const [word] of wordMap)`), making search O(needles × vocabulary) —
 * it scaled linearly with how much memory had accumulated. The fix tries an
 * exact `Map.get(needle)` first and only falls back to a bounded substring
 * scan when there's no exact hit AND the needle is ≥ 3 chars.
 *
 * The key invariant these benches protect: an **exact whole-word** query must
 * cost roughly the same whether the index holds 1K or 10K distinct words. If
 * someone reintroduces the full-vocabulary walk, the 10K/exact bench will
 * blow out relative to the 1K/exact bench. The substring-fallback bench is
 * included as the deliberate worst case for contrast.
 */

// Deterministic pseudo-words so the vocabulary size is exactly controlled.
function makeWord(i: number): string {
  return `word${i.toString(36)}tok`;
}

/**
 * Build a memory set whose combined text yields ~`vocabSize` distinct words.
 * One entry per 10 words keeps entry count realistic while the vocabulary
 * (the thing the old code scanned) grows to the target size.
 */
function makeEntries(vocabSize: number): MemoryEntry[] {
  const entries: MemoryEntry[] = [];
  const WORDS_PER_ENTRY = 10;
  for (let i = 0; i < vocabSize; i += WORDS_PER_ENTRY) {
    const words: string[] = [];
    for (let j = 0; j < WORDS_PER_ENTRY && i + j < vocabSize; j++) {
      words.push(makeWord(i + j));
    }
    entries.push({
      scope: 'project-memory',
      text: words.join(' '),
      ts: '2026-01-01T00:00:00Z',
      tags: [`tag${((i / WORDS_PER_ENTRY) % 50).toString(36)}`],
    });
  }
  return entries;
}

const index1k = buildInvertedIndex(makeEntries(1_000));
const index10k = buildInvertedIndex(makeEntries(10_000));

// An exact whole word that exists in both indexes (near the end, so a naive
// scan can't get lucky and bail early). makeWord(900) is present in the 1K set.
const EXACT_HIT_1K = makeWord(900);
const EXACT_HIT_10K = makeWord(9_000);

// A needle that is NOT a stored whole word but IS a substring of stored words
// ("tok" is the shared suffix) — forces the bounded substring fallback.
const SUBSTRING_NEEDLE = 'tok';

// A needle with no exact hit and no substring match — exercises the miss path.
const NO_MATCH = 'zzqqxnomatch';

describe('searchIndex — exact whole-word lookup (O(1) fast path)', () => {
  // These two should be within the same order of magnitude. A 10× blow-up
  // between them signals the full-vocabulary walk has returned.
  test('1K vocabulary, exact hit', async ({ bench }) => {
    await bench('1K vocabulary, exact hit', () => {
      searchIndex(index1k, EXACT_HIT_1K, 8);
    }).run();
  });
  test('10K vocabulary, exact hit', async ({ bench }) => {
    await bench('10K vocabulary, exact hit', () => {
      searchIndex(index10k, EXACT_HIT_10K, 8);
    }).run();
  });
  test('10K vocabulary, exact miss (no such word)', async ({ bench }) => {
    await bench('10K vocabulary, exact miss (no such word)', () => {
      searchIndex(index10k, NO_MATCH, 8);
    }).run();
  });
});

describe('searchIndex — substring fallback (deliberate worst case)', () => {
  // No exact hit + ≥3-char needle → bounded full-vocabulary substring scan.
  // This is the path that stays O(vocabulary) by design; benched so the
  // contrast with the exact path is visible and the cost is tracked.
  test('1K vocabulary, substring needle', async ({ bench }) => {
    await bench('1K vocabulary, substring needle', () => {
      searchIndex(index1k, SUBSTRING_NEEDLE, 8);
    }).run();
  });
  test('10K vocabulary, substring needle', async ({ bench }) => {
    await bench('10K vocabulary, substring needle', () => {
      searchIndex(index10k, SUBSTRING_NEEDLE, 8);
    }).run();
  });
});

describe('searchIndex — multi-needle query', () => {
  // Realistic shape: a few exact words from a task description.
  const multi = `${makeWord(100)} ${makeWord(500)} ${makeWord(9_500)}`;
  test('10K vocabulary, 3 exact needles', async ({ bench }) => {
    await bench('10K vocabulary, 3 exact needles', () => {
      searchIndex(index10k, multi, 8);
    }).run();
  });
});
