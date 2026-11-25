import { describe, expect, it } from 'vitest';
import { commandListWindow } from '../src/components/command-list-window.js';

describe('commandListWindow non-finite selected/capacity guards', () => {
  it('returns finite focus, below, and non-empty rows when inputs are NaN', () => {
    const items = [{ category: 'App' }, { category: 'App' }, { category: 'App' }];
    const res = commandListWindow(items, Number.NaN, Number.NaN);
    expect(res.rows.length).toBeGreaterThan(0);
    expect(Number.isFinite(res.focus)).toBe(true);
    expect(Number.isFinite(res.below)).toBe(true);
  });
});
