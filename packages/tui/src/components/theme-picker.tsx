import type React from 'react';
import { useWindowedPicker } from '../hooks/use-windowed-picker.js';
import { Box, Text } from '../ink.js';
import type { ThemeName, ThemePickerOption } from '../theme.js';
import { ThemePreview } from './theme-preview.js';

interface ThemePickerProps {
  options: readonly ThemePickerOption[];
  selected: number;
  activeId: ThemeName;
  hint?: string | undefined;
  /**
   * Available column width for the whole picker (the main column width the
   * picker is mounted into). Below {@link SPLIT_MIN_COLUMNS} the picker
   * renders the list full-width without the preview pane — a narrow
   * terminal (or a wide sidebar) must never squeeze list rows into
   * truncated garbage just to show a preview.
   */
  columns?: number | undefined;
  /**
   * Measured vertical budget for the whole picker box (terminal rows minus
   * status bar, input, and margins — see app-view.tsx). When provided the
   * window math uses it instead of the `rows - shellReservedRows` guess,
   * which is what keeps the picker inside a 24-row terminal even when the
   * input bar or status bar grows. The preview pane is skipped when this
   * budget is too small for it to be useful.
   */
  maxRows?: number | undefined;
}

/**
 * Interactive theme picker. Mirrors the autonomy-picker visual pattern
 * (bordered box, ↑/↓ navigate, Enter apply, Esc cancel) so the two
 * pickers look and feel consistent. The currently active preset is
 * highlighted with a `[active]` marker so the user can see whether
 * their selection will actually change anything.
 *
 * The list is windowed via {@link useWindowedPicker} so 15+ presets stay
 * usable on small terminals — a top-aligned `…` marker appears when the
 * focused row is below the start of the visible window.
 *
 * On wide terminals the picker splits into two panes: the windowed list on
 * the left and a live {@link ThemePreview} on the right that renders the
 * *focused* preset's palette from its frozen snapshot. Navigating with ↑/↓
 * re-renders the preview; Enter alone applies the theme. The description
 * column is dropped from list rows in split mode — it moves into the
 * preview header, which is what frees the list to show more rows.
 */
export function ThemePicker({
  options,
  selected,
  activeId,
  hint,
  columns = 0,
  maxRows,
}: ThemePickerProps): React.ReactElement {
  const split =
    columns >= SPLIT_MIN_COLUMNS && options.length > 0 && (maxRows === undefined || maxRows >= PREVIEW_MIN_ROWS);
  // In split mode the preview's full sample tops out at PREVIEW_FULL_ROWS.
  // Cap the list at the same height so the panes stay balanced — a list that
  // grew to the whole `maxRows` budget would dwarf a preview that stopped
  // growing once all its sections fit.
  const listMaxRows = split && maxRows !== undefined ? Math.min(maxRows, PREVIEW_FULL_ROWS) : maxRows;
  const { start, end, hasAbove, hasBelow } = useWindowedPicker({
    total: options.length,
    selected,
    chromeRows: 4,
    // 2 marker slots + 1 conditional hint slot — reserve the worst case so
    // the window never overflows whether or not those rows actually render.
    markerRows: 3,
    maxRows: listMaxRows,
  });
  const visibleOptions = options.slice(start, end);
  const selectedOption = options[Math.max(0, Math.min(selected, options.length - 1))];

  const list = (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="magenta"
      paddingX={1}
      {...(split
        ? { width: LIST_COLUMN_WIDTH, flexShrink: 0 }
        : {})}
    >
      <Text color="cyan" bold>
        ━━ TUI Theme ━━
      </Text>
      <Text dimColor>↑/↓ navigate · Enter apply · Esc cancel</Text>
      {hasAbove ? <Text dimColor>  … {start} more above</Text> : null}
      {visibleOptions.map((opt, j) => {
        const i = start + j;
        const isActive = opt.id === activeId;
        const isSelected = i === selected;
        return (
          <Text key={opt.id} inverse={isSelected} {...(isSelected ? { color: 'cyan' } : {})}>
            {isSelected ? '› ' : '  '}
            <Text bold>{opt.name.padEnd(21)}</Text>
            {split ? null : <Text dimColor>{opt.description}</Text>}
            {isActive ? <Text color="green"> [active]</Text> : null}
          </Text>
        );
      })}
      {hasBelow ? (
        <Text dimColor>  … {options.length - end} more below</Text>
      ) : null}
      {hint ? <Text color="yellow">{hint}</Text> : null}
    </Box>
  );

  if (!split) {
    return list;
  }

  return (
    <Box flexDirection="row">
      {list}
      <ThemePreview
        presetId={selectedOption?.id ?? activeId}
        active={selectedOption?.id === activeId}
        columns={columns - LIST_COLUMN_WIDTH - 1}
        maxRows={maxRows}
      />
    </Box>
  );
}

/**
 * List column width in split mode: cursor (2) + name (21) + ` [active]` (9)
 * + border/padding (4) ≈ 36 columns. The description lives in the preview,
 * so the list stays narrow and the preview gets the remaining width.
 */
const LIST_COLUMN_WIDTH = 36;

/**
 * Minimum picker width before the split layout engages. Below this the
 * preview pane is dropped and the list renders full-width with its inline
 * descriptions (the pre-split behavior).
 */
const SPLIT_MIN_COLUMNS = 88;

/**
 * Minimum vertical budget before the preview pane is worth rendering. Below
 * this the picker falls back to list-only so a very short terminal never
 * gets a preview box taller than the list it sits beside.
 */
const PREVIEW_MIN_ROWS = 12;

/**
 * Full height of the preview pane when every section fits: 15 content rows
 * (sample 6 + diff 3 + syntax 2 + status 2 + palette 2) + header + 2
 * borders. In split mode the list window is capped at this so the two panes
 * top out at the same height instead of the list dwarfing the preview.
 */
const PREVIEW_FULL_ROWS = 18;
