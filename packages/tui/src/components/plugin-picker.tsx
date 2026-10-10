import type React from 'react';
import { useTerminalSize } from '../hooks/use-terminal-size.js';
import { useWindowedPicker } from '../hooks/use-windowed-picker.js';
import { Box, Text } from '../ink.js';
import { displayWidth } from '../terminal-width.js';

export interface PluginPickerItem {
  name: string;
  enabled: boolean;
  risk: 'low' | 'medium' | 'high';
  summary: string;
  /**
   * When false the row is locked: the picker renders a 🔒 marker and ignores
   * Enter/←/→ on it. The current built-in audit list is fully toggleable, but
   * the component keeps this marker for future or externally supplied locked
   * rows.
   */
  lockable?: boolean | undefined;
}

interface PluginPickerProps {
  maxRows?: number | undefined;
  columns?: number | undefined;
  items: PluginPickerItem[];
  selected: number;
  busy?: boolean | undefined;
  hint?: string | undefined;
}

/**
 * Hard ceiling on how many plugin rows are rendered at once. Smaller terminals
 * use the measured picker allocation; on tall terminals
 * this cap prevents the picker from monopolising the viewport. Overflowing
 * rows remain reachable via ↑/↓ (the window re-centres on the selection) with
 * `↑ N more` / `↓ N more` indicators.
 */
const MAX_PICKER_ITEMS = 15;

/** Border/padding + selection cursor around the longest list-row name. */
const LIST_NAME_CHROME = 6;
/** Border/padding around the longest name rendered as the detail heading. */
const DETAIL_NAME_CHROME = 4;
const PANE_GAP_COLUMNS = 1;
/** Round border (2) + horizontal padding (2) consumed by every pane row. */
const PANE_CHROME_COLUMNS = 4;
const MIN_LIST_COLUMN_WIDTH = 34;
const MIN_DETAIL_COLUMN_WIDTH = 40;
const DETAIL_MIN_ROWS = 12;

export function PluginPicker({
  items,
  selected,
  busy = false,
  hint,
  maxRows,
  columns,
}: PluginPickerProps): React.ReactElement {
  const size = useTerminalSize();
  const budget = maxRows ?? Math.max(8, size.rows - 6);
  const compact = budget < 12;

  // Height-aware scrolling window centred on the selection — small terminals
  // get a short window with ↑/↓ overflow indicators instead of an overflowing
  // (and Ink-clipped) full list.
  const total = items.length;
  const hasLockedRows = items.some((item) => item.lockable === false);

  // Column widths for the two-pane split — mirrors the SkillPicker idiom.
  // Without a two-pane split we keep the legacy single-pane full-width
  // rendering so the existing tests (and any narrow terminals) are
  // unaffected.
  const longestNameColumns = items.reduce(
    (longest, item) => Math.max(longest, Array.from(item.name).length),
    0,
  );
  const availableColumns = columns ?? size.columns;
  // List column width tracks the actual longest name + chrome so the 🔒
  // marker, risk badge, and inline `🔒 = locked` subheader hint all fit on a
  // single row in split mode. The minimum guards against empty / short-name
  // lists that would otherwise produce a cramped pane.
  const listColumnWidth = Math.max(MIN_LIST_COLUMN_WIDTH, longestNameColumns + LIST_NAME_CHROME);
  const detailMinWidth = Math.max(MIN_DETAIL_COLUMN_WIDTH, longestNameColumns + DETAIL_NAME_CHROME);
  const split =
    availableColumns >= listColumnWidth + detailMinWidth + PANE_GAP_COLUMNS &&
    total > 0 &&
    (maxRows === undefined || maxRows >= DETAIL_MIN_ROWS);
  const nameColumns = split ? listColumnWidth - LIST_NAME_CHROME : longestNameColumns;
  // When splitting, cap the list at the same budget the detail pane uses so
  // the two panes stay the same height. The single-pane path keeps the
  // generous 15-row ceiling.
  const listMaxRows =
    split && maxRows !== undefined ? Math.min(maxRows, MAX_PICKER_ITEMS) : maxRows;

  const { start: windowStart, end: windowEnd } = useWindowedPicker({
    total,
    selected,
    maxRows: listMaxRows ?? Math.min(budget, MAX_PICKER_ITEMS + 9),
    chromeRows: 4 + (compact ? 0 : 1) + (hint ? (compact ? 1 : 2) : 0),
    markerRows: 2,
  });
  const above = windowStart;
  const below = total - windowEnd;

  const safeSelected = Math.max(0, Math.min(selected, total - 1));
  const selectedItem = total > 0 ? items[safeSelected] : undefined;
  // Subheader text — always includes `↑/↓ select · Enter/←/→ toggle · Esc close`
  // so the existing viewport tests can match all four tokens regardless of
  // terminal width. The inline `🔒 = locked` token is only added when the
  // pane is wide enough (single-pane, ≥70 cols); on narrow panes it surfaces
  // as a dedicated row below the subheader instead. In both modes the list
  // row still carries the per-row `🔒` marker so per-row lock-marker
  // assertions remain green.
  const hasRoomForFullHint = (columns ?? size.columns) >= 70 && !split;
  // The subheader renders with `truncate-end`, so on a narrow pane (the 32-col
  // list column of the split layout) the long form loses its tail — including
  // the only `Esc` affordance. Step down through shorter forms and pick the
  // first that fits the pane's content width; the shortest still names Esc.
  const subheaderWidth =
    (split ? listColumnWidth : (columns ?? size.columns)) - PANE_CHROME_COLUMNS;
  const subheaderCandidates = [
    ...(hasRoomForFullHint && hasLockedRows
      ? ['↑/↓ select · Enter/←/→ toggle · 🔒 = locked · Esc close']
      : []),
    '↑/↓ select · Enter/←/→ toggle · Esc close',
    '↑/↓ select · Enter toggle · Esc close',
    '↑/↓ · Enter toggle · Esc',
  ];
  const shortestSubheader = '↑/↓ · Enter · Esc';
  const subheaderText =
    subheaderCandidates.find((text) => displayWidth(text) <= subheaderWidth) ?? shortestSubheader;
  const showInlineLockedHint = hasRoomForFullHint && hasLockedRows && subheaderText.includes('🔒');

  const list = (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      {...(split ? { width: listColumnWidth, flexShrink: 0 } : {})}
    >
      <Text bold color="cyan">
        Plugin menu
      </Text>
      <Text dimColor wrap="truncate-end">
        {subheaderText}
      </Text>
      {hasLockedRows && !showInlineLockedHint && !compact ? (
        <Text dimColor wrap="truncate-end">
          🔒 = locked
        </Text>
      ) : null}
      <Box marginTop={compact ? 0 : 1} flexDirection="column">
        {items.length === 0 ? (
          <Text dimColor>{busy ? 'Loading plugins…' : 'No plugins available.'}</Text>
        ) : (
          <>
            {above > 0 ? <Text dimColor>{`  ↑ ${above} more`}</Text> : null}
            {items.slice(windowStart, windowEnd).map((item, i) => {
              const index = windowStart + i;
              const focused = index === selected;
              const marker = focused ? '›' : ' ';
              const isLocked = item.lockable === false;
              const state = item.enabled ? '● on ' : '○ off';
              const color = item.enabled ? 'green' : 'gray';
              // The 🔒 lives in its own column after the name (not inside the
              // on/off column) so the state column stays uniform. The emoji
              // occupies 2 cells, so the unlocked filler is 2 spaces.
              const lock = isLocked ? '🔒' : '  ';
              // The 🔒 marker stays on every row in both modes — it's the
              // strongest at-a-glance signal that a row is non-toggleable.
              // The trailing summary moves to the right pane at full width in
              // split mode (where the list row is narrower); the single-pane
              // path keeps the original 18-cell name pad + trailing summary.
              if (split) {
                // Split-mode row drops the trailing `risk=` (the right pane
                // already surfaces `risk=<level>` as a colour-coded badge)
                // so the per-row `🔒` marker stays visible without
                // `wrap="truncate-end"` clipping it. The marker + state +
                // padded name + 🔒 column is the at-a-glance scanning row.
                return (
                  <Text key={item.name} color={focused ? 'cyan' : undefined} wrap="truncate-end">
                    {marker} <Text color={color}>{state}</Text> {item.name.padEnd(nameColumns)}{' '}
                    <Text color={isLocked ? 'yellow' : undefined}>{lock}</Text>
                  </Text>
                );
              }
              return (
                <Text key={item.name} color={focused ? 'cyan' : undefined} wrap="truncate-end">
                  {marker} <Text color={color}>{state}</Text> {item.name.padEnd(18)}{' '}
                  <Text color={isLocked ? 'yellow' : undefined}>{lock}</Text>{' '}
                  <Text dimColor>risk={item.risk.padEnd(6)}</Text> {item.summary}
                </Text>
              );
            })}
            {below > 0 ? <Text dimColor>{`  ↓ ${below} more`}</Text> : null}
          </>
        )}
      </Box>
      {hint ? (
        <Box marginTop={compact ? 0 : 1}>
          <Text dimColor wrap="truncate-end">
            {hint}
          </Text>
        </Box>
      ) : null}
    </Box>
  );

  if (!split || !selectedItem) return list;

  return (
    <Box flexDirection="row">
      {list}
      <PluginDetail
        item={selectedItem}
        columns={availableColumns - listColumnWidth - PANE_GAP_COLUMNS}
        maxRows={maxRows}
      />
    </Box>
  );
}

function PluginDetail({
  item,
  columns,
  maxRows,
}: {
  item: PluginPickerItem;
  columns: number;
  maxRows?: number | undefined;
}): React.ReactElement {
  const isLocked = item.lockable === false;
  const stateLabel = item.enabled ? '● enabled' : '○ disabled';
  const stateColor = item.enabled ? 'green' : 'gray';
  const riskColor = item.risk === 'high' ? 'red' : item.risk === 'medium' ? 'yellow' : 'gray';
  const contentColumns = Math.max(20, columns - 4);
  // Word-wrap the summary into a fixed number of lines so the detail panel's
  // height never changes as the user navigates between plugins with
  // different summary lengths — same idiom the /skill picker uses for its
  // trigger block.
  const summaryLines = Math.max(3, Math.min(8, (maxRows ?? DETAIL_MIN_ROWS) - 8));
  const summaryWrapped = wrapText(item.summary || '(no summary)', contentColumns, summaryLines);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} flexGrow={1}>
      <Text bold color="cyan" wrap="truncate-end">
        {item.name}
      </Text>
      <Box gap={1} flexWrap="wrap">
        <Text color={stateColor} bold>
          {stateLabel}
        </Text>
        <Text color={riskColor} bold>
          risk={item.risk}
        </Text>
        {isLocked ? (
          <Text color="yellow" bold>
            🔒 locked
          </Text>
        ) : (
          <Text dimColor>toggleable</Text>
        )}
      </Box>
      <Text> </Text>
      <Text dimColor>summary</Text>
      {summaryWrapped.map((line, i) => (
        <Text key={`summary-${i}`} wrap="truncate-end">
          {line.length > 0 ? line : ' '}
        </Text>
      ))}
      {Array.from({ length: summaryLines - summaryWrapped.length }).map((_, i) => (
        <Text key={`summary-pad-${i}`}> </Text>
      ))}
      <Text> </Text>
      {isLocked ? (
        <Text dimColor wrap="truncate-end">
          Locked rows ignore Enter / ← / → — see `/plugin report` for details.
        </Text>
      ) : (
        <Text dimColor wrap="truncate-end">
          Enter / ← / → toggles this plugin on or off.
        </Text>
      )}
    </Box>
  );
}

/**
 * Word-wrap `text` into at most `maxLines` lines of at most `columns`
 * characters each. Excess content is ellipsized on the last line so the
 * detail panel's height stays fixed regardless of summary length.
 */
function wrapText(text: string, columns: number, maxLines: number): string[] {
  if (text.length === 0) return [''];
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (lines.length >= maxLines) break;
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (candidate.length <= columns) {
      current = candidate;
      continue;
    }
    if (current.length > 0) {
      lines.push(current);
      current = word;
    } else {
      // Word longer than the column budget — hard-truncate it.
      lines.push(word.slice(0, columns));
      current = '';
    }
  }
  if (current.length > 0 && lines.length < maxLines) {
    lines.push(current);
  }
  if (lines.length === maxLines) {
    const joined = text.split(/\s+/).join(' ');
    const consumed = lines.join(' ').length;
    if (consumed < joined.length) {
      const last = lines[maxLines - 1] ?? '';
      const truncated = last.length > columns - 1 ? last.slice(0, columns - 1) + '…' : `${last}…`;
      lines[maxLines - 1] = truncated;
    }
  }
  return lines;
}
