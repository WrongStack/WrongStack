import type React from 'react';
import {
  CHIP_DESCRIPTIONS,
  DEFAULT_LINES,
  effectiveDensity,
  effectiveLine,
  LINE_SUBTITLES,
  LINE_TITLES,
  STATUSLINE_DENSITY_CYCLE,
  STATUSLINE_FIELD_COUNT,
  STATUSLINE_ITEMS,
  type StatuslineDensities,
  type StatuslineDensity,
  type StatuslineItem,
  type StatuslineLine,
  type StatuslineLines,
} from '@wrongstack/core/statusline';
import type { ChipMeta } from '../ui-contracts.js';
import { Box, Text } from '../ink.js';
import { theme } from '../theme.js';
import { glyphs } from '../ui-glyphs.js';
import { renderMeter } from './status-bar-format.js';
import type { StatusBarClickMap } from './status-bar-types.js';
import { KeyCap, MonitorShell, truncatePanelText, useMonitorSize } from './monitor-shell.js';

// Chip identity, render order, line/density assignment and descriptions live
// in the framework-free core contract (`@wrongstack/core/statusline`) — the
// single source shared with the CLI's statusline.json persistence.
// Re-exported here under the picker's historical names for its consumers.
export { CHIP_DESCRIPTIONS, DEFAULT_LINES, STATUSLINE_FIELD_COUNT, STATUSLINE_ITEMS };
export { DEFAULT_LINES as ITEM_LINE };
export type { StatuslineItem };

/**
 * Chips the composer's top rail already renders, so the status bar suppresses
 * them to avoid a double display. They stay in `STATUSLINE_ITEMS` (the mouse
 * hit-test indexes by position) and stay togglable — the picker just labels
 * them so their "on" state doesn't read as a lie.
 */
export const COMPOSER_OWNED_CHIPS: StatuslineItem[] = ['state'];

/**
 * Metadata for a temporarily-visible chip (one that appeared due to data,
 * not user toggle). Tracked so the chip can auto-expire.
 *
 * Declared in the `ui-contracts` leaf and re-exported here under the picker's
 * historical name: `status-bar-types.ts` needs the type, and owning it in a
 * `.tsx` view module put the contracts leaf and the view in one type cycle.
 */
export type { ChipMeta };

/** Default expiration for stream-triggered chips (5 minutes). */
export const STREAM_CHIP_EXPIRES_IN_MINUTES = 5;

/**
 * Returns true if a chip with the given metadata has expired.
 * Chips with no `expiresIn` never expire on their own.
 */
export function isChipExpired(meta: ChipMeta, now = Date.now()): boolean {
  if (meta.expiresIn == null || meta.expiresIn === 0) return false;
  if (meta.shownAt == null || meta.shownAt === 0) return false;
  return now >= meta.shownAt + meta.expiresIn * 60 * 1000;
}

/**
 * Returns a human-readable countdown label for a chip with expiration.
 * Returns null if the chip has no expiration or has already expired.
 */
export function getExpiresInLabel(meta: ChipMeta, now = Date.now()): string | null {
  if (meta.expiresIn == null || meta.expiresIn === 0 || meta.shownAt == null) return null;
  const remainingMs = meta.shownAt + meta.expiresIn * 60 * 1000 - now;
  if (remainingMs <= 0) return null;
  if (remainingMs < 60_000) return 'expires in <1 m';
  const remainingMin = Math.ceil(remainingMs / 60_000);
  return `expires in ${remainingMin} m`;
}

/** Stream-triggered chips — these auto-expire unless toggled on permanently. */
const STREAM_CHIP_KEYS: StatuslineItem[] = ['brain', 'mailbox', 'enhance', 'debug_stream'];

/** Next density in the cycle: auto → full → short → micro → auto. */
export function nextDensity(current: StatuslineDensity, delta = 1): StatuslineDensity {
  const index = STATUSLINE_DENSITY_CYCLE.indexOf(current);
  const size = STATUSLINE_DENSITY_CYCLE.length;
  const at = (index < 0 ? 0 : index) + delta;
  return STATUSLINE_DENSITY_CYCLE[((at % size) + size) % size]!;
}

/**
 * Whether `item` survives the picker's text filter. Matches the chip key and
 * its description so "cost" finds `cost` and "cache" finds the cache chip by
 * either its name or its blurb.
 */
export function matchesFilter(item: StatuslineItem, filter: string): boolean {
  const needle = filter.trim().toLowerCase();
  if (!needle) return true;
  return item.includes(needle) || CHIP_DESCRIPTIONS[item].toLowerCase().includes(needle);
}

/** Field indices the arrow keys may land on under the current filter. */
export function navigableFields(filter: string): number[] {
  const fields = STATUSLINE_ITEMS.map((item, index) =>
    matchesFilter(item, filter) ? index : -1,
  ).filter((index) => index >= 0);
  return fields.length > 0 ? fields : STATUSLINE_ITEMS.map((_, index) => index);
}

/** Live per-line fill measured by the StatusBar's last render. */
interface RailFill {
  used: number;
  budget: number;
  dropped: Set<string>;
  levels: Map<string, number>;
}

function readRailFills(clickMap: StatusBarClickMap | null | undefined): Map<number, RailFill> {
  const fills = new Map<number, RailFill>();
  for (const line of clickMap?.lines ?? []) {
    const logical = line.logical;
    if (logical == null) continue;
    fills.set(logical, {
      used: line.used ?? 0,
      budget: line.budget ?? 0,
      dropped: new Set(line.droppedIds ?? []),
      levels: new Map(line.spans.map((span) => [span.id, span.level])),
    });
  }
  return fills;
}

interface StatuslinePickerProps {
  /** Focused field index into STATUSLINE_ITEMS. */
  field: number;
  /** Current hidden-items list. */
  hiddenItems: StatuslineItem[];
  /** Per-chip line assignment; absent keys use DEFAULT_LINES. */
  lines?: StatuslineLines | undefined;
  /** Per-chip density pin; absent keys mean 'auto'. */
  densities?: StatuslineDensities | undefined;
  /** Temporarily-visible chips with expiration metadata. */
  visibleChips?: ChipMeta[] | undefined;
  /** Text filter over chip names and descriptions. */
  filter?: string | undefined;
  /** True while `/` filter entry is capturing keystrokes. */
  filtering?: boolean | undefined;
  /** Optional hint message from the reducer. */
  hint?: string | undefined;
  /** Last published rail geometry, used for the live fill gauges. */
  clickMap?: StatusBarClickMap | null | undefined;
}

const DENSITY_LABEL: Record<StatuslineDensity, string> = {
  auto: 'auto',
  full: 'full',
  short: 'short',
  micro: 'micro',
};

/**
 * The `/statusline` editor.
 *
 * Three things the old picker could not do, all of which the renderer and the
 * v3 config already supported with no UI to reach them: move a chip to
 * another line, pin its density, and see whether the result actually fits.
 * The layout strip at the top is not a mock-up — it reads the rail geometry
 * the StatusBar published on its last render, so `used/budget` and the
 * dropped/shortened marks are the real thing.
 */
export function StatuslinePicker({
  field,
  hiddenItems,
  lines = {},
  densities = {},
  visibleChips = [],
  filter = '',
  filtering = false,
  hint,
  clickMap,
}: StatuslinePickerProps): React.ReactElement {
  const size = useMonitorSize();
  const hiddenSet = new Set(hiddenItems);
  const visibleChipsMap = new Map(visibleChips.map((chip) => [chip.key, chip]));
  const composerOwned = new Set(COMPOSER_OWNED_CHIPS);
  const totalFields = STATUSLINE_ITEMS.length;
  const fills = readRailFills(clickMap);
  const focused = STATUSLINE_ITEMS[field];

  const enabledOn = (line: StatuslineLine): StatuslineItem[] =>
    STATUSLINE_ITEMS.filter((item) => effectiveLine(item, lines) === line && !hiddenSet.has(item));

  const visibleFields = navigableFields(filter);
  const fieldRank = Math.max(0, visibleFields.indexOf(field));

  // ── Layout strip: four rails, real fill, focused chip highlighted ──
  // Colour carries the state the user needs: what is on screen right now,
  // what the fitter had to shorten, what it dropped, and what is enabled but
  // has no data to show yet.
  const chipTone = (fill: RailFill | undefined, item: StatuslineItem): [string, string] => {
    if (!fill) return [theme.textMuted, ''];
    if (fill.dropped.has(item)) return [theme.error, '·'];
    const level = fill.levels.get(item);
    if (level == null) return [theme.textMuted, ''];
    if (level >= 2) return [theme.warn, '«'];
    if (level === 1) return [theme.warn, '‹'];
    return [theme.textSecondary, ''];
  };

  const strip = ([1, 2, 3, 4] as StatuslineLine[]).map((line) => {
    const items = enabledOn(line);
    const fill = fills.get(line);
    const ratio = fill && fill.budget > 0 ? Math.min(1, fill.used / fill.budget) : 0;
    return { line, fill, ratio, items };
  });

  // ── Rows: section headers + chip rows, windowed around the selection ──
  interface Row {
    section?: StatuslineLine | undefined;
    item?: StatuslineItem | undefined;
    fieldIdx?: number | undefined;
  }
  const listRows = Math.max(3, size.contentRows - 8);
  const windowStart = Math.max(
    0,
    Math.min(fieldRank - Math.floor(listRows / 2), visibleFields.length - listRows),
  );
  const windowEnd = Math.min(windowStart + listRows, visibleFields.length);
  const windowed = new Set(visibleFields.slice(windowStart, windowEnd));

  const rows: Row[] = [];
  let lastSection: StatuslineLine | null = null;
  for (const index of visibleFields) {
    if (!windowed.has(index)) continue;
    const item = STATUSLINE_ITEMS[index]!;
    const line = effectiveLine(item, lines);
    if (line !== lastSection) {
      rows.push({ section: line });
      lastSection = line;
    }
    rows.push({ item, fieldIdx: index });
  }
  const above = windowStart;
  const below = visibleFields.length - windowEnd;

  const stateOf = (item: StatuslineItem): string => {
    if (hiddenSet.has(item)) return 'off';
    if (STREAM_CHIP_KEYS.includes(item)) {
      const meta = visibleChipsMap.get(item);
      if (!meta) return 'auto';
      if (meta.expiresIn == null) return 'on';
      const remainingMs = meta.shownAt + meta.expiresIn * 60_000 - Date.now();
      if (remainingMs <= 0) return 'auto';
      return `~${Math.max(1, Math.ceil(remainingMs / 60_000))}m`;
    }
    return 'on';
  };
  const stateColor = (item: StatuslineItem): string => {
    if (hiddenSet.has(item)) return theme.error;
    if (STREAM_CHIP_KEYS.includes(item)) {
      const meta = visibleChipsMap.get(item);
      if (!meta || isChipExpired(meta)) return theme.accent;
      return theme.warn; // stream chip active — it may disappear on its own
    }
    return theme.success;
  };

  const descWidth = Math.max(10, size.contentWidth - 44);
  const showDescriptions = size.columns >= 88;

  return (
    <MonitorShell
      accent={theme.warn}
      icon={glyphs.terminal}
      title="STATUS LINE"
      kicker={size.columns >= 82 ? 'chips · lines · density' : undefined}
      right={
        <Text color={theme.textMuted}>
          {totalFields - hiddenItems.length}/{totalFields} on
        </Text>
      }
      footer={
        <Box flexDirection="column">
          {/* Two fixed rows rather than one wrapping row: Ink's flexWrap
              reserves the full line height for every wrapped run, which left
              blank rows between the key caps. */}
          <Box gap={2}>
            <KeyCap keyName="↑↓" label="select" color={theme.warn} />
            <KeyCap keyName="←→" label="on/off" color={theme.accent} />
            <KeyCap keyName="1-4" label="line" color={theme.accent} />
            <KeyCap keyName="d" label="density" color={theme.accent} />
          </Box>
          <Box gap={2}>
            <KeyCap keyName="/" label="filter" color={theme.accent} />
            <KeyCap keyName="a" label="line on/off" color={theme.accent} />
            <KeyCap keyName="r" label="reset layout" color={theme.error} />
            <KeyCap keyName="Esc" label="close" color={theme.error} />
          </Box>
          {size.columns >= 100 ? (
            <Text color={theme.textMuted}>
              {'  '}
              {'‹ shortened  « micro  · dropped — saved to the active profile/statusline.json'}
            </Text>
          ) : null}
        </Box>
      }
    >
      {/* Live layout strip — the real rails, not a mock-up. */}
      <Box flexDirection="column" marginTop={1}>
        {strip.map((rail) => {
          const budgetText = rail.fill
            ? `${renderMeter(rail.ratio, 8)} ${String(rail.fill.used).padStart(3)}/${rail.fill.budget}`
            : ' '.repeat(10);
          // Label (18) + `[meter] used/budget` (18) + the two-space gutter,
          // plus room for the `+N` elision marker. Overshooting here makes
          // Ink squeeze the row and silently eat the inter-chip spaces.
          const chipBudget = Math.max(10, size.contentWidth - 38 - 4);
          let used = 0;
          const shown: Array<{ item: StatuslineItem; tone: string; mark: string }> = [];
          for (const item of rail.items) {
            const [tone, mark] = chipTone(rail.fill, item);
            const density = effectiveDensity(item, densities);
            const width = item.length + mark.length + (density === 'auto' ? 0 : 2) + 1;
            if (used + width > chipBudget) break;
            used += width;
            shown.push({ item, tone, mark });
          }
          const elided = rail.items.length - shown.length;
          return (
            <Box key={`strip-${rail.line}`}>
              <Text
                color={
                  focused && rail.line === effectiveLine(focused, lines)
                    ? theme.warn
                    : theme.textSecondary
                }
                bold
              >
                {`L${rail.line} ${LINE_TITLES[rail.line]}`.padEnd(18)}
              </Text>
              <Text color={rail.fill && rail.fill.dropped.size > 0 ? theme.error : theme.textMuted}>
                {`${budgetText}  `}
              </Text>
              {rail.items.length === 0 ? <Text color={theme.textMuted}>—</Text> : null}
              {/* One template string per chip: Ink collapses a standalone
                  `{' '}` between sibling Text nodes, which silently ran chip
                  names together (`mailboxbrain`). */}
              {shown.map(({ item, tone, mark }) => {
                const density = effectiveDensity(item, densities);
                const pin = density === 'auto' ? '' : `=${density.slice(0, 1)}`;
                return (
                  <Text key={`strip-${rail.line}-${item}`} color={tone}>
                    {`${item}${mark}${pin} `}
                  </Text>
                );
              })}
              {elided > 0 ? <Text color={theme.textMuted}>{`+${elided}`}</Text> : null}
            </Box>
          );
        })}
      </Box>

      {filtering || filter ? (
        <Text color={theme.accent}>
          {`  ${glyphs.search} ${filter}${filtering ? '▏' : ''} — ${visibleFields.length} match${visibleFields.length === 1 ? '' : 'es'}`}
        </Text>
      ) : null}
      {above > 0 ? <Text color={theme.textMuted}>{`  ↑ ${above} more`}</Text> : null}

      <Box flexDirection="column" marginTop={1}>
        {rows.map((row) => {
          if (row.section != null) {
            const line = row.section;
            return (
              <Text key={`section-${line}`} bold color={theme.textMuted}>
                {`LINE ${line} · ${LINE_TITLES[line]} — ${LINE_SUBTITLES[line]}`}
              </Text>
            );
          }
          const item = row.item!;
          const fieldIdx = row.fieldIdx!;
          const selected = fieldIdx === field;
          const line = effectiveLine(item, lines);
          const moved = line !== DEFAULT_LINES[item];
          const density = effectiveDensity(item, densities);
          return (
            <Box key={`row-${item}`}>
              <Text color={selected ? theme.warn : theme.textMuted}>{selected ? '› ' : '  '}</Text>
              <Text color={selected ? theme.textPrimary : theme.textSecondary} bold={selected}>
                {item.padEnd(16)}
              </Text>
              <Text color={stateColor(item)} bold>
                {stateOf(item).padEnd(5)}
              </Text>
              <Text color={moved ? theme.warn : theme.textMuted}>
                {`L${line}${moved ? '*' : ' '} `}
              </Text>
              <Text color={density === 'auto' ? theme.textMuted : theme.brand}>
                {DENSITY_LABEL[density].padEnd(6)}
              </Text>
              {composerOwned.has(item) ? (
                <Text color={theme.textMuted}>in composer</Text>
              ) : showDescriptions ? (
                <Text color={theme.textMuted}>
                  {truncatePanelText(CHIP_DESCRIPTIONS[item], descWidth)}
                </Text>
              ) : null}
            </Box>
          );
        })}
      </Box>

      {below > 0 ? <Text color={theme.textMuted}>{`  ↓ ${below} more`}</Text> : null}
      {hint ? (
        <Text color={theme.warn}> {truncatePanelText(hint, size.contentWidth - 4)}</Text>
      ) : null}
    </MonitorShell>
  );
}
