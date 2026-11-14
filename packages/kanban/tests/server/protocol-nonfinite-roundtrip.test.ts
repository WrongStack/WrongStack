import { describe, expect, it } from 'vitest';
import { decodeKanbanDomainValue, encodeKanbanDomainValue } from '../../src/server/protocol.js';

describe('Kanban domain wire non-finite numbers (F304)', () => {
  it('round-trips NaN, Infinity, -Infinity, and -0', () => {
    expect(Number.isNaN(decodeKanbanDomainValue(encodeKanbanDomainValue(Number.NaN)))).toBe(true);
    expect(decodeKanbanDomainValue(encodeKanbanDomainValue(Number.POSITIVE_INFINITY))).toBe(
      Number.POSITIVE_INFINITY,
    );
    expect(decodeKanbanDomainValue(encodeKanbanDomainValue(Number.NEGATIVE_INFINITY))).toBe(
      Number.NEGATIVE_INFINITY,
    );
    expect(Object.is(decodeKanbanDomainValue(encodeKanbanDomainValue(-0)), -0)).toBe(true);
  });
});
