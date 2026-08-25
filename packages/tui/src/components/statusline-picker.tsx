import type React from 'react';
import { Box, Text } from '../ink.js';
import { theme } from '../theme.js';
import { glyphs } from '../ui-glyphs.js';
import { KeyCap, MonitorShell, truncatePanelText, useMonitorSize } from './monitor-shell.js';

/** All possible statusline chip keys.

 *  NOTE: `'cpu'` and `'memory'` were removed — CPU/RAM/heap metrics now live
 *  in the right sidebar's SYSTEM card (sidebar-content.tsx). Any stale entries
 *  in a saved statusline profile are silently ignored by `showChip` since no
 *  chip renders them anymore, mirroring how removed phantom items ('version',
 *  'time', 'sage') are handled. */
export type StatuslineItem =
  | 'state'
  | 'model'
  | 'tokens'
  | 'cache'
  | 'queue'
  | 'hint'
  | 'index'
  | 'breaker'
  | 'todos'
  | 'plan'
  | 'tasks'
  | 'fleet'
  | 'fleet_agents'
  | 'git'
  | 'elapsed'
  | 'context'
  | 'cost'
  | 'processes'
  | 'working_dir'
  | 'project'
  | 'yolo'
  | 'autonomy'
  | 'eternal_stage'
  | 'goal'
  | 'mode'
  | 'auto_proceed'
  | 'sessions'
  | 'tools'
  | 'theme'
  | 'token_saving'
  | 'brain'
  | 'mailbox'
  | 'enhance'
  | 'debug_stream'
  | 'next_steps'
  | 'memory_context'
  | 'side_effects';

/**
 * Metadata for a temporarily-visible chip (one that appeared due to data,
 * not user toggle). Tracked so the chip can auto-expire.
 */
export interface ChipMeta {
  key: StatuslineItem;
  /** Unix timestamp (ms) when the chip was shown. */
  shownAt: number;
  /**
   * Optional expiration time in minutes. Null/undefined = permanent (only
   * hidden when user toggles it off). Stream chips get a default 5 min.
   */
  expiresIn?: number;
}

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

/** Item descriptions for display. */
const ITEM_DESCRIPTIONS: Record<StatuslineItem, string> = {
  state: 'Agent run state / thinking spinner',
  model: 'Current provider/model id',
  tokens: 'Input/output token counters',
  cache: 'Prompt cache hit ratio',
  queue: 'Queued prompt count',
  hint: 'Transient status hint text',
  index: 'Codebase index server and indexing status',
  breaker: 'Process breaker countdown',
  todos: 'Todo items (pending/in-progress/done)',
  plan: 'Plan board items',
  tasks: 'Task board items',
  fleet: 'Fleet agent status',
  fleet_agents: 'Per-agent live detail row',
  git: 'Git branch name',
  elapsed: 'Session elapsed time',
  context: 'Context window usage %',
  cost: 'Token cost estimate',
  processes: 'Tracked bash/exec process count',
  working_dir: 'Current working directory',
  project: 'Project name',
  yolo: 'YOLO permission mode',
  autonomy: 'Autonomy mode',
  eternal_stage: 'Autonomy stage',
  goal: 'Active goal summary',
  mode: 'Active agent mode label',
  auto_proceed: 'Auto-proceed countdown',
  sessions: 'Live session count',
  tools: 'Registered tool count',
  theme: 'Active color theme preset',
  token_saving: 'Token-saving mode indicator',
  brain: 'Brain arbiter decisions',
  mailbox: 'Mailbox unread messages',
  enhance: 'Prompt-enhance countdown',
  debug_stream: 'Stream debug telemetry',
  next_steps: 'Next-step auto-submit countdown',
  memory_context: 'Memory context detail line (total records + active-in-context)',
  side_effects: 'Side-effect / audit event count',
};

/**
 * Which TUI status bar line each chip appears on. Used to group chips
 * visually in the picker. MUST mirror the actual render lines in
 * `status-bar.tsx`: line 1 = workspace + runtime chips (mode/project/workdir
 * state + cheap provider/model/context telemetry), line 2 = session context
 * (memory pressure, git, mode label, tools), line 3 = active work +
 * connectivity (todos, plan, tasks, fleet, brain, mailbox, goals,
 * countdowns), line 4 = background services (memory context lifecycle,
 * codebase-index server health). Exported so the navigation-order test guards
 * against drift instead of duplicating it.
 */
export const ITEM_LINE: Record<StatuslineItem, number> = {
  // Line 1 — workspace + runtime: mode indicators, project/workdir,
  // provider/model, context window, and other low-cost runtime chips
  autonomy: 1,
  breaker: 1,
  cache: 1,
  context: 1,
  cost: 1,
  elapsed: 1,
  hint: 1,
  model: 1,
  processes: 1,
  queue: 1,
  state: 1,
  tokens: 1,
  yolo: 1,
  // Line 2 — session context: workdir/project first, then mode, git, tools.
  git: 2,
  mode: 2,
  project: 2,
  sessions: 2,
  side_effects: 2,
  theme: 2,
  token_saving: 2,
  tools: 2,
  working_dir: 2,
  // Line 3 — active work + connectivity
  auto_proceed: 3,
  brain: 3,
  debug_stream: 3,
  enhance: 3,
  eternal_stage: 3,
  fleet: 3,
  fleet_agents: 3,
  goal: 3,
  mailbox: 3,
  next_steps: 3,
  plan: 3,
  tasks: 3,
  todos: 3,
  // Line 4 — background-service telemetry
  index: 4,
  memory_context: 4,
};

export interface StatuslinePickerProps {
  /** Focused field index. */
  field: number;
  /** Current hidden-items list. */
  hiddenItems: StatuslineItem[];
  /** Temporarily-visible chips with expiration metadata. */
  visibleChips?: ChipMeta[] | undefined;
  /** Optional hint message from the reducer. */
  hint?: string | undefined;
}

/** Total number of statusline fields. */
export const STATUSLINE_FIELD_COUNT = Object.keys(ITEM_LINE).length;

/** Ordered list of statusline items — grouped by display line, then alphabetically within each line for consistent navigation. */
export const STATUSLINE_ITEMS: StatuslineItem[] = [
  // Line 1
  'autonomy',
  'breaker',
  'cache',
  'context',
  'cost',
  'elapsed',
  'hint',
  'model',
  'processes',
  'queue',
  'state',
  'tokens',
  'yolo',
  // Line 2 — workdir/project first, then session context
  'project',
  'working_dir',
  'git',
  'mode',
  'sessions',
  'side_effects',
  'theme',
  'token_saving',
  'tools',
  // Line 3
  'auto_proceed',
  'brain',
  'debug_stream',
  'enhance',
  'eternal_stage',
  'fleet',
  'fleet_agents',
  'goal',
  'mailbox',
  'next_steps',
  'plan',
  'tasks',
  'todos',
  // Line 4
  'index',
  'memory_context',
];

/** Stream-triggered chips — these auto-expire unless the user has toggled them on permanently. */
export const STREAM_CHIP_KEYS: StatuslineItem[] = ['brain', 'mailbox', 'enhance', 'debug_stream'];

/** Group items by their display line (1-4). */
function groupByLine(items: StatuslineItem[]): Map<number, StatuslineItem[]> {
  const map = new Map<number, StatuslineItem[]>();
  for (const item of items) {
    const line = ITEM_LINE[item];
    if (!map.has(line)) map.set(line, []);
    map.get(line)!.push(item);
  }
  return map;
}

export function StatuslinePicker({
  field,
  hiddenItems,
  visibleChips = [],
  hint,
}: StatuslinePickerProps): React.ReactElement {
  const size = useMonitorSize();
  const hiddenSet = new Set(hiddenItems);
  const visibleChipsMap = new Map(visibleChips.map((c) => [c.key, c]));
  const totalFields = STATUSLINE_ITEMS.length;

  const byLine = groupByLine(STATUSLINE_ITEMS);

  // Compute which field indices are visible in the scroll window. The window
  // tracks the focused field so navigating past the edge scrolls the list
  // instead of letting it overflow the terminal.
  const VISIBLE_FIELDS = Math.max(3, Math.min(10, size.contentRows - 5));
  const windowStart = Math.max(
    0,
    Math.min(field - Math.floor(VISIBLE_FIELDS / 2), totalFields - VISIBLE_FIELDS),
  );
  const windowEnd = Math.min(windowStart + VISIBLE_FIELDS, totalFields);
  const hasAbove = windowStart > 0;
  const hasBelow = windowEnd < totalFields;

  // Build section-aware row list, but only for items inside the window. A
  // section header is emitted only when at least one of its items is visible,
  // so groups don't render empty headers when scrolled past.
  interface Row {
    section?: string | undefined;
    item?: StatuslineItem | undefined;
    fieldIdx?: number | undefined;
  }

  const rows: Row[] = [];
  for (const [line, items] of [...byLine.entries()].sort((a, b) => a[0] - b[0])) {
    const windowedItems = items.filter((item) => {
      const idx = STATUSLINE_ITEMS.indexOf(item);
      return idx >= windowStart && idx < windowEnd;
    });
    if (windowedItems.length === 0) continue;
    rows.push({ section: `Line ${line}` });
    for (const item of windowedItems) {
      rows.push({ item, fieldIdx: STATUSLINE_ITEMS.indexOf(item) });
    }
  }

  const boolVal = (item: StatuslineItem): string => {
    if (hiddenSet.has(item)) return 'off';
    if (STREAM_CHIP_KEYS.includes(item)) {
      const meta = visibleChipsMap.get(item);
      if (!meta) return 'auto';
      if (meta.expiresIn == null) return 'on '; // permanently shown
      const remainingMs = meta.shownAt + meta.expiresIn * 60_000 - Date.now();
      if (remainingMs <= 0) return 'auto';
      const remainingMin = Math.max(1, Math.ceil(remainingMs / 60_000));
      return `~${remainingMin}m`;
    }
    return 'on ';
  };
  const valColor = (item: StatuslineItem) => {
    if (hiddenSet.has(item)) return 'red';
    if (STREAM_CHIP_KEYS.includes(item)) {
      const meta = visibleChipsMap.get(item);
      if (!meta) return 'cyan';
      if (isChipExpired(meta)) return 'cyan';
      return 'yellow'; // stream chip active — yellow to signal it may disappear
    }
    return 'green';
  };

  return (
    <MonitorShell
      accent={theme.warn}
      icon={glyphs.terminal}
      title="STATUS LINE"
      kicker={size.columns >= 82 ? 'chip visibility' : undefined}
      right={
        <Text color={theme.textMuted}>
          {totalFields - hiddenItems.length}/{totalFields} enabled
        </Text>
      }
      footer={
        <Box gap={2}>
          <KeyCap keyName="↑↓" label="select" color={theme.warn} />
          <KeyCap keyName="←→" label="toggle" color={theme.accent} />
          <KeyCap keyName="Esc" label="close" color={theme.error} />
          {size.columns >= 100 ? (
            <Text color={theme.textMuted}>saved to the active profile/statusline.json</Text>
          ) : null}
        </Box>
      }
    >
      {hasAbove ? (
        <Text
          color={theme.textMuted}
        >{`  ↑ ${windowStart} item${windowStart === 1 ? '' : 's'} above`}</Text>
      ) : null}
      <Box flexDirection="column" marginTop={1}>
        {rows.map((row) => {
          if (row.section) {
            return (
              <Text key={`section-${row.section}`} bold color={theme.textMuted}>
                {row.section.toUpperCase()}
              </Text>
            );
          }
          const item = row.item!;
          const fieldIdx = row.fieldIdx!;
          const selected = fieldIdx === field;
          return (
            <Box key={`row-${item}`}>
              <Text color={selected ? theme.warn : theme.textMuted}>{selected ? '› ' : '  '}</Text>
              <Text color={selected ? theme.textPrimary : theme.textSecondary} bold={selected}>
                {(item as string).padEnd(16)}
              </Text>
              <Text color={valColor(item)} bold>
                {boolVal(item).padEnd(5)}
              </Text>
              <Text color={theme.textMuted}>
                {truncatePanelText(ITEM_DESCRIPTIONS[item], Math.max(12, size.contentWidth - 30))}
              </Text>
            </Box>
          );
        })}
      </Box>
      {hasBelow ? (
        <Text
          color={theme.textMuted}
        >{`  ↓ ${totalFields - windowEnd} item${totalFields - windowEnd === 1 ? '' : 's'} below`}</Text>
      ) : null}
      {hint ? (
        <Text color={theme.warn}> {truncatePanelText(hint, size.contentWidth - 4)}</Text>
      ) : null}
    </MonitorShell>
  );
}
