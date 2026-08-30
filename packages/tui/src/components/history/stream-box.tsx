import React from 'react';
import { Box, Text, useAnimation } from '../../ink.js';
import { theme } from '../../theme.js';
import { sanitizeTerminalText, truncateDisplay } from '../../terminal-width.js';
import { getToolVisual } from '../../tool-glyph.js';
import { fmtDuration } from './basic-format.js';

export const MAX_STREAM_DISPLAY_CHARS = 480;
const MAX_STREAM_LINES = 8;
const WRITE_CREATE_STREAM_LINES = 3;
const TOOL_STREAM_MARGIN_ROWS = 2;
const TOOL_STREAM_HEADER_ROWS = 1;

const ASSISTANT_STREAM_LINES = 6;
const ASSISTANT_STREAM_MARGIN_ROWS = 2;
const ASSISTANT_STREAM_HEADER_ROWS = 1;

/** Fixed layout height of the live assistant-stream tail for scroll-range math. */
export function assistantStreamBoxHeight(): number {
  return ASSISTANT_STREAM_MARGIN_ROWS + ASSISTANT_STREAM_HEADER_ROWS + ASSISTANT_STREAM_LINES;
}

/** Fixed layout height of the live tool-stream tail for scroll-range math. */
export function toolStreamBoxHeight(name: string): number {
  const contentRows = name === 'write' ? WRITE_CREATE_STREAM_LINES : MAX_STREAM_LINES;
  return TOOL_STREAM_MARGIN_ROWS + TOOL_STREAM_HEADER_ROWS + contentRows;
}

/**
 * Build the CONSTANT-height content block for the live tool-stream box: always
 * exactly `maxLines` rows, newest-pinned-to-bottom, every line truncated to
 * `contentWidth` so nothing wraps. Holding the row count fixed is what stops the
 * live region from growing (and thus scrolling the terminal + leaking the header
 * into scrollback) as output streams in. Pure + exported for testing.
 */
export function streamBoxRows(
  text: string,
  maxLines: number,
  contentWidth: number,
): Array<{ text: string; italic?: boolean | undefined }> {
  const trunc = (line: string) => truncateDisplay(line, contentWidth);
  const lines = sanitizeTerminalText(text).split('\n');
  const totalLines = lines.length;
  const hidden = Math.max(0, totalLines - maxLines);
  const rows: Array<{ text: string; italic?: boolean | undefined }> = [];
  if (hidden > 0) {
    rows.push({ text: `  … ${hidden} more line${hidden === 1 ? '' : 's'} above`, italic: true });
    for (const line of lines.slice(totalLines - (maxLines - 1))) rows.push({ text: trunc(line) });
  } else {
    for (let i = 0; i < maxLines - totalLines; i++) rows.push({ text: '' });
    for (const line of lines) rows.push({ text: trunc(line) });
  }
  return rows;
}

export const ToolStreamBox = React.memo(function ToolStreamBox({
  name,
  text,
  startedAt,
  termWidth,
}: {
  name: string;
  text: string;
  startedAt: number;
  termWidth: number;
}): React.ReactElement {
  const { glyph, color } = getToolVisual(name);
  // This box only exists for an active tool; share its elapsed-time clock with
  // every other Ink animation instead of owning another interval.
  useAnimation({ interval: 1_000 });

  const elapsedMs = Date.now() - startedAt;
  const safeName = sanitizeTerminalText(name);
  const streamLines = name === 'write' ? WRITE_CREATE_STREAM_LINES : MAX_STREAM_LINES;
  const totalLines = text.split('\n').length;
  const hidden = Math.max(0, totalLines - streamLines);
  const contentWidth = Math.max(1, Math.min(termWidth - 4, 100));
  // Constant-height content block (see streamBoxRows): the live region must not
  // grow row-by-row as output streams, or it scrolls the terminal and leaks the
  // "◆ <tool> ⏱ …" header into scrollback on every update in inline mode.
  const rows = streamBoxRows(text, streamLines, contentWidth);
  const isWritePreview = name === 'write';

  return (
    <Box
      flexDirection="column"
      marginY={1}
      borderStyle="single"
      borderTop={false}
      borderRight={false}
      borderBottom={false}
      borderColor={color}
      paddingLeft={1}
    >
      <Box flexDirection="row">
        <Text color={color}>{glyph} </Text>
        <Text bold color={color}>
          {isWritePreview ? 'write · creating file' : safeName}
        </Text>
        <Text dimColor>{`  ⏱ ${fmtDuration(elapsedMs)}`}</Text>
        {hidden > 0 ? (
          <Text dimColor>{`  (${totalLines} lines, showing last ${streamLines})`}</Text>
        ) : null}
      </Box>
      <Box flexDirection="column" marginLeft={1}>
        {rows.map((r, i) => (
          <Text
            key={i}
            color={isWritePreview ? 'gray' : undefined}
            dimColor={!isWritePreview}
            italic={Boolean(r.italic)}
          >
            {r.text || ' '}
          </Text>
        ))}
      </Box>
    </Box>
  );
});

export const AssistantStreamBox = React.memo(function AssistantStreamBox({
  text,
  termWidth,
}: {
  text: string;
  termWidth: number;
}): React.ReactElement {
  const contentWidth = Math.max(1, Math.min(termWidth - 4, 100));
  const totalLines = text.split('\n').length;
  const hidden = Math.max(0, totalLines - ASSISTANT_STREAM_LINES);
  const rows = streamBoxRows(text, ASSISTANT_STREAM_LINES, contentWidth);
  const color = theme.assistant ?? 'cyan';

  return (
    <Box
      flexDirection="column"
      marginY={1}
      borderStyle="single"
      borderTop={false}
      borderRight={false}
      borderBottom={false}
      borderColor={color}
      paddingLeft={1}
    >
      <Box flexDirection="row">
        <Text color={color}>✦ </Text>
        <Text bold color={color}>
          assistant · streaming
        </Text>
        {hidden > 0 ? (
          <Text dimColor>{`  (${totalLines} lines, showing last ${ASSISTANT_STREAM_LINES})`}</Text>
        ) : null}
      </Box>
      <Box flexDirection="column" marginLeft={1}>
        {rows.map((r, i) => (
          <Text key={i} color="white" italic={Boolean(r.italic)}>
            {r.text || ' '}
          </Text>
        ))}
      </Box>
    </Box>
  );
});

export function tailForDisplay(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.length - maxChars;
  const nl = text.indexOf('\n', cut);
  if (nl !== -1 && nl < cut + 80) {
    return `… ${text.slice(nl + 1)}`;
  }
  return `… ${text.slice(cut)}`;
}
