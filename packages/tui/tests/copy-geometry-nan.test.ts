import { describe, expect, it } from 'vitest';
import {
  type CopyHit,
  findCopyHit,
  findInspectHit,
  findToolViewControl,
} from '../src/components/history/copy-geometry.js';

describe('copy-geometry non-finite hit coordinates', () => {
  it('returns null instead of matching when row or col is non-finite', () => {
    const hits: CopyHit[] = [
      {
        entryId: 1,
        startRow: 0,
        endRow: 5,
        iconCol: 70,
        inspectCol: 66,
        toolEntryIds: [1],
        toolViewMode: 'normal',
        lessCol: 60,
        moreCol: 63,
      },
    ];
    expect(findCopyHit(hits, Number.NaN, 70)).toBeNull();
    expect(findCopyHit(hits, 2, Number.NaN)).toBeNull();
    expect(findInspectHit(hits, Number.NaN, 66)).toBeNull();
    expect(findToolViewControl(hits, Number.NaN, 60)).toBeNull();
    expect(findCopyHit(hits, 2, 70)?.entryId).toBe(1);
  });
});
