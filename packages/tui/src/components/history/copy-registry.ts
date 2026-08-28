import type { EntryHeightCache } from '../../height-cache.js';
import type { CopyHit } from './copy-geometry.js';
import { copyRegistryVisibleClip, liveToolStreamCopyHit } from './copy-geometry.js';
import { isCopyableEntry } from './copy-icon.js';
import { type RenderGroup, renderGroupId } from './tool-group.js';

interface CopyRegistry {
  hits: CopyHit[];
  liveHit: CopyHit | null;
}

/**
 * Resolve copy icons into the already-reserved scrollbar gap column.
 *
 * Copy affordances must not alter card width: changing the width changes
 * wrapped row counts, which invalidates the prefix sums that map scrollbar
 * positions to virtual entry slices. This helper derives icon rows from the
 * same cached heights used by the mount plan while leaving entry geometry
 * untouched.
 */
export function buildCopyRegistry(opts: {
  renderGroups: readonly RenderGroup[];
  heightCache: EntryHeightCache;
  scrolled: boolean;
  clip: number;
  tailRows: number;
  viewportRows: number;
  iconCol: number;
  showModelReasoning?: boolean | undefined;
  liveToolVisible: boolean;
}): CopyRegistry {
  const mountedGroupRows = opts.renderGroups.reduce(
    (rows, group) => rows + (opts.heightCache.getHeight(renderGroupId(group)) ?? 0),
    0,
  );
  const visibleClip = copyRegistryVisibleClip({
    scrolled: opts.scrolled,
    clip: opts.clip,
    mountedRows: mountedGroupRows,
    tailRows: opts.tailRows,
    viewportRows: opts.viewportRows,
  });
  // Pinned frames whose mounted stack is shorter than the viewport are
  // rendered with flex-end (parking the first card at row `vp - mountedRows`).
  // Mirror the same `pinnedSlack` offset `buildMountedCardSpans` uses so the
  // copy icon row stays visually aligned with the card row — without this,
  // icons render at row 0 while the card itself sits at row `vp - h`.
  const pinnedSlack = !opts.scrolled
    ? Math.max(0, opts.viewportRows - mountedGroupRows - opts.tailRows)
    : 0;
  const hits: CopyHit[] = [];
  let offset = 0;
  for (const group of opts.renderGroups) {
    const gid = renderGroupId(group);
    const groupHeight = opts.heightCache.getHeight(gid) ?? 0;
    const startRow = offset - visibleClip + pinnedSlack;
    offset += groupHeight;
    const groupEntryIds =
      group.type === 'tool-group'
        ? group.data.entries.map((entry) => entry.id)
        : isCopyableEntry(group.entry) &&
            !(group.entry.kind === 'thinking' && opts.showModelReasoning === false)
          ? [group.entry.id]
          : [];
    const entryId = groupEntryIds[0];
    if (entryId === undefined || startRow < 0 || startRow >= opts.viewportRows) continue;
    hits.push({
      entryId,
      ...(groupEntryIds.length > 1 ? { entryIds: groupEntryIds } : {}),
      startRow,
      endRow: startRow + 1,
      iconCol: opts.iconCol,
    });
  }
  return {
    hits,
    liveHit: liveToolStreamCopyHit({
      visible: opts.liveToolVisible,
      mountedRows: mountedGroupRows,
      visibleClip,
      viewportRows: opts.viewportRows,
      iconCol: opts.iconCol,
      pinnedSlack,
    }),
  };
}
