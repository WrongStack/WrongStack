import { Box, Text, useStdout } from '../ink.js';
import type React from 'react';

export interface ToolPickerItem {
  name: string;
  owner: string;
  category: string;
  enabled: boolean;
  mutating: boolean;
  permission: string;
  descMode: 'extend' | 'simple';
  description: string;
}

export interface ToolsPickerProps {
  items: ToolPickerItem[];
  selected: number;
  busy?: boolean | undefined;
  hint?: string | undefined;
  filter?: string | undefined;
}

/**
 * Rows of terminal chrome around the visible item window.
 */
const CHROME_ROWS = 17;

/** Colourise the tool enable/disabled status badge. */
function statusBadge(enabled: boolean): React.ReactElement {
  return enabled ? (
    <Text color="green">● active</Text>
  ) : (
    <Text color="red">○ disabled</Text>
  );
}

/** Colourise the mutating/read-only badge. */
function rwBadge(mutating: boolean): React.ReactElement {
  return mutating ? (
    <Text color="yellow">mut</Text>
  ) : (
    <Text color="cyan">ro</Text>
  );
}

/**
 * Normalise a category string for display. Returns "Other" for falsy/empty values.
 */
function displayCategory(cat: string | undefined | null): string {
  if (!cat || cat.trim() === '') return 'Other';
  return cat.charAt(0).toUpperCase() + cat.slice(1);
}

type Row =
  | { type: 'header'; category: string }
  | { type: 'item'; item: ToolPickerItem; index: number };

/**
 * Build a flat row list with category headers interleaved. Category
 * order is the natural order of first appearance. "Other" sinks last.
 */
function buildRows(items: ToolPickerItem[]): Row[] {
  const rows: Row[] = [];
  let lastCat = '';
  for (let i = 0; i < items.length; i++) {
    const item = items[i] as ToolPickerItem;
    const cat = displayCategory(item.category);
    if (cat !== lastCat) {
      lastCat = cat;
      rows.push({ type: 'header', category: cat });
    }
    rows.push({ type: 'item', item, index: i });
  }
  return rows;
}

/**
 * Window rows around the selected item so the list scrolls and never
 * loses its category context.
 */
function windowRows(
  rows: Row[],
  focus: number,
  max: number,
): { rows: Row[]; start: number; end: number; contextHeader: string | null } {
  if (rows.length <= max) {
    return { rows, start: 0, end: rows.length, contextHeader: null };
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

export function ToolsPicker({
  items,
  selected,
  busy = false,
  hint,
  filter,
}: ToolsPickerProps): React.ReactElement {
  const { stdout } = useStdout();
  const termRows = stdout?.rows ?? 24;

  const maxVisible = Math.max(6, termRows - CHROME_ROWS);
  const total = items.length;

  let visibleItems: ToolPickerItem[];
  let visibleSelected: number;

  const filterActive = Boolean(filter && filter.length > 0);
  if (filterActive) {
    const q = filter!.toLowerCase();
    visibleItems = items.filter(
      (it) =>
        it.name.toLowerCase().includes(q) ||
        it.owner.toLowerCase().includes(q) ||
        it.description.toLowerCase().includes(q),
    );
    // Map the selected index into the filtered list
    const rawSelected = items[selected];
    visibleSelected = rawSelected ? visibleItems.indexOf(rawSelected) : 0;
    if (visibleSelected < 0) visibleSelected = 0;
  } else {
    visibleItems = items;
    visibleSelected = selected;
  }

  const rows = buildRows(visibleItems);

  // Window only when NOT filtered (in filter mode, no windowing — just slice)
  let displayRows: Row[];
  let hiddenAbove = 0;
  let hiddenBelow = 0;
  let contextHeader: string | null = null;

  if (filterActive) {
    displayRows = rows;
  } else {
    // Find the selected row index in the flat rows array
    const selectedRowIdx = rows.findIndex(
      (r) => r.type === 'item' && r.index === visibleSelected,
    );
    const win = windowRows(
      rows,
      selectedRowIdx < 0 ? 0 : selectedRowIdx,
      maxVisible,
    );
    displayRows = win.rows;
    hiddenAbove = win.start;
    hiddenBelow = rows.length - win.end;
    contextHeader = win.contextHeader;
  }

  const hasFilter = filterActive;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="green" paddingX={1}>
      <Text bold color="green">
        ━━ Tools ━━
      </Text>
      <Text dimColor>
        {hasFilter
          ? `Filter: /${filter} (${visibleItems.length} match${visibleItems.length === 1 ? '' : 'es'}) · Esc clear`
          : '↑/↓ select · Enter/←/→ toggle · `/` to search · Esc close'}
      </Text>
      <Box marginTop={1} flexDirection="column">
        {total === 0 ? (
          <Text dimColor>{busy ? 'Loading tools…' : 'No tools registered.'}</Text>
        ) : visibleItems.length === 0 ? (
          <Text dimColor>No tools match "{filter}".</Text>
        ) : (
          <>
            {hiddenAbove > 0 && !hasFilter ? (
              <Text dimColor>{`  ↑ ${hiddenAbove} more`}</Text>
            ) : null}
            {contextHeader && !hasFilter ? (
              <Text bold color="yellow" dimColor>
                {'  '}{contextHeader}
              </Text>
            ) : null}
            {displayRows.map((row) => {
              if (row.type === 'header') {
                return (
                  <Text key={`cat-${row.category}`} bold color="yellow" dimColor>
                    {'  '}{row.category}
                  </Text>
                );
              }
              const { item, index } = row;
              const focused = index === visibleSelected;
              return (
                <Text
                  key={item.name}
                  inverse={focused}
                  {...(focused ? { color: 'green' } : {})}
                  wrap="truncate-end"
                >
                  {focused ? '› ' : '  '}
                  {statusBadge(item.enabled)}{' '}
                  <Text bold>{item.name.padEnd(20)}</Text>
                  <Text dimColor>
                    {`[${item.owner}]`.padEnd(22)}
                    {rwBadge(item.mutating)} {' '}
                    {item.permission.padEnd(6)} {' '}
                    <Text color={item.descMode === 'simple' ? 'yellow' : undefined}>
                      desc:{item.descMode}
                    </Text>
                  </Text>
                </Text>
              );
            })}
            {hiddenBelow > 0 && !hasFilter ? (
              <Text dimColor>{`  ↓ ${hiddenBelow} more`}</Text>
            ) : null}
          </>
        )}
      </Box>
      {hint ? (
        <Box marginTop={1}>
          <Text dimColor>{hint}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
