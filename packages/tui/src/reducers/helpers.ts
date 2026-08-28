import type { State } from '../app-state.js';
import type { ProjectPickerItem } from '../ui-contracts.js';

// ── Panel helpers ──────────────────────────────────────────────────────────

type PanelResetState = Pick<
  State,
  | 'monitorOpen'
  | 'agentsMonitorOpen'
  | 'helpOpen'
  | 'todosMonitorOpen'
  | 'queuePanelOpen'
  | 'processListOpen'
  | 'cronMonitorOpen'
  | 'auditPanelOpen'
  | 'planPanelOpen'
  | 'kanbanPanelOpen'
  | 'goalPanelOpen'
  | 'goalKanbanPanelOpen'
  | 'contextPanelOpen'
  | 'connectionsPanelOpen'
  | 'sessionsPanelOpen'
  | 'sidebarFocused'
  | 'settingsPicker'
  | 'statuslinePicker'
  | 'pluginPicker'
  | 'mcpPicker'
  | 'toolsPicker'
  | 'brainPanel'
  | 'helpPanel'
  | 'shadowPanel'
  | 'authPanel'
  | 'projectPicker'
  | 'fKeyPicker'
  | 'goalRun'
  | 'sddBoard'
  | 'worktreeMonitorOpen'
  | 'coordinator'
  | 'themePicker'
  | 'skillPicker'
  | 'resourceMenu'
>;

export function closePanels(state: State): PanelResetState {
  return {
    monitorOpen: false,
    agentsMonitorOpen: false,
    helpOpen: false,
    todosMonitorOpen: false,
    queuePanelOpen: false,
    processListOpen: false,
    cronMonitorOpen: false,
    auditPanelOpen: false,
    planPanelOpen: false,
    kanbanPanelOpen: false,
    goalPanelOpen: false,
    goalKanbanPanelOpen: false,
    contextPanelOpen: false,
    connectionsPanelOpen: false,
    sessionsPanelOpen: false,
    sidebarFocused: false,
    settingsPicker: { ...state.settingsPicker, open: false },
    statuslinePicker: { ...state.statuslinePicker, open: false },
    pluginPicker: { ...state.pluginPicker, open: false },
    mcpPicker: { ...state.mcpPicker, open: false },
    toolsPicker: { ...state.toolsPicker, open: false },
    brainPanel: { ...state.brainPanel, open: false },
    helpPanel: { ...state.helpPanel, open: false },
    shadowPanel: { ...state.shadowPanel, open: false },
    authPanel: { ...state.authPanel, open: false, busy: false },
    projectPicker: { ...state.projectPicker, open: false },
    fKeyPicker: { ...state.fKeyPicker, open: false },
    goalRun: state.goalRun ? { ...state.goalRun, monitorOpen: false } : state.goalRun,
    sddBoard: state.sddBoard ? { ...state.sddBoard, monitorOpen: false } : state.sddBoard,
    worktreeMonitorOpen: false,
    coordinator: { ...state.coordinator, monitorOpen: false },
    themePicker: { ...state.themePicker, open: false },
    skillPicker: { ...state.skillPicker, open: false },
    resourceMenu: { ...state.resourceMenu, open: false, pendingAction: undefined },
  };
}

export function clampContextLoad(load: number): number {
  if (!Number.isFinite(load)) return 0;
  return Math.max(0, Math.min(1, load));
}

// ── Tool input memory bounds ──────────────────────────────────────────────

/** Upper bound on the live tool-stream text retained in state. */
export const MAX_TOOL_STREAM_RETAINED_CHARS = 100_000;

/** Upper bound on the assistant/thinking live tail retained in React state. */
export const MAX_ASSISTANT_STREAM_RETAINED_CHARS = 16_384;

function sliceTailWithoutSplittingSurrogatePair(value: string, maxChars: number): string {
  const start = Math.max(0, value.length - maxChars);
  const first = value.charCodeAt(start);
  const safeStart = first >= 0xdc00 && first <= 0xdfff ? start + 1 : start;
  return value.slice(safeStart);
}

/**
 * Bound a growing display-only string while preserving the newest text.
 * Reducer stream state is only the live rendering tail, not the canonical
 * provider response; completed output remains available from the committed
 * history entry and session log.
 *
 * `maxChars` is a HIGH-WATER mark, not an exact cap: the buffer may grow to
 * `2 * maxChars` and is then cut back to `maxChars`. Trimming on every delta
 * looks tidier but costs O(current) PER TOKEN — V8 has to flatten the
 * accumulated rope before it can slice it, so a saturated buffer memcpy'd its
 * whole length for every token that arrived. Measured over 60k deltas into a
 * 64KB buffer: 139ms trimming eagerly versus 1.2ms with this high-water cut,
 * for the same retained tail. The fleet bridge runs three of these per delta
 * per subagent, so that cost multiplied.
 *
 * Guarantees: the result always ends with `delta`, always retains at least the
 * most recent `maxChars` characters written, and never exceeds `2 * maxChars`.
 * Callers hold a live rendering tail whose exact length the user cannot
 * observe, so the doubled ceiling (128KB at the largest call site, against the
 * 500k-char entry limit in `input-validation/limits.ts`) buys the per-token
 * copy away.
 */
export function retainStreamTail(current: string, delta: string, maxChars: number): string {
  if (maxChars <= 0) return '';
  if (delta.length >= maxChars) return sliceTailWithoutSplittingSurrogatePair(delta, maxChars);
  const next = current + delta;
  return next.length > maxChars * 2 ? sliceTailWithoutSplittingSurrogatePair(next, maxChars) : next;
}

/** Caps applied to tool `input` payloads before retention in history entries. */
const MAX_RETAINED_INPUT_CHARS = 2_048;
export const MAX_RETAINED_INPUT_DEPTH = 4;
const MAX_RETAINED_INPUT_ITEMS = 64;

/**
 * Deep-truncate a tool input for long-term retention in history entries.
 * Strings are capped per-string, arrays/objects are capped in breadth and
 * depth. Returns the value unchanged when nothing exceeds a cap.
 *
 * @public — exported for unit tests
 */
export function pruneToolInput(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return value.length > MAX_RETAINED_INPUT_CHARS
      ? `${value.slice(0, MAX_RETAINED_INPUT_CHARS)}… [truncated, ${value.length} chars — full payload in session log]`
      : value;
  }
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_RETAINED_INPUT_DEPTH) return '[pruned: too deep]';
  if (Array.isArray(value)) {
    const head = value.slice(0, MAX_RETAINED_INPUT_ITEMS).map((v) => pruneToolInput(v, depth + 1));
    if (value.length > MAX_RETAINED_INPUT_ITEMS) {
      head.push(`[pruned: ${value.length - MAX_RETAINED_INPUT_ITEMS} more items]`);
    }
    return head;
  }
  const out: Record<string, unknown> = {};
  let n = 0;
  for (const [k, v] of Object.entries(value)) {
    if (n++ >= MAX_RETAINED_INPUT_ITEMS) {
      out['…'] = '[pruned: more keys]';
      break;
    }
    out[k] = pruneToolInput(v, depth + 1);
  }
  return out;
}

// ── Project picker helpers ────────────────────────────────────────────────

/**
 * Find the first non-divider index in the list. Returns 0 when the list is
 * empty or contains only dividers.
 *
 * @public — exported for unit tests
 */
export function firstSelectable(items: ProjectPickerItem[]): number {
  const idx = items.findIndex((it) => it.key !== '__divider__');
  return idx >= 0 ? idx : 0;
}

/**
 * Skip divider items at the given index, moving forward (+1) or backward (-1).
 * Clamps to [0, items.length - 1]. If every item is a divider the index stays
 * put — the caller should already know the list has at least one selectable.
 *
 * @public — exported for unit tests
 */
export function skipDivider(items: ProjectPickerItem[], idx: number, dir: 1 | -1): number {
  let i = idx;
  for (let steps = 0; steps < items.length; steps++) {
    const item = items[i];
    if (!item || item.key === '__divider__') {
      i += dir;
      if (i < 0) i = items.length - 1;
      if (i >= items.length) i = 0;
      continue;
    }
    return i;
  }
  return idx; // all dividers — stay put
}
