/**
 * Right-edge rail for the managed viewport. Its first column is the copy icon
 * (or blank), the second is a visual gap, and the third is the scrollbar track.
 * All three columns are always reserved, so copy affordances and scrollability
 * never reflow chat content.
 *
 * The gap column doubles as the drag-selection highlight band: while a drag is
 * in progress, the subscribing component re-renders ONLY this rail (via
 * useSyncExternalStore on {@link SelectionBandStore}) — the history cards
 * never re-render, and because the band occupies the already-reserved gap
 * column the layout (and the fixed-height overflow-hidden viewport) cannot
 * change mid-drag.
 *
 * Extracted from scrollable-history.tsx.
 */
import type React from 'react';
import { useSyncExternalStore } from 'react';
import { Box, Text } from '../../ink.js';
import { theme } from '../../theme.js';
import { COPY_ICON } from './copy-icon.js';
import type { CopyHit } from './copy-geometry.js';
import { scrollbarThumb } from './scrollbar-geometry.js';
import { createSelectionBandStore, type SelectionBandStore } from './selection-band-store.js';

/** Default no-op store so the hook call below is never conditional. */
const NO_BAND = createSelectionBandStore();

export function Scrollbar({
  rows,
  offset,
  total,
  copyHits,
  copiedEntryId,
  selectionBandStore = NO_BAND,
}: {
  rows: number;
  offset: number;
  total: number;
  copyHits: readonly CopyHit[];
  copiedEntryId?: number | null | undefined;
  selectionBandStore?: SelectionBandStore | undefined;
}): React.ReactElement {
  const band = useSyncExternalStore(selectionBandStore.subscribe, selectionBandStore.getSnapshot);
  const { top: thumbTop, size: thumbSize, scrollable } = scrollbarThumb(rows, offset, total);
  const cells: string[] = [];
  for (let i = 0; i < rows; i++) {
    cells.push(i >= thumbTop && i < thumbTop + thumbSize ? '█' : '│');
  }
  const copyByRow = new Map<number, CopyHit>();
  for (const hit of copyHits) copyByRow.set(hit.startRow, hit);
  return (
    <Box flexDirection="column" flexShrink={0}>
      {cells.map((cell, row) => {
        const copyHit = copyByRow.get(row);
        const inBand = band !== null && row >= band.topRow && row <= band.bottomRow && row < rows;
        const isHead = band !== null && row === band.headRow && row < rows;
        return (
          <Box key={row} flexDirection="row">
            <Text
              color={copyHit && copiedEntryId === copyHit.entryId ? theme.success : theme.textMuted}
            >
              {copyHit ? COPY_ICON : ' '}
            </Text>
            <Text {...(inBand ? { color: theme.accent } : {})}>
              {isHead ? '█' : inBand ? '▌' : ' '}
            </Text>
            <Text
              {...(scrollable ? { color: theme.accent } : {})}
              dimColor={!scrollable || cell === '│'}
            >
              {cell}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
