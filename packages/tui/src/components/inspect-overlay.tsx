import { useMemo } from 'react';
import type React from 'react';
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

export function inspectOverlaySize(termCols: number, viewportRows: number): {
  width: number;
  height: number;
} {
  const width = Math.max(24, Math.min(termCols - 2, Math.floor(termCols * 0.9)));
  const preferred = Math.max(INSPECT_OVERLAY_MIN_ROWS, Math.floor(viewportRows * 0.85));
  const height = Math.max(8, Math.min(viewportRows, preferred));
  return { width, height };
}

interface InspectOverlayProps {
  title: string;
  body: string;
  scroll: number;
  termCols: number;
  viewportRows: number;
  onScroll: (delta: number) => void;
  onClose: () => void;
}

export function InspectOverlay({
  title,
  body,
  scroll,
  termCols,
  viewportRows,
  onScroll,
  onClose,
}: InspectOverlayProps): React.ReactElement {
  const { width, height } = inspectOverlaySize(termCols, viewportRows);
  const contentWidth = Math.max(8, width - 4);
  const bodyRows = Math.max(4, height - 4);
  const lines = useMemo(() => wrapInspectLines(body, contentWidth), [body, contentWidth]);
  const maxScroll = Math.max(0, lines.length - bodyRows);
  const offset = Math.max(0, Math.min(scroll, maxScroll));
  const visible = lines.slice(offset, offset + bodyRows);
  const page = Math.max(1, bodyRows - 1);

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
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold color={theme.accent}>
            {`${INSPECT_ICON} ${title}`}
          </Text>
          <Text dimColor>
            {`${lines.length} line${lines.length === 1 ? '' : 's'} · Esc close`}
          </Text>
        </Box>
        <Text dimColor>
          {moreAbove > 0 ? `↑ ${moreAbove} more` : ''}
          {moreAbove > 0 && moreBelow > 0 ? '  ' : ''}
          {moreBelow > 0 ? `↓ ${moreBelow} more` : ''}
          {moreAbove === 0 && moreBelow === 0 ? '↑↓ scroll' : ''}
        </Text>
        <Box flexDirection="column" height={bodyRows} overflowY="hidden">
          {visible.map((line, i) => (
            <Text key={`${offset}-${i}`} wrap="truncate">
              {line.length > 0 ? line : ' '}
            </Text>
          ))}
        </Box>
      </Box>
    </Box>
  );
}
