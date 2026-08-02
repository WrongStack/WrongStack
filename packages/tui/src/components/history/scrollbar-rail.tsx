/**
 * Right-edge rail for the managed viewport. Its first column is the copy icon
 * (or blank), the second is a visual gap, and the third is the scrollbar track.
 * All three columns are always reserved, so copy affordances and scrollability
 * never reflow chat content.
 *
 * Extracted from scrollable-history.tsx.
 */
import type React from 'react';
import { Box, Text } from '../../ink.js';
import { theme } from '../../theme.js';
import { COPY_ICON } from './copy-icon.js';
import type { CopyHit } from './copy-geometry.js';
import { scrollbarThumb } from './scrollbar-geometry.js';

export function Scrollbar({
  rows,
  offset,
  total,
  copyHits,
  copiedEntryId,
}: {
  rows: number;
  offset: number;
  total: number;
  copyHits: readonly CopyHit[];
  copiedEntryId?: number | null | undefined;
}): React.ReactElement {
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
        return (
          <Box key={row} flexDirection="row">
            <Text
              color={copyHit && copiedEntryId === copyHit.entryId ? theme.success : theme.textMuted}
            >
              {copyHit ? COPY_ICON : ' '}
            </Text>
            <Text> </Text>
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
