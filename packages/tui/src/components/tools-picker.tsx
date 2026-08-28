import type React from 'react';
import { useTerminalSize } from '../hooks/use-terminal-size.js';
import { Box, Text } from '../ink.js';

export interface ToolPickerItem {
  name: string;
  owner: string;
  category: string;
  enabled: boolean;
  exposure: 'direct' | 'lazy' | 'disabled';
  mutating: boolean;
  permission: string;
  descMode: 'extend' | 'simple';
  description: string;
}

interface ToolsPickerProps {
  items: ToolPickerItem[];
  selected: number;
  busy?: boolean | undefined;
  hint?: string | undefined;
  filter?: string | undefined;
}

/**
 * Rows of terminal chrome around the visible item window.
 */
const CHROME_ROWS = 15;

/**
 * Hard ceiling on how many tool rows are rendered at once. Smaller terminals
 * already see fewer rows via `max(6, termRows - CHROME_ROWS)`; on tall
 * terminals this cap prevents the picker from monopolising the viewport.
 * Overflowing rows remain reachable via ↑/↓ (the window re-centres on the
 * selection) with `↑ N more` / `↓ N more` indicators.
 */
const MAX_PICKER_ITEMS = 15;

function toolActionLabel(enabled: boolean): string {
  return enabled ? 'Enter disables this tool' : 'Enter re-enables this tool';
}

/** Distinguish direct provider schemas from lazy catalog entries and disabled tools. */
function statusBadge(exposure: ToolPickerItem['exposure']): React.ReactElement {
  if (exposure === 'direct') return <Text color="green">● direct</Text>;
  if (exposure === 'lazy') return <Text color="cyan">◇ lazy</Text>;
  return <Text color="red">○ disabled</Text>;
}

/** Colourise the mutating/read-only badge. */
function rwBadge(mutating: boolean): React.ReactElement {
  return mutating ? <Text color="yellow">mut</Text> : <Text color="cyan">ro</Text>;
}

/**
 * Normalise a category string for display. Returns "Other" for falsy/empty values.
 */
function displayCategory(cat: string | undefined | null): string {
  if (!cat || cat.trim() === '') return 'Other';
  return cat.charAt(0).toUpperCase() + cat.slice(1);
}

type Row = { item: ToolPickerItem; index: number };

type ColumnWidths = {
  name: number;
  category: number;
  owner: number;
  permission: number;
};

const DEFAULT_COLUMN_WIDTHS: ColumnWidths = {
  name: 28,
  category: 16,
  owner: 31,
  permission: 8,
};

const MIN_COLUMN_WIDTHS: ColumnWidths = {
  name: 22,
  category: 13,
  owner: 20,
  permission: 7,
};

function shrinkColumn(widths: ColumnWidths, column: keyof ColumnWidths, overflow: number): number {
  const room = widths[column] - MIN_COLUMN_WIDTHS[column];
  const shrinkBy = Math.min(room, overflow);
  widths[column] -= shrinkBy;
  return overflow - shrinkBy;
}

function columnWidthsFor(columns: number): ColumnWidths {
  const widths = { ...DEFAULT_COLUMN_WIDTHS };
  const rowChromeWidth = 30;
  const availableVariableWidth = Math.max(
    Object.values(MIN_COLUMN_WIDTHS).reduce((sum, width) => sum + width, 0),
    columns - rowChromeWidth,
  );
  const desiredVariableWidth = Object.values(widths).reduce((sum, width) => sum + width, 0);
  let overflow = desiredVariableWidth - availableVariableWidth;

  for (const column of ['owner', 'category', 'name', 'permission'] as const) {
    if (overflow <= 0) break;
    overflow = shrinkColumn(widths, column, overflow);
  }

  return widths;
}

function fitCell(value: string, width: number): string {
  if (width <= 0) return '';
  if (value.length > width) {
    return `${value.slice(0, Math.max(0, width - 1))}…`;
  }
  return value.padEnd(width);
}

/**
 * Build one render row per tool. Category is displayed as row metadata,
 * not as an inserted heading, so selection and scroll math stay aligned
 * with the actual tool list.
 */
function buildRows(items: ToolPickerItem[]): Row[] {
  return items.map((item, index) => ({ item, index }));
}

/** Window rows around the selected item without inserting non-tool rows. */
function windowRows(
  rows: Row[],
  focus: number,
  max: number,
): { rows: Row[]; start: number; end: number } {
  if (rows.length <= max) {
    return { rows, start: 0, end: rows.length };
  }
  let start = focus - Math.floor(max / 2);
  if (start < 0) start = 0;
  let end = start + max;
  if (end > rows.length) {
    end = rows.length;
    start = end - max;
  }
  return { rows: rows.slice(start, end), start, end };
}

export function ToolsPicker({
  items,
  selected,
  busy = false,
  hint,
  filter,
}: ToolsPickerProps): React.ReactElement {
  const { columns: termColumns, rows: termRows } = useTerminalSize({
    fallbackColumns: 100,
    fallbackRows: 24,
  });
  const columnWidths = columnWidthsFor(termColumns);

  const maxVisible = Math.min(MAX_PICKER_ITEMS, Math.max(6, termRows - CHROME_ROWS));
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
  const directCount = items.filter((item) => item.exposure === 'direct').length;
  const lazyCount = items.filter((item) => item.exposure === 'lazy').length;
  const disabledCount = items.filter((item) => item.exposure === 'disabled').length;
  const selectedItem = visibleItems[visibleSelected];

  // Apply the visible-window cap regardless of filter state. The original
  // implementation skipped windowing when a filter was active, which let a
  // single matching prefix paint the entire catalogue on tall terminals.
  // Filtering still keeps the focused row in view because windowRows()
  // re-centres on `visibleSelected`.
  const win = windowRows(rows, visibleSelected, maxVisible);
  const displayRows = win.rows;
  const hiddenAbove = win.start;
  const hiddenBelow = rows.length - win.end;

  const hasFilter = filterActive;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="green" paddingX={1}>
      <Text bold color="green">
        ━━ Tools ━━
      </Text>
      <Text dimColor>
        {hasFilter
          ? `Filter: ${filter} (${visibleItems.length} match${visibleItems.length === 1 ? '' : 'es'}) · Backspace edit · Esc clear`
          : `↑/↓ select · type to filter · Enter toggles · Esc close · ${directCount} direct / ${lazyCount} lazy / ${disabledCount} disabled`}
      </Text>
      <Text dimColor>
        Lazy tools stay executable through discovery gateways without sending every schema to the
        provider.
      </Text>
      <Box marginTop={1} flexDirection="column">
        {total === 0 ? (
          <Text dimColor>{busy ? 'Loading tools…' : 'No tools registered.'}</Text>
        ) : visibleItems.length === 0 ? (
          <Text dimColor>No tools match "{filter}".</Text>
        ) : (
          <>
            {hiddenAbove > 0 ? <Text dimColor>{`  ↑ ${hiddenAbove} more`}</Text> : null}
            {displayRows.map(({ item, index }) => {
              const focused = index === visibleSelected;
              return (
                <Text
                  key={item.name}
                  inverse={focused}
                  {...(focused ? { color: 'green' } : {})}
                  wrap="truncate-end"
                >
                  {focused ? '› ' : '  '}
                  {statusBadge(item.exposure)}{' '}
                  <Text bold>{fitCell(item.name, columnWidths.name)}</Text>{' '}
                  <Text dimColor>
                    {fitCell(displayCategory(item.category), columnWidths.category)}{' '}
                    {fitCell(`[${item.owner}]`, columnWidths.owner)} {rwBadge(item.mutating)}{' '}
                    {fitCell(item.permission, columnWidths.permission)}{' '}
                    <Text color={item.descMode === 'simple' ? 'yellow' : undefined}>
                      desc:{item.descMode}
                    </Text>
                  </Text>
                </Text>
              );
            })}
            {hiddenBelow > 0 ? <Text dimColor>{`  ↓ ${hiddenBelow} more`}</Text> : null}
          </>
        )}
      </Box>
      {selectedItem ? (
        <Box marginTop={1} flexDirection="column">
          <Text>
            <Text color={selectedItem.enabled ? 'green' : 'red'}>
              {toolActionLabel(selectedItem.enabled)}
            </Text>
            <Text
              dimColor
            >{` · ${selectedItem.mutating ? 'Mutating' : 'Read-only'} · permission: ${selectedItem.permission} · descriptions: ${selectedItem.descMode}`}</Text>
          </Text>
          <Text dimColor wrap="truncate-end">
            {selectedItem.description || 'No description provided.'}
          </Text>
        </Box>
      ) : null}
      {hint ? (
        <Box marginTop={1}>
          <Text dimColor>{hint}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
