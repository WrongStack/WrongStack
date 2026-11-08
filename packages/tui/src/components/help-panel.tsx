import type React from 'react';
import { useTerminalSize } from '../hooks/use-terminal-size.js';
import { Box, Text } from '../ink.js';

export interface HelpEntry {
  name: string;
  description: string;
  category: string;
  aliases?: string[] | undefined;
  argsHint?: string | undefined;
  help?: string | undefined;
}

export interface HelpPanelProps {
  entries: HelpEntry[];
  filter: string;
  selected: number;
  hint?: string | undefined;
  maxRows?: number | undefined;
  detailScroll?: number | undefined;
}

const CATEGORY_ORDER = ['Run', 'Session', 'Inspect', 'Agent', 'Config', 'App'];
const MAX_PANEL_HEIGHT = 26;
const MIN_PANEL_HEIGHT = 8;

type Row = { type: 'header'; category: string } | { type: 'item'; entry: HelpEntry; index: number };

function normalizeQuery(raw: string): string {
  return raw.trim().toLowerCase();
}

function buildRows(entries: HelpEntry[]): Row[] {
  const rows: Row[] = [];
  let lastCat = '';
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i] as HelpEntry;
    const cat = e.category || 'App';
    if (cat !== lastCat) {
      lastCat = cat;
      rows.push({ type: 'header', category: cat });
    }
    rows.push({ type: 'item', entry: e, index: i });
  }
  return rows;
}

function windowRows(rows: Row[], focus: number, max: number) {
  if (rows.length <= max) {
    return { rows, start: 0, end: rows.length, contextHeader: null as string | null };
  }
  let start = focus - Math.floor(max / 2);
  if (start < 0) start = 0;
  let end = start + max;
  if (end > rows.length) {
    end = rows.length;
    start = end - max;
  }
  let contextHeader: string | null = null;
  if (start > 0) {
    const first = rows[start];
    if (first && first.type === 'item') {
      for (let i = start - 1; i >= 0; i--) {
        const r = rows[i];
        if (r && r.type === 'header') {
          contextHeader = r.category;
          break;
        }
      }
    }
  }
  return { rows: rows.slice(start, end), start, end, contextHeader };
}

export function HelpPanel({
  entries,
  filter,
  selected,
  hint,
  maxRows,
  detailScroll,
}: HelpPanelProps): React.ReactElement {
  const { rows: termRows, columns: termCols } = useTerminalSize({
    fallbackRows: 24,
    fallbackColumns: 90,
  });

  // Calculate panel height constrained by terminal height, capped at MAX_PANEL_HEIGHT (26)
  const availableBudget = maxRows !== undefined ? maxRows : termRows - 4;
  const panelHeight = Math.min(MAX_PANEL_HEIGHT, Math.max(MIN_PANEL_HEIGHT, availableBudget));

  // Chrome rows: top border (1) + bottom border (1) + title bar (1) + filter/subtitle bar (1) + hint (if present)
  const chromeRows = 4 + (hint ? 1 : 0);
  const bodyHeight = Math.max(3, panelHeight - chromeRows);

  const query = normalizeQuery(filter);
  const filtered = query
    ? entries.filter(
        (e) =>
          e.name.toLowerCase().includes(query) ||
          e.description.toLowerCase().includes(query) ||
          e.category.toLowerCase().includes(query) ||
          (e.aliases ?? []).some((a) => a.toLowerCase().includes(query)),
      )
    : [...entries];

  // Sort filtered by category order then name
  filtered.sort((a, b) => {
    const ai = CATEGORY_ORDER.indexOf(a.category);
    const bi = CATEGORY_ORDER.indexOf(b.category);
    if (ai !== bi) return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    return a.name.localeCompare(b.name);
  });

  const focus = Math.min(selected, Math.max(0, filtered.length - 1));
  const selectedEntry = filtered.length > 0 ? filtered[focus] : undefined;

  const rows = buildRows(filtered);
  const selectedRowIdx = rows.findIndex((r) => r.type === 'item' && r.index === focus);
  const win = windowRows(rows, Math.max(selectedRowIdx, 0), bodyHeight);
  const { rows: visible, start, end, contextHeader } = win;
  const hiddenAbove = start;
  const hiddenBelow = rows.length - end;
  const hasFilter = query.length > 0;

  // Width distribution between Left Column (Commands List) and Right Column (Full Command Help)
  const contentWidth = Math.max(48, termCols - 4);
  const leftWidth = Math.max(22, Math.min(30, Math.floor(contentWidth * 0.32)));
  const rightWidth = Math.max(22, contentWidth - leftWidth - 3);

  // Maximum lines available for detailed help block in the right column
  // (bodyHeight minus 3 rows for title, usage, and summary description)
  const maxHelpLines = Math.max(2, bodyHeight - 3);
  const allHelpLines = selectedEntry?.help ? selectedEntry.help.split('\n') : [];
  const maxScroll = Math.max(0, allHelpLines.length - maxHelpLines);
  const currentScroll = Math.min(maxScroll, Math.max(0, detailScroll ?? 0));
  const helpLines = allHelpLines.slice(currentScroll, currentScroll + maxHelpLines);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      height={panelHeight}
      flexShrink={0}
    >
      {/* Header bar */}
      <Box justifyContent="space-between">
        <Text bold color="cyan">
          ━━ Help / Command Palette ━━
        </Text>
        <Text dimColor>↑/↓ list · PgUp/PgDn scroll detail · Esc close</Text>
      </Box>

      {/* Subheader / Filter query bar */}
      <Box justifyContent="space-between">
        <Text dimColor>
          {hasFilter
            ? `Filter: ${filter} (${filtered.length} match${filtered.length === 1 ? '' : 'es'})`
            : 'Type to filter commands…'}
        </Text>
        {selectedEntry ? (
          <Text dimColor>
            {focus + 1}/{filtered.length}
          </Text>
        ) : null}
      </Box>

      {/* 2-Column Split: Left = Scrollable List, Right = Complete Single Command Help */}
      <Box flexDirection="row" height={bodyHeight} marginTop={0}>
        {/* Column 1: Left Scrollable Commands List */}
        <Box flexDirection="column" width={leftWidth} overflowY="hidden">
          {filtered.length === 0 ? (
            <Text dimColor>No commands match "{filter}".</Text>
          ) : (
            <>
              {hiddenAbove > 0 && !hasFilter ? (
                <Text dimColor>{`  ↑ ${hiddenAbove} more`}</Text>
              ) : null}
              {contextHeader && !hasFilter ? (
                <Text bold color="yellow" dimColor>
                  {'  '}
                  {contextHeader}
                </Text>
              ) : null}
              {visible.map((row) => {
                if (row.type === 'header') {
                  return (
                    <Text key={`cat-${row.category}`} bold color="yellow" dimColor>
                      {'  '}
                      {row.category}
                    </Text>
                  );
                }
                const { entry, index } = row;
                const isSelected = index === focus;
                const nameDisplay = `/${entry.name}`;
                return (
                  <Text
                    key={entry.name}
                    inverse={isSelected}
                    {...(isSelected ? { color: 'cyan' } : {})}
                    wrap="truncate-end"
                  >
                    {isSelected ? '› ' : '  '}
                    <Text bold>{nameDisplay}</Text>
                  </Text>
                );
              })}
              {hiddenBelow > 0 && !hasFilter ? (
                <Text dimColor>{`  ↓ ${hiddenBelow} more`}</Text>
              ) : null}
            </>
          )}
        </Box>

        {/* Vertical Column Divider */}
        <Box width={1} flexDirection="column" marginX={1} flexShrink={0}>
          {Array.from({ length: bodyHeight }, (_, i) => (
            <Text key={i} color="gray" dimColor>
              │
            </Text>
          ))}
        </Box>

        {/* Column 2: Right Wide Column - Complete Help of Selected Command */}
        <Box flexDirection="column" width={rightWidth} overflowY="hidden">
          {selectedEntry ? (
            <Box flexDirection="column">
              {/* Command Title + Category + Aliases + Scroll Indicator */}
              <Box justifyContent="space-between" width="100%">
                <Box gap={1} flexWrap="wrap">
                  <Text bold color="cyan">
                    /{selectedEntry.name}
                  </Text>
                  <Text bold color="yellow">
                    [{selectedEntry.category || 'App'}]
                  </Text>
                  {selectedEntry.aliases && selectedEntry.aliases.length > 0 ? (
                    <Text dimColor>({selectedEntry.aliases.map((a) => `/${a}`).join(', ')})</Text>
                  ) : null}
                </Box>
                {maxScroll > 0 ? (
                  <Text dimColor color="yellow">
                    {`[PgUp/PgDn ${currentScroll + 1}/${maxScroll + 1}]`}
                  </Text>
                ) : null}
              </Box>

              {/* Usage & Arguments Hint */}
              <Box marginTop={0}>
                <Text color="green">Usage: </Text>
                <Text bold color="white" wrap="truncate-end">
                  /{selectedEntry.name}
                  {selectedEntry.argsHint ? ` ${selectedEntry.argsHint}` : ''}
                </Text>
              </Box>

              {/* Summary Description */}
              <Box marginTop={0}>
                <Text bold wrap="truncate-end">
                  {selectedEntry.description}
                </Text>
              </Box>

              {/* Complete Detailed Documentation / Help */}
              {helpLines.length > 0 ? (
                <Box flexDirection="column" marginTop={0}>
                  {helpLines.map((line, idx) => (
                    <Text
                      key={idx}
                      dimColor={line.startsWith(' ') || line.startsWith('  ')}
                      color={line.trim().endsWith(':') ? 'yellow' : undefined}
                      wrap="truncate-end"
                    >
                      {line.length > 0 ? line : ' '}
                    </Text>
                  ))}
                </Box>
              ) : (
                <Box marginTop={1} flexDirection="column">
                  <Text dimColor>Type /{selectedEntry.name} to run this command.</Text>
                  {selectedEntry.argsHint ? (
                    <Text dimColor>Expected arguments: {selectedEntry.argsHint}</Text>
                  ) : null}
                </Box>
              )}
            </Box>
          ) : (
            <Box justifyContent="center">
              <Text dimColor>Select a command to view detailed help.</Text>
            </Box>
          )}
        </Box>
      </Box>

      {/* Optional footer hint */}
      {hint ? (
        <Box marginTop={0}>
          <Text dimColor>{hint}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
