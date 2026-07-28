import { describe, expect, it } from 'vitest';
import {
  type CopyHit,
  LIVE_TOOL_STREAM_COPY_ID,
  copyRegistryVisibleClip,
  findCopyHit,
  liveToolStreamCopyHit,
} from '../src/components/scrollable-history.js';

/** Build a copy hit at a given row range with the icon at `iconCol`. */
function hit(entryId: number, startRow: number, endRow: number, iconCol: number): CopyHit {
  return { entryId, startRow, endRow, iconCol };
}

describe('copyRegistryVisibleClip', () => {
  it('uses the anchor clip for scrolled frames', () => {
    expect(
      copyRegistryVisibleClip({
        scrolled: true,
        clip: 2,
        mountedRows: 12,
        tailRows: 3,
        viewportRows: 5,
      }),
    ).toBe(2);
  });

  it('accounts for top overflow hidden by pinned flex-end clipping', () => {
    expect(
      copyRegistryVisibleClip({
        scrolled: false,
        clip: 0,
        mountedRows: 12,
        tailRows: 0,
        viewportRows: 5,
      }),
    ).toBe(7);
  });

  it('includes the live tool tail when pinned', () => {
    expect(
      copyRegistryVisibleClip({
        scrolled: false,
        clip: 0,
        mountedRows: 12,
        tailRows: 3,
        viewportRows: 5,
      }),
    ).toBe(10);
  });

  it('does not return a negative clip for underfilled pinned frames', () => {
    expect(
      copyRegistryVisibleClip({
        scrolled: false,
        clip: 0,
        mountedRows: 3,
        tailRows: 0,
        viewportRows: 5,
      }),
    ).toBe(0);
  });
});

describe('liveToolStreamCopyHit', () => {
  it('places the hit on the stream header after its top margin', () => {
    expect(
      liveToolStreamCopyHit({
        visible: true,
        mountedRows: 3,
        visibleClip: 1,
        viewportRows: 10,
        iconCol: 57,
      }),
    ).toEqual({
      entryId: LIVE_TOOL_STREAM_COPY_ID,
      startRow: 3,
      endRow: 4,
      iconCol: 57,
    });
  });

  it('returns null when the stream or header is not visible', () => {
    expect(
      liveToolStreamCopyHit({
        visible: false,
        mountedRows: 3,
        visibleClip: 1,
        viewportRows: 10,
        iconCol: 57,
      }),
    ).toBeNull();
    expect(
      liveToolStreamCopyHit({
        visible: true,
        mountedRows: 12,
        visibleClip: 0,
        viewportRows: 10,
        iconCol: 57,
      }),
    ).toBeNull();
  });
});

describe('findCopyHit', () => {
  it('returns null for an empty registry', () => {
    expect(findCopyHit([], 0, 0)).toBeNull();
  });

  it('matches a click on the icon cell', () => {
    const hits = [hit(1, 0, 3, 40)];
    const found = findCopyHit(hits, 1, 40);
    expect(found?.entryId).toBe(1);
    expect(found).toEqual({ entryId: 1, startRow: 0, endRow: 3, iconCol: 40 });
  });

  it('matches only the single icon row (endRow exclusive)', () => {
    // The registry builds single-row hits: the icon lives on the first row only.
    const hits = [hit(2, 2, 3, 40)];
    expect(findCopyHit(hits, 2, 40)?.entryId).toBe(2); // startRow inclusive
    expect(findCopyHit(hits, 3, 40)).toBeNull(); // endRow exclusive
  });

  it('rejects a click below the icon row (endRow is exclusive)', () => {
    const hits = [hit(3, 2, 3, 40)];
    expect(findCopyHit(hits, 3, 40)).toBeNull();
  });

  it('rejects a click above the icon row', () => {
    const hits = [hit(4, 2, 3, 40)];
    expect(findCopyHit(hits, 1, 40)).toBeNull();
  });

  it('rejects a click left of the icon column (over body text)', () => {
    const hits = [hit(5, 0, 3, 40)];
    expect(findCopyHit(hits, 1, 39)).toBeNull();
    expect(findCopyHit(hits, 1, 0)).toBeNull();
  });

  it('rejects a click right of the single-cell icon', () => {
    const hits = [hit(6, 0, 3, 40)];
    expect(findCopyHit(hits, 1, 41)).toBeNull();
  });

  it('prefers the newest (last) card when row ranges overlap', () => {
    // Overlapping estimates can momentarily collide; the newest-first scan wins.
    const hits = [hit(10, 0, 4, 40), hit(11, 2, 6, 40)];
    expect(findCopyHit(hits, 3, 40)?.entryId).toBe(11);
  });

  it('resolves distinct cards at distinct rows', () => {
    const hits = [hit(20, 0, 2, 40), hit(21, 2, 4, 40), hit(22, 4, 6, 40)];
    expect(findCopyHit(hits, 0, 40)?.entryId).toBe(20);
    expect(findCopyHit(hits, 3, 40)?.entryId).toBe(21);
    expect(findCopyHit(hits, 5, 40)?.entryId).toBe(22);
  });
});
