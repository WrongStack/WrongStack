import { describe, expect, it } from 'vitest';
import type { MemoryValidity } from '../src/memory-model.js';
import { validityKey } from '../src/shared/memory-validity.js';

describe('validityKey (F2205)', () => {
  it('never throws even when given a circular invalid object', () => {
    const circular: Record<string, unknown> = { statement: 'ok' };
    circular.self = circular;
    const key = validityKey(circular as unknown as MemoryValidity);
    expect(key).toContain('invalid');
  });
});
