import type { SkillEntry } from '@wrongstack/core/types';
import type React from 'react';
import { useWindowedPicker } from '../hooks/use-windowed-picker.js';
import { Box, Text } from '../ink.js';
import { wrapRefinementPreview } from './enhance-panel.js';

interface SkillPickerProps {
  entries: readonly SkillEntry[];
  selected: number;
  hint?: string | undefined;
  columns?: number | undefined;
  maxRows?: number | undefined;
}

/** Interactive two-pane skill browser, matching the `/theme` picker layout. */
export function SkillPicker({
  entries,
  selected,
  hint,
  columns = 0,
  maxRows,
}: SkillPickerProps): React.ReactElement {
  const longestNameColumns = entries.reduce(
    (longest, entry) => Math.max(longest, Array.from(entry.name).length),
    0,
  );
  const listColumnWidth = Math.max(MIN_LIST_COLUMN_WIDTH, longestNameColumns + LIST_NAME_CHROME);
  const detailMinWidth = Math.max(MIN_DETAIL_COLUMN_WIDTH, longestNameColumns + DETAIL_NAME_CHROME);
  const split =
    columns >= listColumnWidth + detailMinWidth + PANE_GAP_COLUMNS &&
    entries.length > 0 &&
    (maxRows === undefined || maxRows >= DETAIL_MIN_ROWS);
  const nameColumns = split ? listColumnWidth - LIST_NAME_CHROME : longestNameColumns;
  const listMaxRows =
    split && maxRows !== undefined ? Math.min(maxRows, DETAIL_FULL_ROWS) : maxRows;
  const { start, end, hasAbove, hasBelow } = useWindowedPicker({
    total: entries.length,
    selected,
    chromeRows: 4,
    markerRows: 3,
    maxRows: listMaxRows,
  });
  const visible = entries.slice(start, end);
  const safeSelected = Math.max(0, Math.min(selected, entries.length - 1));
  const selectedEntry = entries[safeSelected];

  const list = (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="magenta"
      paddingX={1}
      {...(split ? { width: listColumnWidth, flexShrink: 0 } : {})}
    >
      <Text color="cyan" bold>
        ━━ Skills ━━
      </Text>
      <Text dimColor>↑/↓ navigate · Enter open · Esc cancel</Text>
      {hasAbove ? <Text dimColor> … {start} more above</Text> : null}
      {visible.map((entry, offset) => {
        const index = start + offset;
        const isSelected = index === safeSelected;
        return (
          <Text
            key={`${entry.source}:${entry.name}`}
            inverse={isSelected}
            {...(isSelected ? { color: 'cyan' } : {})}
          >
            {isSelected ? '› ' : '  '}
            <Text bold>{entry.name.padEnd(nameColumns)}</Text>
            {split ? null : <Text dimColor>{truncate(entry.trigger, 44)}</Text>}
          </Text>
        );
      })}
      {hasBelow ? <Text dimColor> … {entries.length - end} more below</Text> : null}
      {entries.length === 0 ? <Text dimColor>No skills found.</Text> : null}
      {hint ? <Text color="yellow">{hint}</Text> : null}
    </Box>
  );

  if (!split || !selectedEntry) return list;

  return (
    <Box flexDirection="row">
      {list}
      <SkillDetail
        entry={selectedEntry}
        columns={columns - listColumnWidth - PANE_GAP_COLUMNS}
        maxRows={maxRows}
      />
    </Box>
  );
}

function SkillDetail({
  entry,
  columns,
  maxRows,
}: {
  entry: SkillEntry;
  columns: number;
  maxRows?: number | undefined;
}): React.ReactElement {
  const showPath = maxRows === undefined || maxRows >= 11;
  const contentColumns = Math.max(20, columns - 4);
  const triggerLines = Math.max(1, Math.min(4, (maxRows ?? DETAIL_FULL_ROWS) - 10));
  // Pre-wrap the trigger into a FIXED number of lines so the detail panel's
  // height never changes as the user navigates between skills with different
  // trigger lengths — same idiom the /model picker uses for its model preview.
  // wrapRefinementPreview is word-aware, caps at triggerLines, and ellipsizes
  // overflow, so a one-line trigger and a four-line trigger occupy the same
  // height (the remainder is padded with blank lines below).
  const triggerWrapped = wrapRefinementPreview(
    entry.trigger || '(not specified)',
    contentColumns,
    triggerLines,
  );
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1} flexGrow={1}>
      <Text color="cyan" bold wrap="truncate-end">
        {entry.name}
      </Text>
      <Text dimColor>use when</Text>
      {triggerWrapped.map((line, i) => (
        <Text key={`trig-${i}`} wrap="truncate-end">
          {line}
        </Text>
      ))}
      {/* Pad remaining trigger slots so every skill's panel is the same height. */}
      {Array.from({ length: triggerLines - triggerWrapped.length }).map((_, i) => (
        <Text key={`trig-pad-${i}`}> </Text>
      ))}
      <Text> </Text>
      <Text wrap="truncate-end">
        <Text dimColor>scope: </Text>
        {entry.scope.length > 0 ? entry.scope.join(', ') : '(none)'}
      </Text>
      <Text wrap="truncate-end">
        <Text dimColor>source: </Text>
        {entry.source}
        {entry.originTool ? ` (${entry.originTool})` : ''}
      </Text>
      {showPath ? (
        <Text wrap="truncate-end">
          <Text dimColor>path: </Text>
          {entry.path}
        </Text>
      ) : null}
      <Text> </Text>
      <Text dimColor>Enter opens the full skill instructions</Text>
    </Box>
  );
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Border/padding + selection cursor around the longest list-row name. */
const LIST_NAME_CHROME = 6;
/** Border/padding around the longest name rendered as the detail heading. */
const DETAIL_NAME_CHROME = 4;
const PANE_GAP_COLUMNS = 1;
const MIN_LIST_COLUMN_WIDTH = 34;
const MIN_DETAIL_COLUMN_WIDTH = 40;
const DETAIL_MIN_ROWS = 12;
const DETAIL_FULL_ROWS = 14;
