import type React from 'react';
import { useMemo } from 'react';
import { Box, Text, useInput } from '../ink.js';
import { theme } from '../theme.js';
import { LIVE_TOOL_STREAM_COPY_ID } from './history/copy-geometry.js';
import {
  INSPECT_ICON,
  inspectTextForEntries,
  inspectTitleForEntries,
} from './history/copy-icon.js';
import type { HistoryEntry } from './history/types.js';

export const INSPECT_OVERLAY_MIN_ROWS = 15;
const INSPECT_BODY_CHAR_CAP = 200_000;
const INSPECT_COPY_LABEL = '[Copy]';
const INSPECT_CLOSE_LABEL = '[Close]';
const INSPECT_HEADER_BUTTON_GAP = 1;

export type InspectOverlayHeaderAction = 'copy' | 'close';

export function resolveInspectOverlayContent(
  overlay: { entryId: number; entryIds?: readonly number[] | undefined },
  entries: readonly HistoryEntry[],
  toolStream: { name: string; text: string } | null,
): { title: string; body: string } {
  if (overlay.entryId === LIVE_TOOL_STREAM_COPY_ID) {
    return {
      title: `${toolStream?.name ?? 'tool'}  streaming`,
      body: toolStream?.text && toolStream.text.length > 0 ? toolStream.text : '(streaming…)',
    };
  }
  const ids = overlay.entryIds ?? [overlay.entryId];
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const selected = ids
    .map((id) => byId.get(id))
    .filter((entry): entry is HistoryEntry => entry !== undefined);
  if (selected.length === 0) {
    return { title: 'Inspect', body: '(entry is no longer in history)' };
  }
  return {
    title: inspectTitleForEntries(selected),
    body: inspectTextForEntries(selected),
  };
}

export function wrapInspectLines(text: string, width: number): string[] {
  const w = Math.max(1, width);
  const source =
    text.length > INSPECT_BODY_CHAR_CAP
      ? `${text.slice(0, INSPECT_BODY_CHAR_CAP)}\n… truncated (${text.length - INSPECT_BODY_CHAR_CAP} more chars)`
      : text;
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const rows: string[] = [];
  for (const line of lines) {
    if (line.length === 0) {
      rows.push('');
      continue;
    }
    for (let i = 0; i < line.length; i += w) rows.push(line.slice(i, i + w));
  }
  return rows.length > 0 ? rows : [''];
}

export function inspectOverlaySize(
  termCols: number,
  viewportRows: number,
): {
  width: number;
  height: number;
} {
  const width = Math.max(24, Math.min(termCols - 2, Math.floor(termCols * 0.9)));
  const preferred = Math.max(INSPECT_OVERLAY_MIN_ROWS, Math.floor(viewportRows * 0.85));
  const height = Math.max(8, Math.min(viewportRows, preferred));
  return { width, height };
}

/**
 * Resolve a terminal click against the two fixed-width controls rendered at
 * the right edge of the centered inspect-overlay title row. Mouse coordinates
 * are the terminal protocol's one-based cells.
 */
export function inspectOverlayHeaderActionAt(
  termCols: number,
  viewportRows: number,
  x: number,
  y: number,
): InspectOverlayHeaderAction | null {
  const { width, height } = inspectOverlaySize(termCols, viewportRows);
  const left = Math.floor((termCols - width) / 2);
  const top = Math.floor((viewportRows - height) / 2);
  const headerRow = top + 2;
  if (y !== headerRow) return null;

  // The rounded border occupies the outer cell and paddingX occupies the next,
  // so the final usable header cell is two columns left of the box's right edge.
  const contentRight = left + width - 2;
  const closeStart = contentRight - INSPECT_CLOSE_LABEL.length + 1;
  const copyEnd = closeStart - INSPECT_HEADER_BUTTON_GAP - 1;
  const copyStart = copyEnd - INSPECT_COPY_LABEL.length + 1;
  if (x >= copyStart && x <= copyEnd) return 'copy';
  if (x >= closeStart && x <= contentRight) return 'close';
  return null;
}

const SCROLLBAR_TRACK_GLYPH = '░';
const SCROLLBAR_THUMB_GLYPH = '█';

/**
 * Thumb geometry for the overlay's vertical scrollbar. The track is
 * `visibleRows` tall; when the wrapped body fits, the thumb covers the whole
 * (dim) track. Otherwise the thumb length is proportional to the visible
 * fraction and travels from the top (offset 0) to flush bottom
 * (offset = totalRows - visibleRows).
 */
export function scrollbarThumbGeometry(
  totalRows: number,
  visibleRows: number,
  offset: number,
): { thumbStart: number; thumbLength: number } {
  const track = Math.max(1, visibleRows);
  if (totalRows <= track) return { thumbStart: 0, thumbLength: track };
  const maxScroll = Math.max(1, totalRows - visibleRows);
  const thumbLength = Math.max(
    1,
    Math.min(track - 1, Math.round((visibleRows / totalRows) * track)),
  );
  const travel = track - thumbLength;
  const clamped = Math.max(0, Math.min(offset, maxScroll));
  return { thumbStart: Math.round((clamped / maxScroll) * travel), thumbLength };
}

interface InspectOverlayProps {
  title: string;
  body: string;
  scroll: number;
  termCols: number;
  viewportRows: number;
  onScroll: (delta: number) => void;
  onClose: () => void;
  copied?: boolean | undefined;
}

export function InspectOverlay({
  title,
  body,
  scroll,
  termCols,
  viewportRows,
  onScroll,
  onClose,
  copied = false,
}: InspectOverlayProps): React.ReactElement {
  const { width, height } = inspectOverlaySize(termCols, viewportRows);
  // Inner width minus border(2) + paddingX(2), then reserve one column for the
  // scrollbar gutter so wrapped line count stays stable while scrolling.
  const contentWidth = Math.max(8, width - 5);
  const bodyRows = Math.max(4, height - 4);
  const lines = useMemo(() => wrapInspectLines(body, contentWidth), [body, contentWidth]);
  const maxScroll = Math.max(0, lines.length - bodyRows);
  const offset = Math.max(0, Math.min(scroll, maxScroll));
  const visible = lines.slice(offset, offset + bodyRows);
  const page = Math.max(1, bodyRows - 1);
  const scrollable = maxScroll > 0;
  const { thumbStart, thumbLength } = scrollbarThumbGeometry(lines.length, bodyRows, offset);

  useInput((input, key) => {
    if (key.escape || input === 'q') {
      onClose();
      return;
    }
    if (key.upArrow) onScroll(-1);
    else if (key.downArrow) onScroll(1);
    else if (key.pageUp) onScroll(-page);
    else if (key.pageDown) onScroll(page);
    else if (key.home) onScroll(-maxScroll);
    else if (key.end) onScroll(maxScroll);
  });

  const moreAbove = offset;
  const moreBelow = Math.max(0, lines.length - offset - visible.length);

  return (
    <Box
      width={termCols}
      height={viewportRows}
      alignItems="center"
      justifyContent="center"
      flexShrink={0}
    >
      <Box
        flexDirection="column"
        width={width}
        height={height}
        borderStyle="round"
        borderColor={theme.accent}
        paddingX={1}
        overflowY="hidden"
      >
        <Box flexDirection="row">
          <Box flexGrow={1} overflowX="hidden">
            <Text bold color={theme.accent} wrap="truncate-end">
              {`${INSPECT_ICON} ${title}`}
            </Text>
          </Box>
          {width >= 48 ? (
            <Text dimColor>{`${lines.length} line${lines.length === 1 ? '' : 's'} · `}</Text>
          ) : null}
          <Text bold color={copied ? theme.success : theme.accent}>
            {INSPECT_COPY_LABEL}
          </Text>
          <Text> </Text>
          <Text bold color={theme.accent}>
            {INSPECT_CLOSE_LABEL}
          </Text>
        </Box>
        <Text dimColor>
          {moreAbove > 0 ? `↑ ${moreAbove} more` : ''}
          {moreAbove > 0 && moreBelow > 0 ? '  ' : ''}
          {moreBelow > 0 ? `↓ ${moreBelow} more` : ''}
          {moreAbove === 0 && moreBelow === 0 ? '↑↓ scroll' : ''}
        </Text>
        <Box flexDirection="row" height={bodyRows} overflowY="hidden">
          <Box flexDirection="column" width={contentWidth} overflowY="hidden">
            {visible.map((line, i) => (
              <Text key={`${offset}-${i}`} wrap="truncate">
                {line.length > 0 ? line : ' '}
              </Text>
            ))}
          </Box>
          <Box flexDirection="column" width={1} flexShrink={0}>
            {Array.from({ length: bodyRows }, (_, row) => {
              const inThumb = row >= thumbStart && row < thumbStart + thumbLength;
              return (
                <Text
                  key={row}
                  color={inThumb && scrollable ? theme.accent : undefined}
                  dimColor={!inThumb || !scrollable}
                >
                  {inThumb ? SCROLLBAR_THUMB_GLYPH : SCROLLBAR_TRACK_GLYPH}
                </Text>
              );
            })}
          </Box>
        </Box>
      </Box>
    </Box>
  );
}
