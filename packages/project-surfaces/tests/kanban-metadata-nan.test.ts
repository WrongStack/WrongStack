import { describe, expect, it } from 'vitest';
import { kanbanMetadataText } from '../src/kanban/kanban-metadata.js';

describe('kanbanMetadataText non-finite numbers (F1881)', () => {
  it('returns undefined for NaN and Infinity while preserving finite numbers and booleans', () => {
    expect(kanbanMetadataText(Number.NaN)).toBeUndefined();
    expect(kanbanMetadataText(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(kanbanMetadataText(Number.NEGATIVE_INFINITY)).toBeUndefined();
    expect(kanbanMetadataText(0)).toBe('0');
    expect(kanbanMetadataText(42)).toBe('42');
    expect(kanbanMetadataText(true)).toBe('true');
    expect(kanbanMetadataText('  hi  ')).toBe('hi');
  });
});
