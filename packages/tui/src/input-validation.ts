import { validateDisplayAction } from './input-validation-display.js';
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

import { measureDepth, normalizeActionType } from './input-validation/action-helpers.js';
import { ALLOWED_ACTION_TYPES } from './input-validation/action-types.js';
import {
  ALLOWED_AUTONOMY_MODES,
  ALLOWED_ENTRY_KINDS,
  ALLOWED_FLEET_CHAT_MODES,
  ALLOWED_SEND_MODES,
  TEXT_BEARING_ENTRY_KINDS,
} from './input-validation/allow-lists.js';
import {
  MAX_ACTION_DEPTH,
  MAX_ACTION_STRING_FIELD,
  MAX_BATCHED_ACTIONS,
  MAX_ENTRY_TEXT_CHARS,
  MAX_FLEET_ENTRIES,
  MAX_HISTORY_ENTRIES,
  MAX_HOST_STRING_FIELD,
  MAX_INPUT_BUFFER_CHARS,
  MAX_PICKER_MATCHES,
} from './input-validation/limits.js';
import type { ValidationResult } from './input-validation/result.js';

export { ALLOWED_ACTION_TYPES } from './input-validation/action-types.js';
export {
  ALLOWED_ENTRY_KINDS,
  ALLOWED_FLEET_STATUSES,
  ALLOWED_KEY_EVENT_FIELDS,
  ALLOWED_MOUSE_BUTTONS,
  ALLOWED_MOUSE_KINDS,
  TEXT_BEARING_ENTRY_KINDS,
} from './input-validation/allow-lists.js';
export {
  MAX_ACTION_DEPTH,
  MAX_ACTION_STRING_FIELD,
  MAX_BATCHED_ACTIONS,
  MAX_ENTRY_TEXT_CHARS,
  MAX_FLEET_ENTRIES,
  MAX_HISTORY_ENTRIES,
  MAX_INPUT_BUFFER_CHARS,
  MAX_PASTE_CHARS,
  MAX_PASTE_FRAGMENT_CHARS,
  MAX_PICKER_MATCHES,
  MAX_RECENT_MESSAGES,
  MAX_RECENT_TOOLS,
} from './input-validation/limits.js';
export type {
  ValidationError,
  ValidationOk,
  ValidationResult,
} from './input-validation/result.js';
export { validateFleetEntry, validateRestoreEntry } from './input-validation/state-entries.js';
export {
  validateMouseEvent,
  validatePasteContent,
  validateStdinFragment,
} from './input-validation/terminal.js';

// -- Action validation ---------------------------------------------------

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
        return {
          valid: false,
          error: `replaceEntry.id: ${action.id} is not a non-negative integer.`,
        };
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
        return {
          valid: false,
          error: `setViewportRows.rows: ${action.rows} is not a non-negative integer.`,
        };
      }
      return { valid: true, value: payload };
    }

    // ── Picker ──────────────────────────────────────────────────────
    case 'pickerMove':
    case 'slashPickerMove':
    case 'modelPickerMove':
    case 'autonomyPickerMove':
    case 'skillPickerMove':
    case 'resourceMenuMove':
    case 'settingsPickerMove':
    case 'statuslinePickerMove':
    case 'pluginPickerMove':
    case 'mcpPickerMove':
    case 'toolsPickerMove':
    case 'projectPickerMove':
    case 'fKeyPickerMove':
    case 'sessionsPanelMove':
    case 'rewindOverlayMove':
    case 'sendModePickerMove':
    case 'fallbackOverlayMove': {
      const delta = Number(action.delta);
      if (!Number.isInteger(delta) || delta < -1 || delta > 1) {
        return { valid: false, error: `${type}.delta: ${action.delta} is not -1, 0, or 1.` };
      }
      return { valid: true, value: payload };
    }

    case 'checkpointFork': {
      const promptIndex = Number(action.promptIndex);
      if (!Number.isInteger(promptIndex) || promptIndex < 0) {
        return { valid: false, error: `${type}.promptIndex: not a checkpoint index.` };
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
        return {
          valid: false,
          error: `modelPickerSelect.index: ${action.index} is not a non-negative integer.`,
        };
      }
      return { valid: true, value: payload };
    }

    case 'projectPickerSelect': {
      const idx = Number(action.selected);
      if (!Number.isInteger(idx) || idx < 0) {
        return {
          valid: false,
          error: `projectPickerSelect.selected: ${action.selected} is not a non-negative integer.`,
        };
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
    case 'setEffectiveMaxContext':
    case 'setStreamingText':
    case 'setToolStream':
    case 'setThinkingWord':
    case 'setAnimationStyle':
    case 'setCapability':
    case 'clearConfirmOpen':
    case 'exitConfirmOpen':
    case 'slashConfirmOpen':
    case 'escConfirmOpen':
    case 'enhanceConfirmOpen':
    case 'fallbackOverlayOpen':
    case 'inspectOverlayOpen':
    case 'inspectOverlayScroll':
    case 'chatSearchOpen':
    case 'chatSearchSetQuery':
    case 'chatSearchStep':
    case 'messageJump':
    case 'clearConfirmSetValue':
    case 'checkpointReceived':
    case 'rewindOverlayOpen':
    case 'setSteering':
    case 'goalRunInit':
    case 'goalRunPhaseUpdate':
    case 'goalRunRunningPhases':
    case 'goalRunElapsed':
    case 'goalRunTaskActive':
    case 'goalRunTaskAgent':
    case 'goalRunPhaseStatus':
    case 'goalRunTaskCompleted':
    case 'sddBoardSnapshot':
    case 'worktreeUpsert':
    case 'worktreeRemove':
    case 'collabBugFound':
    case 'collabSessionDone':
    case 'collabSubagentSpawned':
    case 'debugStreamStats':
    case 'countdownTick':
      return validateDisplayAction(action, type, normalized, payload);

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
        return {
          valid: false,
          error: `sessionsPanelSet.sessions: ${sessions.length} exceeds max 200.`,
        };
      }
      return { valid: true, value: payload };
    }

    case 'sessionsPanelBusy': {
      if (typeof action.on !== 'boolean') {
        return { valid: false, error: 'sessionsPanelBusy.on: not a boolean.' };
      }
      return { valid: true, value: payload };
    }

    case 'topicCheckBusy': {
      if (typeof action.on !== 'boolean') {
        return { valid: false, error: 'topicCheckBusy.on: not a boolean.' };
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

    default:
      // Actions with no payload or a trivial one (toggles, picker open/close,
      // stream lifecycle) land here. The exact Action-union allow-list above
      // is compile-time exhaustive.
      // Actions without extra field constraints still pass the generic depth
      // and string-size checks. Requiring a second exhaustive switch list here
      // previously let valid reducer actions drift out of sync and silently
      // disabled large parts of the TUI.
      return { valid: true, value: payload };
  }
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
