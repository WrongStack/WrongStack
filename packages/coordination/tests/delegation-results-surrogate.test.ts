/**
 * F1159 — `buildDelegationResultExcerpt` must never cut a surrogate pair in
 * half. The excerpt is journaled and folded into the leader conversation as
 * the `[DELEGATION RESULT]` body; a lone high surrogate there is ill-formed
 * UTF-16 and invalid on the provider wire.
 */
import { describe, expect, it } from 'vitest';
import { buildDelegationResultExcerpt } from '../src/delegation/delegation-results.js';
import type { DelegateResult } from '../src/delegation/delegation-types.js';

const ROCKET = '\u{1F680}';
const asResult = (result: string): DelegateResult => ({ result }) as unknown as DelegateResult;

describe('buildDelegationResultExcerpt surrogate safety (F1159)', () => {
  it('drops the orphaned high surrogate when the cap lands inside an emoji', () => {
    const text = 'y'.repeat(98) + ROCKET + 'z'.repeat(200);
    const excerpt = buildDelegationResultExcerpt(asResult(text), 100);
    expect(excerpt.isWellFormed()).toBe(true);
    expect(excerpt).toBe(`${'y'.repeat(98)}…`);
  });

  it('keeps a whole emoji that ends exactly at the cut', () => {
    const text = 'y'.repeat(97) + ROCKET + 'z'.repeat(200);
    const excerpt = buildDelegationResultExcerpt(asResult(text), 100);
    expect(excerpt).toBe(`${'y'.repeat(97)}${ROCKET}…`);
    expect(excerpt.length).toBe(100);
  });

  it('leaves under-cap and ASCII excerpts unchanged', () => {
    expect(buildDelegationResultExcerpt(asResult(`short ${ROCKET}`), 100)).toBe(`short ${ROCKET}`);
    const ascii = buildDelegationResultExcerpt(asResult('x'.repeat(250)), 100);
    expect(ascii).toBe(`${'x'.repeat(99)}…`);
  });
});
