import type { HqCommandAuditEntry } from '@wrongstack/hq';
import { describe, expect, it } from 'vitest';
import { mergeAudit } from '../src/features/control/model';

describe('mergeAudit limit bounds', () => {
  it('returns an empty array for negative or NaN limits', () => {
    const entries = [
      { commandId: 'c1', enqueuedAt: '2026-01-01T00:00:01Z' },
      { commandId: 'c2', enqueuedAt: '2026-01-01T00:00:02Z' },
    ] as HqCommandAuditEntry[];
    expect(mergeAudit(entries, [], -1)).toEqual([]);
    expect(mergeAudit(entries, [], Number.NaN)).toEqual([]);
    expect(mergeAudit(entries, [], 1)).toHaveLength(1);
  });
});
