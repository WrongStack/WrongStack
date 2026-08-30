import { describe, expect, it } from 'vitest';
import { LargeAnswerStore } from '../../src/coordination/large-answer-store.js';

describe('LargeAnswerStore', () => {
  it('returns null/undefined inline', () => {
    const s = new LargeAnswerStore();
    expect(s.storeAnswer(null)).toEqual({ summary: 'null', inline: true });
    expect(s.storeAnswer(undefined)).toEqual({ summary: 'undefined', inline: true });
    expect(s.size).toBe(0);
  });

  it('returns small string values inline (truncated to 500 chars)', () => {
    const s = new LargeAnswerStore(2000);
    const r = s.storeAnswer('short answer');
    expect(r.inline).toBe(true);
    expect(r.summary).toBe('short answer');
    expect(r.key).toBeUndefined();
  });

  it('serializes and inlines small objects below the threshold', () => {
    const s = new LargeAnswerStore(2000);
    const r = s.storeAnswer({ a: 1, b: 'two' });
    expect(r.inline).toBe(true);
    expect(r.summary).toContain('"a":1');
  });

  it('stores oversize values out-of-context and retrieves them by key', () => {
    const s = new LargeAnswerStore(10);
    const big = 'x'.repeat(50);
    const r = s.storeAnswer(big);
    expect(r.inline).toBe(false);
    expect(r.key).toMatch(/^a-/);
    expect(r.summary).toContain('stored: 50 chars');
    expect(s.retrieveAnswer(r.key!)).toBe(big);
    expect(s.hasAnswer(r.key!)).toBe(true);
    expect(s.size).toBe(1);
    expect(s.totalChars).toBe(50);
  });

  it('derives a stable key for identical content', () => {
    const s = new LargeAnswerStore(10);
    const v = 'y'.repeat(40);
    expect(s.storeAnswer(v).key).toBe(s.storeAnswer(v).key);
  });

  it('returns undefined for unknown keys and false for hasAnswer', () => {
    const s = new LargeAnswerStore();
    expect(s.retrieveAnswer('nope')).toBeUndefined();
    expect(s.hasAnswer('nope')).toBe(false);
  });

  it('clears all entries', () => {
    const s = new LargeAnswerStore(10);
    s.storeAnswer('z'.repeat(30));
    expect(s.size).toBe(1);
    s.clear();
    expect(s.size).toBe(0);
    expect(s.totalChars).toBe(0);
  });

  it('evicts oldest answers to stay within entry and byte budgets', () => {
    const s = new LargeAnswerStore(1, { maxEntries: 2, maxBytes: 70 });
    const first = s.storeAnswer('a'.repeat(30)).key!;
    const second = s.storeAnswer('b'.repeat(30)).key!;
    const third = s.storeAnswer('c'.repeat(30)).key!;

    expect(s.size).toBe(2);
    expect(s.totalBytes).toBeLessThanOrEqual(70);
    expect(s.hasAnswer(first)).toBe(false);
    expect(s.hasAnswer(second)).toBe(true);
    expect(s.hasAnswer(third)).toBe(true);
  });

  it('does not retain one answer larger than the total byte budget', () => {
    const s = new LargeAnswerStore(1, { maxBytes: 16 });
    const result = s.storeAnswer('x'.repeat(100));
    expect(result.inline).toBe(false);
    expect(result.key).toBeUndefined();
    expect(s.size).toBe(0);
    expect(s.totalBytes).toBe(0);
  });

  it('handles circular and non-serializable objects without throwing', () => {
    const s = new LargeAnswerStore(10);
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic['self'] = cyclic;
    expect(() => s.storeAnswer(cyclic)).not.toThrow();
  });
});
