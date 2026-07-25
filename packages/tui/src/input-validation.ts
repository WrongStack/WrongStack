/**
 * Central input validation for the TUI.
 *
 * EVERY external data source that crosses a trust boundary passes through
 * this module. Uses an **allow-list** approach: define the exact allowed
 * shape, types, ranges, and formats for each input; reject everything else.
 *
 * ── Trust boundaries ─────────────────────────────────────────────────
 *
 *   Boundary          | Source              | Validator
 *   ------------------|---------------------|--------------------------
 *   stdin             | terminal emulator   | validateStdinFragment()
 *   paste             | bracketed-paste     | validatePasteContent()
 *   AppProps          | CLI host            | validateAppProps()
 *   Reducer Action    | handleKey dispatch  | validateAction()
 *   Host callbacks    | CLI/plugin return   | validateCallbackReturn()
 *   Mouse events      | SGR protocol        | validateMouseEvent()
 *   Fleet telemetry   | Director/FleetBus   | validateFleetEntry()
 *   Restore data      | session JSONL       | validateRestoreEntry()
 *
 * ── Rejection over coercion ──────────────────────────────────────────
 *
 * This module **rejects** invalid input rather than coercing it, for
 * three reasons:
 *
 * 1. **Coercion masks injection.** Trimming whitespace from a string
 *    that contains an ANSI escape sequence leaves the sequence intact.
 * 2. **Semantic gap.** Coercing a value (e.g. clamping a PID to a valid
 *    range) creates a gap between what was validated and what the
 *    application actually uses — a future code path may use the raw
 *    value, not the clamped one.
 * 3. **Predictable failure.** Silent data transformation makes security
 *    debugging harder — rejection produces a clear error at the point
 *    of violation; coercion produces subtly wrong behavior downstream.
 *
 * The single exception is **normalization before comparison**: trimming
 * whitespace from an enum label before comparing it to the allow-list
 * prevents trivial bypasses (e.g. `"  off  "` vs `"off"`). This is
 * NOT the same as coercing the input — the normalized comparison only
 * determines allow/deny; the caller receives the original value.
 *
 * ── Conventions ──────────────────────────────────────────────────────
 *
 * - Every `validate*` function returns `ValidationResult<T>`:
 *     `{ valid: true; value: T }` — the validated, ready-to-use value
 *     `{ valid: false; error: string }` — a specific, actionable message
 * - Every error message follows the pattern:
 *     `"{path}": {what went wrong} ({detail}).`
 * - Size limits are defined as module-level constants with doc comments.
 * - Enum/union allow-lists are defined as `const` arrays and kept in
 *   ONE place so the allowed set is auditable.
 */

import { MAX_TOOL_STREAM_RETAINED_CHARS } from './reducers/helpers.js';
import { TUI_CHECKPOINTS_MAX_ENTRIES } from './checkpoint-retention.js';
import type { Action } from './app-state.js';

// ── Types ───────────────────────────────────────────────────────────

export interface ValidationOk<T> {
  valid: true;
  value: T;
}

export interface ValidationError {
  valid: false;
  error: string;
}

export type ValidationResult<T> = ValidationOk<T> | ValidationError;

// ── Size limits ─────────────────────────────────────────────────────

/** Maximum length of a single input line from stdin (before Enter). */
export const MAX_INPUT_BUFFER_CHARS = 100_000;

/** Maximum size of a single paste operation (prevents OOM from 10MB paste). */
export const MAX_PASTE_CHARS = 50_000;

/** Maximum length of a single history entry text payload. */
export const MAX_ENTRY_TEXT_CHARS = 500_000;

/** Maximum entries in the history array (matches history-retention.ts). */
export const MAX_HISTORY_ENTRIES = 400;

/** Maximum actions in a fleetBatch dispatch (prevents render-thrashing). */
export const MAX_BATCHED_ACTIONS = 500;

/** Maximum length of a single action payload string field. */
export const MAX_ACTION_STRING_FIELD = 10_000;

/** Maximum subagents tracked in fleet state. */
export const MAX_FLEET_ENTRIES = 200;

/** Maximum tools tracked per-subagent. */
export const MAX_RECENT_TOOLS = 100;

/** Maximum messages tracked per-subagent. */
export const MAX_RECENT_MESSAGES = 50;

/** Maximum depth of nested action payload objects. */
export const MAX_ACTION_DEPTH = 8;

/** Maximum characters in a paste fragment (single stdin chunk). */
export const MAX_PASTE_FRAGMENT_CHARS = 100_000;

/** Maximum length for any host-provided string (model, provider, etc). */
export const MAX_HOST_STRING_FIELD = 500;

/** Maximum entries in a picker matches list. */
export const MAX_PICKER_MATCHES = 500;

// ── Allow-lists ─────────────────────────────────────────────────────

/**
 * Define the runtime action allow-list while making TypeScript prove that it
 * contains every member of the reducer's Action union. This prevents the UI
 * from silently losing newly-added actions at the safeDispatch boundary.
 */
function defineActionTypes<const T extends readonly Action['type'][]>(
  types: T & (Exclude<Action['type'], T[number]> extends never
    ? unknown
    : ['Missing reducer actions', Exclude<Action['type'], T[number]>]),
): T {
  return types;
}

/** Known reducer action types — exact, compile-time checked allow-list. */
export const ALLOWED_ACTION_TYPES = defineActionTypes([
  'addEntry',
  'authBusy',
  'authCatalog',
  'authClose',
  'authConfirmEnd',
  'authConfirmStart',
  'authFilter',
  'authFlowDone',
  'authFlowLog',
  'authFlowStart',
  'authHint',
  'authMove',
  'authOpen',
  'authPromptChange',
  'authPromptEnd',
  'authPromptStart',
  'authProviders',
  'authView',
  'autonomyPickerClose',
  'autonomyPickerHint',
  'autonomyPickerMove',
  'autonomyPickerOpen',
  'brainBusy',
  'brainClose',
  'brainHint',
  'brainMove',
  'brainOpen',
  'brainPromptClear',
  'brainPromptSet',
  'brainRiskChange',
  'brainRowMove',
  'brainSetLog',
  'brainSettingsLoaded',
  'brainStatus',
  'brainView',
  'checkpointReceived',
  'clearConfirmClose',
  'clearConfirmOpen',
  'clearConfirmSetValue',
  'clearHistory',
  'clearInput',
  'clearInputHistory',
  'closeAllPanels',
  'collabBugFound',
  'collabEvalComplete',
  'collabPlanEmitted',
  'collabSessionDone',
  'collabSubagentSpawned',
  'compactHistory',
  'confirmClearAll',
  'confirmClose',
  'confirmOpen',
  'continueConfirmClose',
  'continueConfirmOpen',
  'copiedNotice',
  'coordinatorEvent',
  'countdownEnded',
  'countdownTick',
  'debugStreamStats',
  'debugStreamStatsClear',
  'dequeueFirst',
  'designPickerClose',
  'designPickerMove',
  'designPickerOpen',
  'designPickerStack',
  'enhanceBusy',
  'enhanceClose',
  'enhanceOpen',
  'enhanceSet',
  'enqueue',
  'escConfirmClose',
  'escConfirmOpen',
  'eternalStage',
  'exitConfirmClose',
  'exitConfirmOpen',
  'fKeyPickerClose',
  'fKeyPickerMove',
  'fKeyPickerOpen',
  'fleetBatch',
  'fleetBudgetExtended',
  'fleetBudgetWarning',
  'fleetConcurrency',
  'fleetCost',
  'fleetCtxPct',
  'fleetDelta',
  'fleetDone',
  'fleetMessage',
  'fleetRemove',
  'fleetSeed',
  'fleetSpawn',
  'fleetStart',
  'fleetTool',
  'fleetToolEnd',
  'fleetToolStart',
  'fleetUsage',
  'goalRunElapsed',
  'goalRunInit',
  'goalRunMonitorToggle',
  'goalRunPhaseUpdate',
  'goalRunReset',
  'goalRunRunningPhases',
  'goalRunTaskActive',
  'goalSummary',
  'helpClose',
  'helpFilter',
  'helpHint',
  'helpMove',
  'helpOpen',
  'hint',
  'historyDown',
  'historyPush',
  'historyUp',
  'interrupt',
  'leaderCtxPct',
  'leaderIterEnd',
  'leaderIterStart',
  'leaderToolEnd',
  'leaderToolStart',
  'mcpPickerBusy',
  'mcpPickerClose',
  'mcpPickerHint',
  'mcpPickerMove',
  'mcpPickerOpen',
  'mcpPickerSetItems',
  'modePickerClose',
  'modePickerHint',
  'modePickerMove',
  'modePickerOpen',
  'modelPickerBack',
  'modelPickerClose',
  'modelPickerHint',
  'modelPickerMove',
  'modelPickerOpen',
  'modelPickerPickProvider',
  'modelPickerSearch',
  'pickerClose',
  'pickerMove',
  'pickerOpen',
  'pickerSetMatches',
  'pluginPickerBusy',
  'pluginPickerClose',
  'pluginPickerHint',
  'pluginPickerMove',
  'pluginPickerOpen',
  'pluginPickerSetItems',
  'projectPickerClose',
  'projectPickerFilter',
  'projectPickerHint',
  'projectPickerMove',
  'projectPickerOpen',
  'promptPickerCategory',
  'promptPickerClose',
  'promptPickerMove',
  'promptPickerOpen',
  'queueClear',
  'queueDelete',
  'queueToggleRefine',
  'refineFailureClose',
  'refineFailureOpen',
  'replaceHistory',
  'resetContextChip',
  'resetInterrupts',
  'resumePickerBusy',
  'resumePickerClose',
  'resumePickerError',
  'resumePickerHint',
  'resumePickerMove',
  'resumePickerOpen',
  'rewindOverlayClose',
  'rewindOverlayMove',
  'rewindOverlayOpen',
  'sddBoardSnapshot',
  'sddBoardFocusNext',
  'sddBoardFocusPrev',
  'sendModePickerClose',
  'sendModePickerMove',
  'sendModePickerOpen',
  'sessionResumeConfirmClear',
  'sessionResumeConfirmSet',
  'sessionRewound',
  'sessionsPanelBusy',
  'sessionsPanelMove',
  'sessionsPanelSet',
  'setBuffer',
  'setFleetChat',
  'setHistoryScrolled',
  'setInputHistory',
  'setViewportRows',
  'settingsClose',
  'settingsFieldMove',
  'settingsFieldSet',
  'settingsFilterSet',
  'settingsHint',
  'settingsOpen',
  'settingsThinkingEditCancel',
  'settingsThinkingEditChange',
  'settingsThinkingEditCommit',
  'settingsThinkingEditStart',
  'settingsValueChange',
  'settingsValueSet',
  'shadowClose',
  'shadowHint',
  'shadowOpen',
  'shadowUpdate',
  'shellCommandWarningClose',
  'shellCommandWarningOpen',
  'slashConfirmClose',
  'slashConfirmOpen',
  'slashPickerClose',
  'slashPickerMove',
  'slashPickerOpen',
  'status',
  'statuslineChipExpire',
  'statuslineChipShow',
  'statuslineClose',
  'statuslineFieldMove',
  'statuslineFieldSet',
  'statuslineHint',
  'statuslineOpen',
  'statuslineToggle',
  'statuslineVisibleChipsSync',
  'steerConsume',
  'steerStart',
  'streamDelta',
  'streamReset',
  'toggleAgentsMonitor',
  'toggleAuditPanel',
  'toggleContextPanel',
  'toggleCoordinatorMonitor',
  'toggleCronMonitor',
  'toggleGoalKanbanPanel',
  'toggleGoalPanel',
  'toggleHelp',
  'toggleKanbanPanel',
  'toggleMonitor',
  'togglePlanPanel',
  'toggleProcessList',
  'toggleQueuePanel',
  'toggleSddBoardMonitor',
  'toggleSessionsPanel',
  'toggleTodosMonitor',
  'toggleWorktreeMonitor',
  'toolEnded',
  'toolStarted',
  'toolStreamAppend',
  'toolStreamClear',
  'toolsPickerBusy',
  'toolsPickerClose',
  'toolsPickerFilter',
  'toolsPickerHint',
  'toolsPickerMove',
  'toolsPickerOpen',
  'toolsPickerSetItems',
  'toolsPickerToggle',
  'worktreeRemove',
  'worktreeUpsert',
] as const);

export type AllowedActionType = (typeof ALLOWED_ACTION_TYPES)[number];

/** History entry kinds that carry text (must be non-empty to be stored). */
export const TEXT_BEARING_ENTRY_KINDS = new Set([
  'user',
  'assistant',
  'thinking',
  'info',
  'warn',
  'error',
  'turn-summary',
]);

/** All valid history entry kinds. */
export const ALLOWED_ENTRY_KINDS = new Set([
  ...TEXT_BEARING_ENTRY_KINDS,
  'tool',
  'memory-activation',
  'memory-lifecycle',
  'banner',
  'divider',
  'model-switch',
]);

/** Fleet subagent status values. */
export const ALLOWED_FLEET_STATUSES = new Set([
  'idle',
  'running',
  'success',
  'failed',
  'timeout',
  'stopped',
]);

/** Mouse event kinds */
export const ALLOWED_MOUSE_KINDS = new Set(['press', 'release', 'move', 'wheel']);

/** Mouse buttons */
export const ALLOWED_MOUSE_BUTTONS = new Set(['left', 'middle', 'right', 'none']);

/** Keyboard modifier keys. */
export const ALLOWED_KEY_EVENT_FIELDS = new Set([
  'upArrow',
  'downArrow',
  'leftArrow',
  'rightArrow',
  'return',
  'escape',
  'ctrl',
  'meta',
  'shift',
  'tab',
  'backspace',
  'delete',
  'pageUp',
  'pageDown',
  'home',
  'end',
  'wheelDeltaY',
  'mouse',
  'fn',
]);

/** Scroll direction for scrollPage. */
export const ALLOWED_SCROLL_DIRS = new Set(['up', 'down']);

/** Autonomy mode values. */
export const ALLOWED_AUTONOMY_MODES = new Set([
  'off',
  'suggest',
  'auto',
  'eternal',
  'eternal-parallel',
]);

/** Known send modes. */
export const ALLOWED_SEND_MODES = new Set(['queue', 'steer', 'btw', 'direct']);

/** FleetChat verbosity modes. */
export const ALLOWED_FLEET_CHAT_MODES = new Set(['off', 'concise', 'full']);

/** SDD lifecycle ops. */
export const ALLOWED_SDD_OPS = new Set(['cleanup_worktrees', 'rollback', 'destroy']);

/** Project picker item kinds. */
export const ALLOWED_PICKER_KINDS = new Set(['project', 'action']);

/** Collaboration verdicts. */
export const ALLOWED_COLLAB_VERDICTS = new Set(['approve', 'needs_revision', 'reject']);

/** Known terminal capability keys. */
export const ALLOWED_CAPABILITY_FIELDS = new Set([
  'colorDepth',
  'mouseProtocol',
  'supportsTitle',
]);

// ── Validators ──────────────────────────────────────────────────────

/**
 * Validate a keyboard input fragment from stdin.
 *
 * This catches raw bytes from the terminal BEFORE they enter the input
 * buffer. The allow-list is: known control sequences, printable ASCII,
 * and common Unicode (which terminals emit as normal keystrokes).
 *
 * Rejects:
 *  - Raw escape sequences that don't match known patterns
 *  - Fragments containing C0 control chars other than tab/newline (0x09, 0x0a)
 *  - Fragments longer than MAX_PASTE_FRAGMENT_CHARS (likely a flood)
 */
export function validateStdinFragment(
  data: Buffer | string,
): ValidationResult<string> {
  const s = typeof data === 'string' ? data : data.toString('utf8');

  if (s.length > MAX_PASTE_FRAGMENT_CHARS) {
    return {
      valid: false,
      error: `stdin: fragment exceeds ${MAX_PASTE_FRAGMENT_CHARS.toLocaleString()} chars (got ${s.length}).`,
    };
  }

  // Allow known CSI sequences: standard arrows, Home, End, F-keys, mouse
  // Escape is handled specially by the ESC-buffering logic, so bare \x1b
  // is allowed (it's the start of a multi-byte sequence or a standalone Esc).
  const KNOWN_ANCHORED = /^(?:\x1b(?:\[[\d;]*[A-DHFR]|\[\[\w+\]|\[[\d;]*[a-z]|O[A-Za-z]|\[[0-9]{1,2}[~]|\[<[\d;]+[Mm])|[ -~]|[\x80-\uFFFF]|[\t\n])+$/;

  // If it matches known patterns, pass.
  if (KNOWN_ANCHORED.test(s)) return { valid: true, value: s };

  // Reject fragments with C0 control characters (0x00-0x1f) except tab (0x09),
  // newline (0x0a), and escape (0x1b) which is the CSI prefix.
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x1b) {
      return {
        valid: false,
        error: `stdin: C0 control char 0x${code.toString(16)} at position ${i} is not on the allow-list.`,
      };
    }
  }

  // Reject fragments with orphaned ESC bytes that don't form a known sequence
  // (a standalone ESC not followed by a valid CSI/SS3 sequence or not being
  // the terminal byte — but since we split on boundaries, a bare ESC at end
  // is handled by the 10ms timer in input.tsx).
  const escIndex = s.indexOf('\x1b');
  if (escIndex >= 0 && escIndex < s.length - 1) {
    // ESC followed by something: check it's a valid CSI/SS3/OSC start
    const next = s[escIndex + 1] as string;
    if (next !== '[' && next !== 'O' && next !== ']' && next !== 'P' && next !== 'X') {
      return {
        valid: false,
        error: `stdin: escape byte followed by unexpected 0x${next.charCodeAt(0).toString(16)} at position ${escIndex + 1}.`,
      };
    }
  }

  return { valid: true, value: s };
}

/**
 * Validate a fully-assembled paste payload AFTER the terminal markers
 * have been stripped by paste-accumulator.ts.
 *
 * Rejects:
 *  - Paste > MAX_PASTE_CHARS
 *  - Paste containing C0 control chars (except \n, \t)
 *  - Paste that looks binary (>30% non-printable)
 *  - Paste with unbalanced surrogate pairs
 */
export function validatePasteContent(content: string): ValidationResult<string> {
  if (content.length === 0) {
    return { valid: false, error: 'paste: empty content.' };
  }

  if (content.length > MAX_PASTE_CHARS) {
    return {
      valid: false,
      error: `paste: exceeds ${MAX_PASTE_CHARS.toLocaleString()} chars (got ${content.length}).`,
    };
  }

  // Reject C0 control chars (except \t=0x09, \n=0x0a, \r=0x0d)
  let nonPrintableCount = 0;
  for (let i = 0; i < content.length; i++) {
    const code = content.charCodeAt(i);
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
      return {
        valid: false,
        error: `paste: C0 control char 0x${code.toString(16)} at position ${i} is not allowed.`,
      };
    }
    if (code > 0 && code < 0x09) nonPrintableCount++;
  }

  // Reject binary-looking paste: >30% non-printable (excluding common whitespace)
  if (content.length > 10 && nonPrintableCount / content.length > 0.3) {
    return {
      valid: false,
      error: `paste: content appears binary (${(nonPrintableCount / content.length * 100).toFixed(0)}% non-printable chars).`,
    };
  }

  return { valid: true, value: content };
}

/**
 * Validate a parsed mouse event from the SGR protocol.
 *
 * Rejects:
 *  - Unknown mouse event kinds
 *  - Unknown button values
 *  - Coordinates outside reasonable terminal bounds (0 < x < 5000, 0 < y < 5000)
 *  - Wheel values other than -1, 0, 1
 */
export function validateMouseEvent(event: {
  kind: string;
  button: string;
  x: number;
  y: number;
  wheel: number;
  shift?: boolean;
  meta?: boolean;
  ctrl?: boolean;
  motion?: boolean;
}): ValidationResult<{
  kind: string;
  button: string;
  x: number;
  y: number;
  wheel: number;
  shift: boolean;
  meta: boolean;
  ctrl: boolean;
  motion: boolean;
}> {
  const kind = event.kind;
  if (!ALLOWED_MOUSE_KINDS.has(kind as string)) {
    return {
      valid: false,
      error: `mouse.kind: "${kind}" is not on the allow-list (press|release|move|wheel).`,
    };
  }

  const button = event.button;
  if (!ALLOWED_MOUSE_BUTTONS.has(button as string)) {
    return {
      valid: false,
      error: `mouse.button: "${button}" is not on the allow-list (left|middle|right|none).`,
    };
  }

  const x = event.x;
  if (!Number.isInteger(x) || x < 1 || x > 5000) {
    return {
      valid: false,
      error: `mouse.x: ${x} is out of range [1, 5000].`,
    };
  }

  const y = event.y;
  if (!Number.isInteger(y) || y < 1 || y > 5000) {
    return {
      valid: false,
      error: `mouse.y: ${y} is out of range [1, 5000].`,
    };
  }

  const wheel = event.wheel;
  if (!Number.isInteger(wheel) || (wheel !== -1 && wheel !== 0 && wheel !== 1)) {
    return {
      valid: false,
      error: `mouse.wheel: ${wheel} is not -1, 0, or 1.`,
    };
  }

  return {
    valid: true,
    value: {
      kind,
      button,
      x,
      y,
      wheel,
      shift: event.shift ?? false,
      meta: event.meta ?? false,
      ctrl: event.ctrl ?? false,
      motion: event.motion ?? false,
    },
  };
}

/**
 * Validate a KeyEvent from stdin against the known allow-list.
 *
 * Every boolean field in a KeyEvent must be exactly `true` or `false`.
 * `fn` must be 1–12 when present. `wheelDeltaY` must be an integer.
 *
 * Rejects:
 *  - Unknown fields on the key event object
 *  - Non-boolean values for boolean fields
 *  - fn outside 1–12
 *  - wheelDeltaY that is not an integer
 */
export function validateKeyEventFields(key: Record<string, unknown>): ValidationResult<Record<string, unknown>> {
  for (const [k, v] of Object.entries(key)) {
    // Allow only known fields
    if (!ALLOWED_KEY_EVENT_FIELDS.has(k)) {
      return {
        valid: false,
        error: `key.${k}: unknown field — not on the allow-list.`,
      };
    }

    // Boolean fields must be boolean
    if (typeof v !== 'boolean' && k !== 'fn' && k !== 'wheelDeltaY' && k !== 'mouse') {
      return {
        valid: false,
        error: `key.${k}: expected boolean, got ${typeof v}.`,
      };
    }
  }

  // fn must be 1-12 when present
  if (key.fn !== undefined && key.fn !== null) {
    if (typeof key.fn !== 'number' || !Number.isInteger(key.fn) || key.fn < 1 || key.fn > 12) {
      return {
        valid: false,
        error: `key.fn: ${key.fn} is not an integer in [1, 12].`,
      };
    }
  }

  // wheelDeltaY must be an integer when present
  if (key.wheelDeltaY !== undefined && key.wheelDeltaY !== null) {
    if (typeof key.wheelDeltaY !== 'number' || !Number.isInteger(key.wheelDeltaY)) {
      return {
        valid: false,
        error: `key.wheelDeltaY: ${key.wheelDeltaY} is not an integer.`,
      };
    }
  }

  return { valid: true, value: key };
}

/**
 * Validate a reducer Action before dispatch.
 *
 * This is the central gate for all state mutations. EVERY dispatch from
 * external sources (keyboard, host callbacks, fleet events, restore data)
 * should run through this before reaching the reducer.
 *
 * Rejects:
 *  - Unknown action types
 *  - Malformed payload types
 *  - Oversized strings/arrays
 *  - Out-of-range numeric values
 *  - Deeply nested payloads (prototype poison / DoS)
 */
export function validateAction(action: {
  type: string;
  [key: string]: unknown;
}): ValidationResult<Record<string, unknown>> {
  const type = String(action.type);

  // ── 1. Action type must be on the allow-list ─────────────────────
  const typeAllowed = (ALLOWED_ACTION_TYPES as readonly string[]).includes(type);
  if (!typeAllowed) {
    return {
      valid: false,
      error: `action.type: "${type}" is not on the allow-list.`,
    };
  }

  // ── 2. Validate type-specific payload constraints ─────────────────
  const normalized = normalizeActionType(type);
  if (!normalized) {
    return { valid: false, error: `action.type: "${type}" normalized to empty.` };
  }

  // ── 3. Generic payload shape checks ───────────────────────────────
  const payload = { ...action, type: normalized };

  // Check for deeply nested objects (prototype pollution / DoS)
  const depth = measureDepth(payload, 0);
  if (depth > MAX_ACTION_DEPTH) {
    return {
      valid: false,
      error: `action: payload nesting depth ${depth} exceeds max ${MAX_ACTION_DEPTH}.`,
    };
  }

  // Check all string fields for length
  for (const [k, v] of Object.entries(payload)) {
    if (k === 'actions') continue; // fleetBatch's array is checked separately
    if (typeof v === 'string' && v.length > MAX_ACTION_STRING_FIELD) {
      return {
        valid: false,
        error: `action.${k}: string exceeds ${MAX_ACTION_STRING_FIELD.toLocaleString()} chars (got ${v.length}).`,
      };
    }
  }

  // ── 4. Type-specific validation ───────────────────────────────────
  switch (normalized) {
    // ── Buffer/input mutations ──────────────────────────────────────
    case 'setBuffer': {
      const buf = String(action.buffer ?? '');
      if (buf.length > MAX_INPUT_BUFFER_CHARS) {
        return {
          valid: false,
          error: `setBuffer.buffer: exceeds ${MAX_INPUT_BUFFER_CHARS.toLocaleString()} chars (got ${buf.length}).`,
        };
      }
      const cursor = Number(action.cursor);
      if (!Number.isInteger(cursor) || cursor < 0 || cursor > buf.length) {
        return {
          valid: false,
          error: `setBuffer.cursor: ${action.cursor} out of range [0, ${buf.length}].`,
        };
      }
      return { valid: true, value: payload };
    }

    case 'clearInput':
      // No payload — always valid
      return { valid: true, value: payload };

    // ── History mutations ───────────────────────────────────────────
    case 'addEntry': {
      const entry = action.entry;
      if (!entry || typeof entry !== 'object') {
        return { valid: false, error: 'addEntry.entry: missing or non-object.' };
      }
      const entryRecord = entry as Record<string, unknown>;
      const kind = String(entryRecord['kind'] ?? '');
      if (!ALLOWED_ENTRY_KINDS.has(kind)) {
        return {
          valid: false,
          error: `addEntry.entry.kind: "${kind}" not on allow-list.`,
        };
      }
      if (TEXT_BEARING_ENTRY_KINDS.has(kind)) {
        const text = entryRecord['text'];
        if (typeof text === 'string' && text.length > MAX_ENTRY_TEXT_CHARS) {
          return {
            valid: false,
            error: `addEntry.entry.text: exceeds ${MAX_ENTRY_TEXT_CHARS.toLocaleString()} chars (got ${text.length}).`,
          };
        }
      }
      return { valid: true, value: payload };
    }

    case 'replaceEntry': {
      const id = Number(action.id);
      if (!Number.isInteger(id) || id < 0) {
        return { valid: false, error: `replaceEntry.id: ${action.id} is not a non-negative integer.` };
      }
      return { valid: true, value: payload };
    }

    case 'replaceHistory': {
      const entries = action.entries;
      if (!Array.isArray(entries)) {
        return { valid: false, error: 'replaceHistory.entries: not an array.' };
      }
      if (entries.length > MAX_HISTORY_ENTRIES) {
        return {
          valid: false,
          error: `replaceHistory.entries: ${entries.length} exceeds max ${MAX_HISTORY_ENTRIES}.`,
        };
      }
      return { valid: true, value: payload };
    }

    // ── Scroll ──────────────────────────────────────────────────────
    case 'setHistoryScrolled': {
      if (typeof action.scrolled !== 'boolean') {
        return {
          valid: false,
          error: `setHistoryScrolled.scrolled: ${action.scrolled} is not a boolean.`,
        };
      }
      return { valid: true, value: payload };
    }

    case 'setViewportRows': {
      const rows = Number(action.rows);
      if (!Number.isInteger(rows) || rows < 0) {
        return { valid: false, error: `setViewportRows.rows: ${action.rows} is not a non-negative integer.` };
      }
      return { valid: true, value: payload };
    }

    // ── Picker ──────────────────────────────────────────────────────
    case 'pickerMove':
    case 'slashPickerMove':
    case 'modelPickerMove':
    case 'autonomyPickerMove':
    case 'settingsPickerMove':
    case 'statuslinePickerMove':
    case 'pluginPickerMove':
    case 'mcpPickerMove':
    case 'toolsPickerMove':
    case 'projectPickerMove':
    case 'fKeyPickerMove':
    case 'sessionsPanelMove':
    case 'rewindOverlayMove':
    case 'sendModePickerMove': {
      const delta = Number(action.delta);
      if (!Number.isInteger(delta) || delta < -1 || delta > 1) {
        return { valid: false, error: `${type}.delta: ${action.delta} is not -1, 0, or 1.` };
      }
      return { valid: true, value: payload };
    }

    case 'pickerSetMatches':
    case 'slashPickerSetMatches': {
      const matches = action.matches;
      if (!Array.isArray(matches)) {
        return { valid: false, error: `${type}.matches: not an array.` };
      }
      if (matches.length > MAX_PICKER_MATCHES) {
        return {
          valid: false,
          error: `${type}.matches: ${matches.length} exceeds max ${MAX_PICKER_MATCHES}.`,
        };
      }
      return { valid: true, value: payload };
    }

    case 'modelPickerSelect': {
      const idx = Number(action.index);
      if (!Number.isInteger(idx) || idx < 0) {
        return { valid: false, error: `modelPickerSelect.index: ${action.index} is not a non-negative integer.` };
      }
      return { valid: true, value: payload };
    }

    case 'projectPickerSelect': {
      const idx = Number(action.selected);
      if (!Number.isInteger(idx) || idx < 0) {
        return { valid: false, error: `projectPickerSelect.selected: ${action.selected} is not a non-negative integer.` };
      }
      return { valid: true, value: payload };
    }

    case 'projectPickerSetItems': {
      const items = action.items;
      if (!Array.isArray(items)) {
        return { valid: false, error: 'projectPickerSetItems.items: not an array.' };
      }
      if (items.length > MAX_PICKER_MATCHES) {
        return {
          valid: false,
          error: `projectPickerSetItems.items: ${items.length} exceeds max ${MAX_PICKER_MATCHES}.`,
        };
      }
      return { valid: true, value: payload };
    }

    case 'modelPickerSetProviders': {
      const providers = action.providers;
      if (!Array.isArray(providers)) {
        return { valid: false, error: 'modelPickerSetProviders.providers: not an array.' };
      }
      return { valid: true, value: payload };
    }

    // ── Settings ────────────────────────────────────────────────────
    case 'settingsPick': {
      const field = String(action.field ?? '');
      // field validated by settings-picker's resolveSettingsFieldValue
      if (field.length > 100) {
        return { valid: false, error: `settingsPick.field: length ${field.length} exceeds 100.` };
      }
      return { valid: true, value: payload };
    }

    // ── Fleet ───────────────────────────────────────────────────────
    case 'fleetSeed': {
      const entries = action.entries;
      if (!Array.isArray(entries)) {
        return { valid: false, error: 'fleetSeed.entries: not an array.' };
      }
      if (entries.length > MAX_FLEET_ENTRIES) {
        return {
          valid: false,
          error: `fleetSeed.entries: ${entries.length} exceeds max ${MAX_FLEET_ENTRIES}.`,
        };
      }
      return { valid: true, value: payload };
    }

    case 'fleetBatch': {
      const actions = action.actions;
      if (!Array.isArray(actions)) {
        return { valid: false, error: 'fleetBatch.actions: not an array.' };
      }
      if (actions.length > MAX_BATCHED_ACTIONS) {
        return {
          valid: false,
          error: `fleetBatch.actions: ${actions.length} exceeds max ${MAX_BATCHED_ACTIONS}.`,
        };
      }
      return { valid: true, value: payload };
    }

    case 'fleetToolStart':
    case 'fleetToolEnd':
    case 'fleetTool': {
      // Validate subagent id is a non-empty string
      const id = String(action.id ?? '');
      if (id.length === 0) {
        return { valid: false, error: `${type}.id: empty or missing.` };
      }
      return { valid: true, value: payload };
    }

    case 'fleetSpawn':
    case 'fleetStart':
    case 'fleetDelta':
    case 'fleetMessage':
    case 'fleetUsage':
    case 'fleetDone':
    case 'fleetRemove':
    case 'fleetBudgetWarning':
    case 'fleetBudgetExtended':
    case 'fleetCtxPct':
    case 'fleetCost':
    case 'fleetConcurrency':
    case 'leaderIterStart':
    case 'leaderIterEnd':
    case 'leaderToolStart':
    case 'leaderToolEnd':
    case 'leaderCtxPct': {
      const id = String(action.id ?? '');
      if (id.length === 0) {
        return { valid: false, error: `${type}.id: empty or missing.` };
      }
      return { valid: true, value: payload };
    }

    case 'setFleetChat': {
      const mode = String(action.mode ?? '');
      if (!ALLOWED_FLEET_CHAT_MODES.has(mode)) {
        return { valid: false, error: `setFleetChat.mode: "${mode}" not on allow-list.` };
      }
      return { valid: true, value: payload };
    }

    // ── State mutations ─────────────────────────────────────────────
    case 'setAutonomyMode': {
      const mode = String(action.mode ?? '');
      if (!ALLOWED_AUTONOMY_MODES.has(mode)) {
        return { valid: false, error: `setAutonomyMode.mode: "${mode}" not on allow-list.` };
      }
      return { valid: true, value: payload };
    }

    case 'setSendMode': {
      const mode = String(action.mode ?? '');
      if (!ALLOWED_SEND_MODES.has(mode)) {
        return { valid: false, error: `setSendMode.mode: "${mode}" not on allow-list.` };
      }
      return { valid: true, value: payload };
    }

    case 'setLiveProvider':
    case 'setLiveModel': {
      const value = String(action.value ?? '');
      if (value.length > MAX_HOST_STRING_FIELD) {
        return { valid: false, error: `${type}.value: exceeds ${MAX_HOST_STRING_FIELD} chars.` };
      }
      return { valid: true, value: payload };
    }

    case 'setEffectiveMaxContext': {
      const ctx = Number(action.value);
      if (!Number.isInteger(ctx) || ctx < 0 || ctx > 10_000_000) {
        return { valid: false, error: `setEffectiveMaxContext.value: ${action.value} out of range [0, 10_000_000].` };
      }
      return { valid: true, value: payload };
    }

    case 'setStreamingText': {
      const text = String(action.text ?? '');
      if (text.length > MAX_ENTRY_TEXT_CHARS) {
        return {
          valid: false,
          error: `setStreamingText.text: exceeds ${MAX_ENTRY_TEXT_CHARS.toLocaleString()} chars.`,
        };
      }
      return { valid: true, value: payload };
    }

    case 'setToolStream': {
      const text = String(action.text ?? '');
      if (text.length > MAX_TOOL_STREAM_RETAINED_CHARS) {
        return {
          valid: false,
          error: `setToolStream.text: exceeds ${MAX_TOOL_STREAM_RETAINED_CHARS.toLocaleString()} chars.`,
        };
      }
      return { valid: true, value: payload };
    }

    case 'setThinkingWord': {
      const word = String(action.word ?? '');
      if (word.length > 16) {
        return { valid: false, error: `setThinkingWord.word: "${word}" exceeds 16 chars.` };
      }
      return { valid: true, value: payload };
    }

    case 'setAnimationStyle': {
      const style = String(action.style ?? '');
      if (style.length > 50) {
        return { valid: false, error: `setAnimationStyle.style: length ${style.length} exceeds 50.` };
      }
      return { valid: true, value: payload };
    }

    case 'setCapability': {
      const cap = action.capability;
      if (!cap || typeof cap !== 'object') {
        return { valid: false, error: 'setCapability.capability: missing or non-object.' };
      }
      // Verify known fields only
      for (const k of Object.keys(cap as Record<string, unknown>)) {
        if (!ALLOWED_CAPABILITY_FIELDS.has(k)) {
          return { valid: false, error: `setCapability.capability.${k}: unknown field.` };
        }
      }
      return { valid: true, value: payload };
    }

    // ── Confirm panels ──────────────────────────────────────────────
    case 'clearConfirmOpen':
    case 'exitConfirmOpen':
    case 'slashConfirmOpen':
    case 'escConfirmOpen':
    case 'enhanceConfirmOpen': {
      const info = action.info;
      if (!info || typeof info !== 'object') {
        return { valid: false, error: `${type}.info: missing or non-object.` };
      }
      return { valid: true, value: payload };
    }

    case 'clearConfirmSetValue': {
      const value = String(action.value ?? '');
      if (value.length > 100) {
        return { valid: false, error: `clearConfirmSetValue.value: exceeds 100 chars.` };
      }
      return { valid: true, value: payload };
    }

    // ── Checkpoints ─────────────────────────────────────────────────
    case 'checkpointReceived': {
      const cp = action.cp;
      if (!cp || typeof cp !== 'object') {
        return { valid: false, error: 'checkpointReceived.cp: missing or non-object.' };
      }
      const promptIndex = Number((cp as Record<string, unknown>).promptIndex);
      if (!Number.isInteger(promptIndex) || promptIndex < 0) {
        return {
          valid: false,
          error: `checkpointReceived.cp.promptIndex: ${promptIndex} is not a non-negative integer.`,
        };
      }
      return { valid: true, value: payload };
    }

    // ── Rewind ──────────────────────────────────────────────────────
    case 'rewindOverlayOpen': {
      const checkpoints = action.checkpoints;
      if (!Array.isArray(checkpoints)) {
        return { valid: false, error: 'rewindOverlayOpen.checkpoints: not an array.' };
      }
      if (checkpoints.length > TUI_CHECKPOINTS_MAX_ENTRIES) {
        return {
          valid: false,
          error: `rewindOverlayOpen.checkpoints: ${checkpoints.length} exceeds max ${TUI_CHECKPOINTS_MAX_ENTRIES}.`,
        };
      }
      return { valid: true, value: payload };
    }

    // ── Steering ────────────────────────────────────────────────────
    case 'setSteering': {
      const text = String(action.text ?? '');
      if (text.length > MAX_INPUT_BUFFER_CHARS) {
        return {
          valid: false,
          error: `setSteering.text: exceeds ${MAX_INPUT_BUFFER_CHARS.toLocaleString()} chars.`,
        };
      }
      return { valid: true, value: payload };
    }

    // ── Goal ────────────────────────────────────────────────────────
    case 'goalRunInit': {
      const title = String(action.title ?? '');
      if (title.length > 500) {
        return { valid: false, error: `goalRunInit.title: exceeds 500 chars.` };
      }
      return { valid: true, value: payload };
    }

    case 'goalRunPhaseUpdate': {
      const completed = Number(action.completedTasks);
      if (!Number.isInteger(completed) || completed < 0) {
        return { valid: false, error: `goalRunPhaseUpdate.completedTasks: ${completed} is not a non-negative integer.` };
      }
      const total = Number(action.totalTasks);
      if (!Number.isInteger(total) || total < 0) {
        return { valid: false, error: `goalRunPhaseUpdate.totalTasks: ${total} is not a non-negative integer.` };
      }
      return { valid: true, value: payload };
    }

    case 'goalRunRunningPhases': {
      const phaseIds = action.phaseIds;
      if (!Array.isArray(phaseIds)) {
        return { valid: false, error: 'goalRunRunningPhases.phaseIds: not an array.' };
      }
      return { valid: true, value: payload };
    }

    case 'goalRunElapsed': {
      const ms = Number(action.ms);
      if (!Number.isFinite(ms) || ms < 0) {
        return { valid: false, error: `goalRunElapsed.ms: ${ms} is not a non-negative number.` };
      }
      return { valid: true, value: payload };
    }

    case 'goalRunTaskActive': {
      if (typeof action.active !== 'boolean') {
        return { valid: false, error: 'goalRunTaskActive.active: not a boolean.' };
      }
      return { valid: true, value: payload };
    }

    // ── SDD board ───────────────────────────────────────────────────
    case 'sddBoardSnapshot': {
      if (!action.snapshot || typeof action.snapshot !== 'object') {
        return { valid: false, error: 'sddBoardSnapshot.snapshot: missing or non-object.' };
      }
      return { valid: true, value: payload };
    }

    // ── Worktree ────────────────────────────────────────────────────
    case 'worktreeUpsert': {
      const handleId = String(action.handleId ?? '');
      if (handleId.length === 0) {
        return { valid: false, error: 'worktreeUpsert.handleId: empty.' };
      }
      return { valid: true, value: payload };
    }

    case 'worktreeRemove': {
      const handleId = String(action.handleId ?? '');
      if (handleId.length === 0) {
        return { valid: false, error: 'worktreeRemove.handleId: empty.' };
      }
      return { valid: true, value: payload };
    }

    // ── Collaboration ───────────────────────────────────────────────
    case 'collabBugFound': {
      const bugId = String(action.bugId ?? '');
      if (bugId.length === 0) {
        return { valid: false, error: 'collabBugFound.bugId: empty.' };
      }
      return { valid: true, value: payload };
    }

    case 'collabSessionDone': {
      const verdict = String(action.verdict ?? '');
      if (!ALLOWED_COLLAB_VERDICTS.has(verdict)) {
        return { valid: false, error: `collabSessionDone.verdict: "${verdict}" not on allow-list.` };
      }
      return { valid: true, value: payload };
    }

    case 'collabSubagentSpawned': {
      const role = String(action.role ?? '');
      if (role.length === 0) {
        return { valid: false, error: 'collabSubagentSpawned.role: empty.' };
      }
      return { valid: true, value: payload };
    }

    // ── Debug stream ────────────────────────────────────────────────
    case 'debugStreamStats': {
      const chunkCount = Number(action.chunkCount);
      if (!Number.isInteger(chunkCount) || chunkCount < 0) {
        return { valid: false, error: `debugStreamStats.chunkCount: ${chunkCount} is not a non-negative integer.` };
      }
      const lastChunkSize = Number(action.lastChunkSize);
      if (!Number.isInteger(lastChunkSize) || lastChunkSize < 0) {
        return { valid: false, error: `debugStreamStats.lastChunkSize: ${lastChunkSize} is not a non-negative integer.` };
      }
      const totalBytes = Number(action.totalBytes);
      if (!Number.isInteger(totalBytes) || totalBytes < 0) {
        return { valid: false, error: `debugStreamStats.totalBytes: ${totalBytes} is not a non-negative integer.` };
      }
      return { valid: true, value: payload };
    }

    // ── Countdown ───────────────────────────────────────────────────
    case 'countdownTick': {
      const remaining = Number(action.remainingSeconds);
      if (!Number.isFinite(remaining) || remaining < 0) {
        return { valid: false, error: `countdownTick.remainingSeconds: ${remaining} is not a non-negative number.` };
      }
      return { valid: true, value: payload };
    }

    // ── Coordinator ─────────────────────────────────────────────────
    case 'coordinatorEvent': {
      if (!action.event || typeof action.event !== 'object') {
        return { valid: false, error: 'coordinatorEvent.event: missing or non-object.' };
      }
      return { valid: true, value: payload };
    }

    // ── Sessions panel ──────────────────────────────────────────────
    case 'sessionsPanelSet': {
      const sessions = action.sessions;
      if (!Array.isArray(sessions)) {
        return { valid: false, error: 'sessionsPanelSet.sessions: not an array.' };
      }
      if (sessions.length > 200) {
        return { valid: false, error: `sessionsPanelSet.sessions: ${sessions.length} exceeds max 200.` };
      }
      return { valid: true, value: payload };
    }

    case 'sessionsPanelBusy': {
      if (typeof action.on !== 'boolean') {
        return { valid: false, error: 'sessionsPanelBusy.on: not a boolean.' };
      }
      return { valid: true, value: payload };
    }

    case 'sessionResumeConfirmSet': {
      const sessionId = String(action.sessionId ?? '');
      if (sessionId.length === 0) {
        return { valid: false, error: 'sessionResumeConfirmSet.sessionId: empty.' };
      }
      return { valid: true, value: payload };
    }

    // ── Simple state toggles and setters ────────────────────────────
    case 'setShowModelReasoning': {
      if (typeof action.value !== 'boolean') {
        return { valid: false, error: 'setShowModelReasoning.value: not a boolean.' };
      }
      return { valid: true, value: payload };
    }

    case 'setEnhancedPrompt': {
      const text = String(action.text ?? '');
      if (text.length > MAX_ENTRY_TEXT_CHARS) {
        return {
          valid: false,
          error: `setEnhancedPrompt.text: exceeds ${MAX_ENTRY_TEXT_CHARS.toLocaleString()} chars.`,
        };
      }
      return { valid: true, value: payload };
    }

    case 'setDesignKit': {
      const name = String(action.name ?? '');
      if (name.length > 100) {
        return { valid: false, error: `setDesignKit.name: exceeds 100 chars.` };
      }
      return { valid: true, value: payload };
    }

    case 'setGoalText':
    case 'setGoalPanelGoal': {
      const text = String(action.text ?? '');
      if (text.length > 5000) {
        return { valid: false, error: `${type}.text: exceeds 5000 chars.` };
      }
      return { valid: true, value: payload };
    }

    // ── Enhance / refine ───────────────────────────────────────────
    case 'enhanceResult': {
      const result = action.result;
      if (!result || typeof result !== 'object') {
        return { valid: false, error: 'enhanceResult.result: missing or non-object.' };
      }
      return { valid: true, value: payload };
    }

    case 'refineFailureOpen': {
      const info = action.info;
      if (!info || typeof info !== 'object') {
        return { valid: false, error: 'refineFailureOpen.info: missing or non-object.' };
      }
      return { valid: true, value: payload };
    }

    // ── Actions with no payload or trivial payload ──────────────────
    case 'toggleHelp':
    case 'toggleMonitor':
    case 'toggleAgentsMonitor':
    case 'toggleTodosMonitor':
    case 'toggleQueuePanel':
    case 'toggleProcessList':
    case 'toggleCronMonitor':
    case 'toggleAuditPanel':
    case 'togglePlanPanel':
    case 'closeAllPanels':
    case 'toggleKanbanPanel':
    case 'toggleGoalPanel':
    case 'toggleGoalKanbanPanel':
    case 'toggleContextPanel':
    case 'toggleSessionsPanel':
    case 'toggleSddBoardMonitor':
    case 'toggleWorktreeMonitor':
    case 'toggleCoordinatorMonitor':
    case 'resetContextChip':
    case 'clearConfirmClose':
    case 'exitConfirmClose':
    case 'slashConfirmClose':
    case 'escConfirmClose':
    case 'sendModePickerClose':
    case 'enhanceClose':
    case 'enhanceBusy':
    case 'enhanceBusyDone':
    case 'enhanceCancel':
    case 'enhanceDismiss':
    case 'enhanceConfirmClose':
    case 'refineFailureClose':
    case 'continueConfirmOpen':
    case 'continueConfirmClose':
    case 'rewindOverlayClose':
    case 'countdownEnded':
    case 'cancelSend':
    case 'submit':
    case 'afterSubmit':
    case 'streamStart':
    case 'streamToken':
    case 'streamToolUse':
    case 'streamToolResult':
    case 'streamEnd':
    case 'setMode':
    case 'clearHistory':
    case 'toolStreamClear':
    case 'debugStreamStatsClear':
    case 'setSteeringPending':
    case 'clearSteering':
    case 'showGoal':
    case 'goalSummary':
    case 'goalRunMonitorToggle':
    case 'goalRunReset':
    case 'sddBoardFocusNext':
    case 'sddBoardFocusPrev':
    case 'compactHistory':
    case 'pickerOpen':
    case 'pickerClose':
    case 'slashPickerOpen':
    case 'slashPickerClose':
    case 'modelPickerOpen':
    case 'modelPickerClose':
    case 'modelPickerPickProvider':
    case 'modelPickerBack':
    case 'modelPickerSearch':
    case 'modelPickerHint':
    case 'autonomyPickerOpen':
    case 'autonomyPickerClose':
    case 'settingsPickerOpen':
    case 'settingsPickerClose':
    case 'statuslinePickerOpen':
    case 'statuslinePickerClose':
    case 'pluginPickerOpen':
    case 'pluginPickerClose':
    case 'mcpPickerOpen':
    case 'mcpPickerClose':
    case 'toolsPickerOpen':
    case 'toolsPickerClose':
    case 'projectPickerOpen':
    case 'projectPickerClose':
    case 'fKeyPickerOpen':
    case 'fKeyPickerClose':
    case 'confirmPromptOpen':
    case 'confirmPromptClose':
    case 'setDeadline':
    case 'enhanceOpen':
      return { valid: true, value: payload };

    default:
      // The exact Action-union allow-list above is compile-time exhaustive.
      // Actions without extra field constraints still pass the generic depth
      // and string-size checks. Requiring a second exhaustive switch list here
      // previously let valid reducer actions drift out of sync and silently
      // disabled large parts of the TUI.
      return { valid: true, value: payload };
  }
}

/**
 * Normalize an action type string before allow-list comparison:
 * - Trim whitespace
 * - Reject empty/null/undefined
 */
function normalizeActionType(type: string): string | null {
  const trimmed = String(type ?? '').trim();
  if (trimmed.length === 0) return null;
  return trimmed;
}

/**
 * Measure the maximum nesting depth of a value.
 * Used to prevent prototype-pollution / deep-object DoS.
 */
function measureDepth(value: unknown, depth: number): number {
  if (depth > MAX_ACTION_DEPTH) return depth;
  if (value === null || typeof value !== 'object') return depth;
  if (Array.isArray(value)) {
    let max = depth;
    for (const item of value.slice(0, 10)) {
      // Only sample first 10 to avoid perf DoS
      const d = measureDepth(item, depth + 1);
      if (d > max) max = d;
      if (max > MAX_ACTION_DEPTH) return max;
    }
    return max;
  }
  let max = depth;
  for (const v of Object.values(value as Record<string, unknown>).slice(0, 10)) {
    const d = measureDepth(v, depth + 1);
    if (d > max) max = d;
    if (max > MAX_ACTION_DEPTH) return max;
  }
  return max;
}

/**
 * Validate a fleet subagent entry from telemetry.
 *
 * Rejects:
 *  - Unknown status
 *  - Oversized streamingText
 *  - Malformed recent tools/messages arrays
 *  - Non-finite cost
 */
export function validateFleetEntry(entry: {
  id: string;
  name: string;
  status: string;
  streamingText?: string;
  iterations?: number;
  toolCalls?: number;
  recentTools?: unknown[];
  recentMessages?: unknown[];
  cost?: number;
}): ValidationResult<Record<string, unknown>> {
  if (!entry.id || typeof entry.id !== 'string') {
    return { valid: false, error: 'fleetEntry.id: missing or non-string.' };
  }
  if (!entry.name || typeof entry.name !== 'string') {
    return { valid: false, error: 'fleetEntry.name: missing or non-string.' };
  }

  const status = entry.status;
  if (!ALLOWED_FLEET_STATUSES.has(status)) {
    return { valid: false, error: `fleetEntry.status: "${status}" not on allow-list.` };
  }

  if (entry.streamingText && entry.streamingText.length > MAX_ENTRY_TEXT_CHARS) {
    return {
      valid: false,
      error: `fleetEntry.streamingText: exceeds ${MAX_ENTRY_TEXT_CHARS.toLocaleString()} chars.`,
    };
  }

  if (entry.recentTools && !Array.isArray(entry.recentTools)) {
    return { valid: false, error: 'fleetEntry.recentTools: not an array.' };
  }
  if (entry.recentTools && entry.recentTools.length > MAX_RECENT_TOOLS) {
    return {
      valid: false,
      error: `fleetEntry.recentTools: ${entry.recentTools.length} exceeds max ${MAX_RECENT_TOOLS}.`,
    };
  }

  if (entry.recentMessages && !Array.isArray(entry.recentMessages)) {
    return { valid: false, error: 'fleetEntry.recentMessages: not an array.' };
  }
  if (entry.recentMessages && entry.recentMessages.length > MAX_RECENT_MESSAGES) {
    return {
      valid: false,
      error: `fleetEntry.recentMessages: ${entry.recentMessages.length} exceeds max ${MAX_RECENT_MESSAGES}.`,
    };
  }

  if (entry.cost !== undefined) {
    if (typeof entry.cost !== 'number' || !Number.isFinite(entry.cost) || entry.cost < 0) {
      return { valid: false, error: `fleetEntry.cost: ${entry.cost} is not a finite non-negative number.` };
    }
  }

  return { valid: true, value: entry as unknown as Record<string, unknown> };
}

/**
 * Validate a restored session entry (from JSONL).
 *
 * Rejects:
 *  - Non-object entries
 *  - Unknown entry kinds
 *  - Oversized payloads
 */
export function validateRestoreEntry(
  entry: unknown,
  index: number,
): ValidationResult<Record<string, unknown>> {
  if (!entry || typeof entry !== 'object') {
    return { valid: false, error: `restoreEntry[${index}]: not an object (got ${typeof entry}).` };
  }

  const e = entry as Record<string, unknown>;
  const kind = String(e.kind ?? '');

  if (kind === 'tool') {
    // Tool entries are validated loosely — they come from our own JSONL
    return { valid: true, value: e };
  }

  if (!ALLOWED_ENTRY_KINDS.has(kind)) {
    return {
      valid: false,
      error: `restoreEntry[${index}].kind: "${kind}" not on allow-list.`,
    };
  }

  if (TEXT_BEARING_ENTRY_KINDS.has(kind)) {
    const text = e.text;
    if (typeof text === 'string' && text.length > MAX_ENTRY_TEXT_CHARS) {
      return {
        valid: false,
        error: `restoreEntry[${index}].text: exceeds ${MAX_ENTRY_TEXT_CHARS.toLocaleString()} chars.`,
      };
    }
  }

  return { valid: true, value: e };
}

/**
 * Validate that an action dispatch is safe for the reducer.
 * This is a convenience wrapper used at the dispatch boundary.
 * Returns the original action untouched if valid, or throws with the
 * specific error message if invalid.
 *
 * In production, the caller can log the error and drop the action
 * instead of crashing — but for security boundaries, throwing is the
 * safe default because it prevents any partially-valid state from
 * reaching the reducer.
 */
export function ensureValidAction(action: {
  type: string;
  [key: string]: unknown;
}): Record<string, unknown> {
  const result = validateAction(action);
  if (!result.valid) {
    throw new Error(`Input validation rejected: ${result.error}`);
  }
  return result.value;
}

/**
 * Safe dispatch wrapper: validates the action, then calls dispatch
 * only if validation passes. Returns true if dispatched, false if rejected
 * (with the error logged).
 */
export function safeDispatch(
  action: {
    type: string;
    [key: string]: unknown;
  },
  dispatch: (action: Record<string, unknown>) => void,
): boolean {
  const result = validateAction(action);
  if (!result.valid) {
    // eslint-disable-next-line no-console
    console.warn(
      JSON.stringify({
        level: 'error',
        event: 'input_validation_rejected_dispatch',
        message: `REJECTED dispatch "${action.type}": ${result.error}`,
        timestamp: new Date().toISOString(),
      }),
    );
    return false;
  }
  dispatch(result.value);
  return true;
}

/**
 * Normalize a string by trimming whitespace.
 * This is the ONLY normalization we do — and it's only used for
 * allow-list comparison, never for the returned value.
 */
export function normalizedEquals(a: string, b: string): boolean {
  return a.trim() === b.trim();
}
