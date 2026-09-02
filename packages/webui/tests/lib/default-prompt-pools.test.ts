import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PROMPT_CARDS,
  PROMPTS_PER_CARD,
  type PromptCard,
  SLASH_REFS,
  sampleN,
  shuffleAllCards,
} from '../../src/lib/default-prompt-pools';

describe('default prompt pools — catalog shape', () => {
  it('exposes the four welcome-screen categories in a stable order', () => {
    expect(DEFAULT_PROMPT_CARDS.map((c) => c.id)).toEqual([
      'understand',
      'create',
      'investigate',
      'improve',
    ]);
  });

  it('gives every card a renderable icon, title, hint, tone and gradient', () => {
    for (const card of DEFAULT_PROMPT_CARDS) {
      expect(card.icon, `${card.id} icon`).toBeTruthy();
      expect(card.title.length, `${card.id} title`).toBeGreaterThan(0);
      expect(card.hint.length, `${card.id} hint`).toBeGreaterThan(0);
      expect(card.tone, `${card.id} tone`).toMatch(/^text-/);
      expect(card.gradient, `${card.id} gradient`).toMatch(/^from-/);
    }
  });

  it('keeps every pool large enough to fill a card without repeats', () => {
    for (const card of DEFAULT_PROMPT_CARDS) {
      expect(card.pool.length, `${card.id} pool size`).toBeGreaterThanOrEqual(PROMPTS_PER_CARD);
      expect(new Set(card.pool).size, `${card.id} duplicate prompts`).toBe(card.pool.length);
    }
  });

  it('exposes slash references with unique ids and leading-slash names', () => {
    expect(SLASH_REFS.length).toBeGreaterThan(0);
    expect(new Set(SLASH_REFS.map((r) => r.id)).size).toBe(SLASH_REFS.length);
    for (const ref of SLASH_REFS) {
      expect(ref.name.startsWith('/'), ref.name).toBe(true);
      expect(ref.hint.length).toBeGreaterThan(0);
    }
  });
});

describe('sampleN', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns exactly n items when the pool is larger than n', () => {
    expect(sampleN([1, 2, 3, 4, 5], 3)).toHaveLength(3);
  });

  it('never returns duplicates — it shuffles a copy rather than picking with replacement', () => {
    const pool = Array.from({ length: 20 }, (_, i) => i);
    for (let run = 0; run < 25; run++) {
      const picked = sampleN(pool, 6);
      expect(new Set(picked).size).toBe(6);
    }
  });

  it('clamps to the pool size when n exceeds it', () => {
    expect(sampleN(['a', 'b'], 10)).toHaveLength(2);
  });

  it('returns an empty array for an empty pool (loop body never runs)', () => {
    expect(sampleN([], 4)).toEqual([]);
  });

  it('handles a single-item pool — the Fisher-Yates loop is skipped', () => {
    expect(sampleN(['only'], 1)).toEqual(['only']);
  });

  it('returns an empty array for n <= 0', () => {
    expect(sampleN([1, 2, 3], 0)).toEqual([]);
  });

  it('does not mutate the source pool', () => {
    const pool = [1, 2, 3, 4, 5];
    const snapshot = [...pool];
    // Force a maximal shuffle so every swap in the loop executes.
    vi.spyOn(Math, 'random').mockReturnValue(0.999999);
    sampleN(pool, 5);
    expect(pool).toEqual(snapshot);
  });

  it('reverses deterministically when Math.random always returns 0', () => {
    // j = floor(0 * (i+1)) = 0 for every i, so each element is swapped with
    // index 0 in turn — a fully deterministic permutation we can assert on.
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(sampleN([1, 2, 3], 3)).toEqual([2, 3, 1]);
  });

  it('preserves the whole pool as a set regardless of the shuffle', () => {
    const pool = ['a', 'b', 'c', 'd'];
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    expect(new Set(sampleN(pool, 4))).toEqual(new Set(pool));
  });
});

describe('shuffleAllCards', () => {
  it('keys the result by card id and fills each with PROMPTS_PER_CARD prompts', () => {
    const out = shuffleAllCards(DEFAULT_PROMPT_CARDS);
    expect(Object.keys(out).sort()).toEqual([...DEFAULT_PROMPT_CARDS.map((c) => c.id)].sort());
    for (const card of DEFAULT_PROMPT_CARDS) {
      expect(out[card.id]).toHaveLength(PROMPTS_PER_CARD);
    }
  });

  it('only ever emits prompts that belong to that card pool', () => {
    const out = shuffleAllCards(DEFAULT_PROMPT_CARDS);
    for (const card of DEFAULT_PROMPT_CARDS) {
      for (const prompt of out[card.id]) {
        expect(card.pool, `${card.id} leaked a foreign prompt`).toContain(prompt);
      }
    }
  });

  it('returns an empty record for an empty card list', () => {
    expect(shuffleAllCards([])).toEqual({});
  });

  it('clamps a short pool instead of padding it', () => {
    const short: PromptCard = {
      ...DEFAULT_PROMPT_CARDS[0],
      id: 'understand',
      pool: ['only-one'],
    };
    expect(shuffleAllCards([short])).toEqual({ understand: ['only-one'] });
  });
});
