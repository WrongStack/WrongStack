import { expectDefined } from '@wrongstack/core';
import type { Action, QueueItem, State } from './app-state.js';
import {
  AUTH_PANEL_INITIAL,
  type AuthPanelState,
  authMoveSelected,
  authPanelRows,
} from './components/auth-panel-model.js';
// Reducer — pure state transformation. Types are in app-state.ts.
// This file has NO React or Ink dependencies.
import type { HistoryEntry } from './components/history.js';
import { filterPromptPicker } from './components/prompt-picker.js';
import { nextSendModeIndex, SEND_MODE_OPTIONS } from './components/send-mode-picker.js';
import type { AnimationStyleChoice } from './components/settings-picker.js';
import {
  ANIMATION_STYLE_CHOICES,
  AUDIT_LEVELS,
  AUTO_PROCEED_MAX_PRESETS,
  CACHE_TTLS,
  COMPACTOR_STRATEGIES,
  CONFIG_SCOPES,
  CONTEXT_MODES,
  DELAY_PRESETS_MS,
  ENHANCE_DELAY_PRESETS,
  ENHANCE_LANGUAGES,
  LOG_LEVELS,
  MAX_CONCURRENT_PRESETS,
  MAX_ITERATIONS_PRESETS,
  MULTI_DIFF_SUMMARY_THRESHOLD_PRESETS,
  REASONING_EFFORTS,
  REASONING_MODES,
  SETTINGS_FIELD_COUNT,
  SETTINGS_MODES,
  STATUSLINE_MODES,
  THINKING_WORD_FIELD,
  THINKING_WORD_PRESETS,
  TOKEN_SAVING_TIERS,
} from './components/settings-picker.js';
import { type ChipMeta, STATUSLINE_FIELD_COUNT } from './components/statusline-picker.js';
import type { WorktreeRow } from './components/worktree-panel.js';
import { reduceFleetState } from './reducers/fleet.js';

import {
  closePanels,
  firstSelectable,
  MAX_TOOL_STREAM_RETAINED_CHARS,
  pruneToolInput,
  skipDivider,
} from './reducers/helpers.js';
import { MAX_TUI_THINKING_WORD_LENGTH, normalizeTuiThinkingWord } from './thinking-word.js';

// Re-export types from app-state.ts for backward compatibility.
export type {
  Action,
  DraftEntry,
  FleetEntry,
  GoalSummary,
  QueueItem,
  ResumeSessionEntry,
  Settings,
  SlashCommandMatch,
  State,
} from './app-state.js';
// Re-export extracted functions for backward compatibility.
// Tests may import directly from app-reducer.js rather than reducers/helpers.js.
export { firstSelectable, pruneToolInput, skipDivider } from './reducers/helpers.js';

/** Keep the auth-panel cursor inside the current view's row list. */
function clampAuthSelected(panel: AuthPanelState): number {
  const count = authPanelRows(panel).length;
  if (count === 0) return 0;
  return Math.min(panel.selected, count - 1);
}

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'addEntry': {
      // Append-only. We render finalized entries via Ink's <Static>,
      // which forbids removals or reordering — old items live on in the
      // terminal's native scrollback. The terminal bounds what's VISIBLE,
      // not this process's heap: the entries array itself is retained for
      // the whole session, so large per-entry payloads (tool inputs) are
      // pruned via pruneToolInput before storage.
      //
      // Guard: skip entries with empty text for text-bearing kinds.
      // During the enhance/refine countdown, re-renders combined with
      // live-region erasure can produce blank entries that pollute the
      // chat and desync the scrollback.
      const e = action.entry;
      if (
        (e.kind === 'user' ||
          e.kind === 'assistant' ||
          e.kind === 'thinking' ||
          e.kind === 'info' ||
          e.kind === 'warn' ||
          e.kind === 'error' ||
          e.kind === 'turn-summary') &&
        !(e as { text?: string | undefined }).text?.trim()
      ) {
        return state;
      }
      const stored =
        e.kind === 'tool' && e.input !== undefined ? { ...e, input: pruneToolInput(e.input) } : e;
      const appended = [...state.entries, { ...stored, id: state.nextId } as HistoryEntry];
      return { ...state, entries: appended, nextId: state.nextId + 1 };
    }
    case 'setBuffer':
      return { ...state, buffer: action.buffer, cursor: action.cursor };
    case 'clearInput':
      return {
        ...state,
        buffer: '',
        cursor: 0,
        historyIndex: 0,
        historyDraft: '',
        picker: { open: false, query: '', matches: [], selected: 0 },
        slashPicker: { open: false, query: '', matches: [], selected: 0 },
      };
    case 'clearHistory': {
      // Keep only the banner entry (always first, id=0). Any other entries
      // (user messages, assistant responses, slash results) are discarded so
      // the TUI starts fresh after /clear.
      const banner = state.entries.find((e) => e.kind === 'banner');
      return {
        ...state,
        entries: banner ? [banner] : [],
        queue: [],
        nextQueueId: 1,
        scrollOffset: 0,
        pendingNewLines: 0,
        // Bump the generation so <Static> remounts — without this, Ink's
        // already-written index exceeds the new (shorter) array and the
        // committed entries stay on screen even though `state.entries` no
        // longer references them. /clear would otherwise appear to do
        // nothing to the visible chat history.
        historyGen: state.historyGen + 1,
        // Reset fleet state on /clear so old subagent entries don't
        // cause the LiveActivityStrip to render stale spacers, and
        // the fleet cost/tokens chips show zero.
        fleet: {},
        fleetCost: 0,
        fleetTokens: { input: 0, output: 0 },
        leader: {
          iterations: 0,
          toolCalls: 0,
          recentTools: [],
          currentTool: undefined,
          startedAt: Date.now(),
          lastEventAt: Date.now(),
          iterating: false,
        },
      };
    }
    case 'streamDelta':
      return { ...state, streamingText: state.streamingText + action.delta };
    case 'streamReset':
      return { ...state, streamingText: '' };
    case 'status':
      // Going idle means the stream has finished — clear any lingering
      // debug-stream stats so the statusline doesn't show stale "🐛 stream".
      if (action.status === 'idle') {
        return { ...state, status: 'idle', debugStreamStats: null };
      }
      return { ...state, status: action.status };
    case 'interrupt':
      return { ...state, interrupts: state.interrupts + 1 };
    case 'steerStart':
      return { ...state, steeringPending: true, steerSnapshot: action.snapshot };
    case 'steerConsume':
      return { ...state, steeringPending: false, steerSnapshot: null, interrupts: 0 };
    case 'resetInterrupts':
      return { ...state, interrupts: 0 };
    case 'hint':
      return { ...state, hint: action.text };
    case 'brainStatus':
      return {
        ...state,
        brain: {
          state: action.state,
          source: action.source,
          risk: action.risk,
          summary: action.summary,
          updatedAt: Date.now(),
        },
      };
    case 'brainPromptSet':
      return { ...state, brainPrompt: action.prompt };
    case 'brainPromptClear':
      return { ...state, brainPrompt: null };
    case 'pickerOpen':
      return {
        ...state,
        picker: { open: true, query: action.query, matches: state.picker.matches, selected: 0 },
      };
    case 'pickerClose':
      return {
        ...state,
        picker: { open: false, query: '', matches: [], selected: 0 },
      };
    case 'pickerSetMatches':
      // Guard against stale async results — only apply if query still matches.
      if (!state.picker.open || state.picker.query !== action.query) return state;
      return {
        ...state,
        picker: {
          ...state.picker,
          matches: action.matches,
          selected: Math.min(state.picker.selected, Math.max(0, action.matches.length - 1)),
        },
      };
    case 'pickerMove': {
      const n = state.picker.matches.length;
      if (n === 0) return state;
      const next = (state.picker.selected + action.delta + n) % n;
      return { ...state, picker: { ...state.picker, selected: next } };
    }
    case 'toolStarted': {
      const next = new Map(state.runningTools);
      next.set(action.id, { name: action.name, startedAt: Date.now() });
      return { ...state, runningTools: next };
    }
    case 'toolEnded': {
      const next = new Map(state.runningTools);
      if (action.id !== undefined && next.has(action.id)) {
        next.delete(action.id);
        return { ...state, runningTools: next };
      }
      if (action.name !== undefined) {
        // Fall back to clearing the oldest running entry with this name —
        // `tool.executed` doesn't carry the tool_use id, so we approximate.
        for (const [id, info] of next) {
          if (info.name === action.name) {
            next.delete(id);
            return { ...state, runningTools: next };
          }
        }
      }
      return state;
    }
    case 'toolStreamAppend': {
      // Only one tool's stream is shown at a time. If a different tool is
      // currently streaming, switch — last writer wins. Streams from
      // not-yet-acknowledged tools take over as soon as data arrives, which
      // matches user intuition (whatever just produced output is what's
      // visible).
      const cur = state.toolStream;
      if (cur && cur.toolUseId === action.toolUseId) {
        // Keep only the tail: the live box renders just the last few lines,
        // but the accumulated string is retained in React state for the whole
        // life of the tool call — a chatty long-running command (vitest, a
        // build) would otherwise grow it into the tens of MB.
        const combined = cur.text + action.text;
        const text =
          combined.length > MAX_TOOL_STREAM_RETAINED_CHARS
            ? combined.slice(-MAX_TOOL_STREAM_RETAINED_CHARS)
            : combined;
        return {
          ...state,
          toolStream: { ...cur, text },
        };
      }
      return {
        ...state,
        toolStream: {
          toolUseId: action.toolUseId,
          name: action.name,
          text: action.text,
          startedAt: action.startedAt,
        },
      };
    }
    case 'toolStreamClear': {
      if (state.toolStream === null) return state;
      // Clear only when the finishing tool matches the streaming one. A
      // stale `tool.executed` for a different tool must not blank the
      // currently-visible stream.
      const t = state.toolStream;
      if (action.toolUseId !== undefined && action.toolUseId !== t.toolUseId) return state;
      if (action.name !== undefined && action.toolUseId === undefined && action.name !== t.name)
        return state;
      return { ...state, toolStream: null };
    }
    case 'enqueue': {
      const item: QueueItem = { ...action.item, id: state.nextQueueId };
      return {
        ...state,
        queue: [...state.queue, item],
        nextQueueId: state.nextQueueId + 1,
      };
    }
    case 'dequeueFirst': {
      if (state.queue.length === 0) return state;
      return { ...state, queue: state.queue.slice(1) };
    }
    case 'queueClear': {
      if (state.queue.length === 0) return state;
      return { ...state, queue: [] };
    }
    case 'queueDelete': {
      if (state.queue.length === 0 || action.positions.length === 0) return state;
      // Positions are 1-based; convert to 0-based set for fast filtering.
      const drop = new Set(action.positions.map((p) => p - 1).filter((i) => i >= 0));
      const filtered = state.queue.filter((_, i) => !drop.has(i));
      if (filtered.length === state.queue.length) return state;
      return { ...state, queue: filtered };
    }
    case 'slashPickerOpen':
      return {
        ...state,
        slashPicker: { open: true, query: action.query, matches: action.matches, selected: 0 },
      };
    case 'slashPickerClose':
      return {
        ...state,
        slashPicker: { open: false, query: '', matches: [], selected: 0 },
      };
    case 'slashPickerMove': {
      const n = state.slashPicker.matches.length;
      if (n === 0) return state;
      const next = (state.slashPicker.selected + action.delta + n) % n;
      return { ...state, slashPicker: { ...state.slashPicker, selected: next } };
    }
    case 'historyPush': {
      if (action.text === '' || action.text === state.inputHistory[0]) return state;
      return { ...state, inputHistory: [action.text, ...state.inputHistory].slice(0, 100) };
    }
    case 'historyUp': {
      if (state.inputHistory.length === 0) return state;
      const next = Math.min(state.historyIndex + 1, state.inputHistory.length);
      const entry = state.inputHistory[next - 1] ?? '';
      // On the first Up (index 0 -> 1), snapshot the in-progress draft so
      // historyDown back to index 0 can restore it instead of clearing the
      // buffer. Without this, peeking at history loses a half-typed prompt.
      const historyDraft = state.historyIndex === 0 ? state.buffer : state.historyDraft;
      return {
        ...state,
        historyIndex: next,
        buffer: entry,
        cursor: entry.length,
        historyDraft,
      };
    }
    case 'historyDown': {
      if (state.historyIndex === 0) return state;
      const next = state.historyIndex - 1;
      // Returning to index 0 restores the draft captured on the first Up,
      // so the user's in-progress prompt survives a history peek.
      const entry = next === 0 ? state.historyDraft : (state.inputHistory[next - 1] ?? '');
      return {
        ...state,
        historyIndex: next,
        buffer: entry,
        cursor: entry.length,
        // Clear the draft snapshot once we're back at the buffer; the next
        // Up will capture whatever the user has typed by then.
        historyDraft: next === 0 ? '' : state.historyDraft,
      };
    }
    case 'setInputHistory': {
      // Replace the in-memory history entirely (used by the persistence
      // layer on mount to seed state.inputHistory from disk). We do NOT
      // touch buffer/cursor/historyIndex — this only refreshes the list
      // the Up/Down keys walk through.
      return { ...state, inputHistory: action.entries.slice(0, 100) };
    }
    case 'clearInputHistory': {
      // /clear: drop every remembered prompt. In-memory only; the disk
      // file is cleared separately via the InputHistoryStore.clear() side
      // effect in app.tsx.
      return { ...state, inputHistory: [], historyIndex: 0, historyDraft: '' };
    }
    case 'modelPickerOpen':
      return {
        ...state,
        ...closePanels(state),
        modelPicker: {
          open: true,
          step: 'provider',
          providerOptions: action.providers,
          modelOptions: [],
          filteredOptions: [],
          selected: 0,
          hint: undefined,
          searchQuery: '',
        },
      };
    case 'modelPickerClose':
      return {
        ...state,
        modelPicker: {
          open: false,
          step: 'provider',
          providerOptions: [],
          modelOptions: [],
          filteredOptions: [],
          selected: 0,
          searchQuery: '',
        },
      };
    case 'modelPickerMove': {
      if (!state.modelPicker.open) return state;
      const list =
        state.modelPicker.step === 'provider'
          ? state.modelPicker.providerOptions
          : state.modelPicker.filteredOptions;
      const len = list.length;
      if (len === 0) return state;
      const next = (state.modelPicker.selected + action.delta + len) % len;
      return {
        ...state,
        modelPicker: { ...state.modelPicker, selected: next },
      };
    }
    case 'modelPickerPickProvider':
      return {
        ...state,
        modelPicker: {
          ...state.modelPicker,
          step: 'model',
          modelOptions: action.models,
          filteredOptions: action.models,
          selected: 0,
          pickedProviderId: action.providerId,
          hint: undefined,
          searchQuery: '',
        },
      };
    case 'modelPickerBack':
      return {
        ...state,
        modelPicker: {
          ...state.modelPicker,
          step: 'provider',
          modelOptions: [],
          filteredOptions: [],
          selected: 0,
          pickedProviderId: undefined,
          hint: undefined,
          searchQuery: '',
        },
      };
    case 'modelPickerSearch': {
      if (!state.modelPicker.open || state.modelPicker.step !== 'model') return state;
      const q = action.query.toLowerCase();
      const filtered = q
        ? state.modelPicker.modelOptions.filter((id) => id.toLowerCase().includes(q))
        : state.modelPicker.modelOptions;
      const selected =
        filtered.length > 0 ? Math.min(state.modelPicker.selected, filtered.length - 1) : 0;
      return {
        ...state,
        modelPicker: {
          ...state.modelPicker,
          filteredOptions: filtered,
          selected,
          searchQuery: action.query,
          hint: undefined,
        },
      };
    }
    case 'modelPickerHint':
      return {
        ...state,
        modelPicker: { ...state.modelPicker, hint: action.text },
      };
    case 'autonomyPickerOpen':
      return {
        ...state,
        ...closePanels(state),
        autonomyPicker: { open: true, options: action.options, selected: 0, hint: undefined },
      };
    case 'autonomyPickerClose':
      return {
        ...state,
        autonomyPicker: { open: false, options: [], selected: 0 },
      };
    case 'autonomyPickerMove': {
      const n = state.autonomyPicker.options.length;
      if (n === 0) return state;
      const next = (state.autonomyPicker.selected + action.delta + n) % n;
      return {
        ...state,
        autonomyPicker: { ...state.autonomyPicker, selected: next },
      };
    }
    case 'autonomyPickerHint':
      return {
        ...state,
        autonomyPicker: { ...state.autonomyPicker, hint: action.text },
      };
    case 'modePickerOpen':
      return {
        ...state,
        ...closePanels(state),
        modePicker: { open: true, modes: action.modes, selected: 0, hint: undefined },
      };
    case 'modePickerClose':
      return {
        ...state,
        modePicker: { open: false, modes: [], selected: 0 },
      };
    case 'modePickerMove': {
      const n = state.modePicker.modes.length;
      if (n === 0) return state;
      const next = (state.modePicker.selected + action.delta + n) % n;
      return {
        ...state,
        modePicker: { ...state.modePicker, selected: next },
      };
    }
    case 'modePickerHint':
      return {
        ...state,
        modePicker: { ...state.modePicker, hint: action.text },
      };
    case 'designPickerOpen':
      return {
        ...state,
        ...closePanels(state),
        designPicker: {
          open: true,
          kits: action.kits,
          selected: 0,
          stack: state.designPicker.stack || 'web',
        },
      };
    case 'designPickerClose':
      return {
        ...state,
        designPicker: { ...state.designPicker, open: false },
      };
    case 'designPickerMove': {
      const n = state.designPicker.kits.length;
      if (n === 0) return state;
      const next = (state.designPicker.selected + action.delta + n) % n;
      return {
        ...state,
        designPicker: { ...state.designPicker, selected: next },
      };
    }
    case 'designPickerStack':
      return {
        ...state,
        designPicker: { ...state.designPicker, stack: action.stack },
      };
    case 'promptPickerOpen':
      return {
        ...state,
        ...closePanels(state),
        promptPicker: {
          open: true,
          all: action.all,
          categories: action.categories,
          recentSlugs: action.recentSlugs,
          catIndex: 0,
          selected: 0,
        },
      };
    case 'promptPickerClose':
      return {
        ...state,
        promptPicker: { ...state.promptPicker, open: false },
      };
    case 'promptPickerMove': {
      const filt = filterPromptPicker(
        state.promptPicker.all,
        state.promptPicker.categories,
        state.promptPicker.catIndex,
        state.promptPicker.recentSlugs,
      );
      const n = filt.length;
      if (n === 0) return state;
      const next = (state.promptPicker.selected + action.delta + n) % n;
      return { ...state, promptPicker: { ...state.promptPicker, selected: next } };
    }
    case 'promptPickerCategory': {
      const m = state.promptPicker.categories.length;
      if (m === 0) return state;
      const catIndex = (state.promptPicker.catIndex + action.delta + m) % m;
      return { ...state, promptPicker: { ...state.promptPicker, catIndex, selected: 0 } };
    }
    case 'resumePickerOpen':
      return {
        ...state,
        ...closePanels(state),
        resumePicker: {
          open: true,
          sessions: action.sessions,
          selected: 0,
          busy: false,
          hint: undefined,
          error: undefined,
        },
      };
    case 'resumePickerClose':
      return {
        ...state,
        resumePicker: {
          open: false,
          sessions: [],
          selected: 0,
          busy: false,
          hint: undefined,
          error: undefined,
        },
      };
    case 'resumePickerMove': {
      const nr = state.resumePicker.sessions.length;
      if (nr === 0) return state;
      const nextR = (state.resumePicker.selected + action.delta + nr) % nr;
      return { ...state, resumePicker: { ...state.resumePicker, selected: nextR } };
    }
    case 'resumePickerBusy':
      return { ...state, resumePicker: { ...state.resumePicker, busy: action.on } };
    case 'resumePickerHint':
      return { ...state, resumePicker: { ...state.resumePicker, hint: action.text } };
    case 'resumePickerError':
      return { ...state, resumePicker: { ...state.resumePicker, error: action.text, busy: false } };
    case 'replaceHistory': {
      // Preserve any existing banner entries (kind='banner') and prepend them
      // to the replayed history so the startup greeting survives a resume.
      const banners = state.entries.filter((e) => e.kind === 'banner');
      // Re-compute entry ids to avoid collisions: banners stay at their original
      // ids, replayed entries shift to start after the last banner id.
      const maxBannerId = banners.length > 0 ? Math.max(...banners.map((b) => b.id)) : 0;
      const shifted = action.entries.map((e, i) => ({ ...e, id: maxBannerId + 1 + i }));
      const nextId = maxBannerId + 1 + shifted.length;
      // Bump the generation so <Static> remounts — without this, Ink's
      // already-written index exceeds the new array and the replayed
      // entries never print (or print from a random offset).
      return {
        ...state,
        entries: [...banners, ...shifted],
        nextId,
        historyGen: state.historyGen + 1,
      };
    }
    case 'settingsOpen':
      return {
        ...state,
        ...closePanels(state),
        settingsPicker: {
          open: true,
          // The persisted `lastSettingsField` (from the canonical Settings
          // shape) drives where the picker lands on open. The slice's
          // `field` is a working copy that mirrors it until the user
          // navigates again. `state.settingsPicker.lastSettingsField` is
          // the fallback for the (rare) case where the action omits it
          // — e.g., a tests/dispatch path that hasn't been updated yet.
          // `||` (not `??`): a payload `lastSettingsField` of 0 means
          // "no saved value" (the default in the canonical Settings),
          // so we fall through to the runtime state's tracked value.
          // This lets the in-session `settingsFieldSet`/`settingsFieldMove`
          // preserve the field across close/reopen within the same session,
          // while a non-zero persisted value (loaded from disk) takes
          // priority on a fresh open.
          field: action.lastSettingsField || state.settingsPicker.lastSettingsField || 0,
          lastSettingsField:
            action.lastSettingsField || state.settingsPicker.lastSettingsField || 0,
          mode: action.mode,
          delayMs: action.delayMs,
          titleAnimation: action.titleAnimation,
          yolo: action.yolo,
          streamFleet: action.streamFleet,
          chime: action.chime,
          confirmExit: action.confirmExit,
          nextPrediction: action.nextPrediction,
          featureMcp: action.featureMcp,
          featurePlugins: action.featurePlugins,
          featureMemory: action.featureMemory,
          featureSkills: action.featureSkills,
          featureModelsRegistry: action.featureModelsRegistry,
          tokenSavingTier: action.tokenSavingTier,
          allowOutsideProjectRoot: action.allowOutsideProjectRoot,
          contextAutoCompact: action.contextAutoCompact,
          contextStrategy: action.contextStrategy,
          contextMode: action.contextMode,
          maxConcurrent: action.maxConcurrent,
          logLevel: action.logLevel,
          auditLevel: action.auditLevel,
          indexOnStart: action.indexOnStart,
          multiDiffSummaryThreshold: action.multiDiffSummaryThreshold,
          maxIterations: action.maxIterations,
          autoProceedMaxIterations: action.autoProceedMaxIterations,
          enhanceDelayMs: action.enhanceDelayMs,
          enhanceEnabled: action.enhanceEnabled,
          enhanceLanguage: action.enhanceLanguage,
          debugStream: action.debugStream,
          statuslineMode: action.statuslineMode,
          reasoningMode: action.reasoningMode,
          reasoningEffort: action.reasoningEffort,
          reasoningPreserve: action.reasoningPreserve,
          thinkingWord: action.thinkingWord,
          thinkingWordEditing: false,
          thinkingWordDraft: '',
          // Filter is always cleared on open — the user starts fresh.
          // Persisted `lastSettingsField` is restored separately above.
          filter: '',
          cacheTtl: action.cacheTtl,
          configScope: action.configScope,
          animationStyle: action.animationStyle,
          hint: undefined,
        },
      };
    case 'settingsClose':
      return {
        ...state,
        settingsPicker: { ...state.settingsPicker, open: false, hint: undefined },
      };
    case 'settingsFieldMove': {
      const next =
        (state.settingsPicker.field + action.delta + SETTINGS_FIELD_COUNT) % SETTINGS_FIELD_COUNT;
      // Moving focus abandons any in-progress thinking-word edit so the draft
      // can't linger on an unrelated field. `lastSettingsField` tracks the
      // current focus so the canonical Settings shape stays in sync — the
      // app.tsx auto-save effect writes it back to disk.
      return {
        ...state,
        settingsPicker: {
          ...state.settingsPicker,
          field: next,
          lastSettingsField: next,
          thinkingWordEditing: false,
          thinkingWordDraft: '',
          hint: undefined,
        },
      };
    }
    case 'settingsFieldSet': {
      const field = action.field >= 0 && action.field < SETTINGS_FIELD_COUNT ? action.field : 0;
      // Keep `lastSettingsField` in sync with the new focus so the
      // canonical Settings shape reflects the user's most recent pick
      // even if the picker is closed before the auto-save effect fires.
      return {
        ...state,
        settingsPicker: {
          ...state.settingsPicker,
          field,
          lastSettingsField: field,
          hint: undefined,
        },
      };
    }
    case 'settingsFilterSet':
      // Live filter for the row-search modal. Setting a non-empty value
      // implicitly activates filter mode; setting '' clears it. The
      // `lastSettingsField` is intentionally untouched — a filter is
      // navigation, not a value the user is "configuring".
      return {
        ...state,
        settingsPicker: { ...state.settingsPicker, filter: action.filter },
      };
    case 'settingsValueChange': {
      const sp = state.settingsPicker;
      const f = sp.field;
      // Boot-only settings can't be applied to the running session — they are
      // loaded at startup (feature toggles, index-on-start) or require
      // rebinding subsystems (compactor strategy). Surface a hint when one of
      // these is changed so the user knows a restart is needed; all other
      // fields apply live (see cli-main applyLiveSettings + TUI live refs).
      const bootHint = '↻ Takes effect next session';
      // Field 0: autonomy mode (cycle SETTINGS_MODES)
      if (f === 0) {
        const i = SETTINGS_MODES.indexOf(sp.mode);
        const base = i < 0 ? 0 : i;
        const next = (base + action.delta + SETTINGS_MODES.length) % SETTINGS_MODES.length;
        return {
          ...state,
          settingsPicker: { ...sp, mode: expectDefined(SETTINGS_MODES[next]), hint: undefined },
        };
      }
      // Field 1: delay presets
      if (f === 1) {
        const j = DELAY_PRESETS_MS.indexOf(sp.delayMs);
        const base = j < 0 ? 0 : j;
        const next = (base + action.delta + DELAY_PRESETS_MS.length) % DELAY_PRESETS_MS.length;
        return {
          ...state,
          settingsPicker: {
            ...sp,
            delayMs: expectDefined(DELAY_PRESETS_MS[next]),
            hint: undefined,
          },
        };
      }
      // Field 2–7: UX boolean toggles
      if (f === 2)
        return {
          ...state,
          settingsPicker: { ...sp, titleAnimation: !sp.titleAnimation, hint: undefined },
        };
      if (f === 3) return { ...state, settingsPicker: { ...sp, yolo: !sp.yolo, hint: undefined } };
      if (f === 4)
        return {
          ...state,
          settingsPicker: { ...sp, streamFleet: !sp.streamFleet, hint: undefined },
        };
      if (f === 5)
        return { ...state, settingsPicker: { ...sp, chime: !sp.chime, hint: undefined } };
      if (f === 6)
        return {
          ...state,
          settingsPicker: { ...sp, confirmExit: !sp.confirmExit, hint: undefined },
        };
      if (f === 7)
        return {
          ...state,
          settingsPicker: { ...sp, nextPrediction: !sp.nextPrediction, hint: undefined },
        };
      // Field 8–12: Features boolean toggles
      if (f === 8)
        return { ...state, settingsPicker: { ...sp, featureMcp: !sp.featureMcp, hint: bootHint } };
      if (f === 9)
        return {
          ...state,
          settingsPicker: { ...sp, featurePlugins: !sp.featurePlugins, hint: bootHint },
        };
      if (f === 10)
        return {
          ...state,
          settingsPicker: { ...sp, featureMemory: !sp.featureMemory, hint: bootHint },
        };
      if (f === 11)
        return {
          ...state,
          settingsPicker: { ...sp, featureSkills: !sp.featureSkills, hint: bootHint },
        };
      if (f === 12)
        return {
          ...state,
          settingsPicker: {
            ...sp,
            featureModelsRegistry: !sp.featureModelsRegistry,
            hint: bootHint,
          },
        };
      // Field 13: Token-saving tier (cycle)
      if (f === 13) {
        const i = TOKEN_SAVING_TIERS.indexOf(
          sp.tokenSavingTier as (typeof TOKEN_SAVING_TIERS)[number],
        );
        const base = i < 0 ? 0 : i;
        const next = (base + action.delta + TOKEN_SAVING_TIERS.length) % TOKEN_SAVING_TIERS.length;
        return {
          ...state,
          settingsPicker: {
            ...sp,
            tokenSavingTier: TOKEN_SAVING_TIERS[next] ?? 'off',
            hint: bootHint,
          },
        };
      }
      // Field 14: allow outside project root (boolean)
      if (f === 14)
        return {
          ...state,
          settingsPicker: {
            ...sp,
            allowOutsideProjectRoot: !sp.allowOutsideProjectRoot,
            hint: undefined,
          },
        };
      // ── Tools ──────────────────────────────────────────────────────────────
      // Field 15: max iterations (cycle presets)
      if (f === 15) {
        const j = MAX_ITERATIONS_PRESETS.indexOf(sp.maxIterations);
        const base = j < 0 ? 0 : j;
        const next =
          (base + action.delta + MAX_ITERATIONS_PRESETS.length) % MAX_ITERATIONS_PRESETS.length;
        return {
          ...state,
          settingsPicker: {
            ...sp,
            maxIterations: expectDefined(MAX_ITERATIONS_PRESETS[next]),
            hint: undefined,
          },
        };
      }
      // Field 16: auto-proceed max iterations (cycle presets)
      if (f === 16) {
        const aj = AUTO_PROCEED_MAX_PRESETS.indexOf(sp.autoProceedMaxIterations);
        const abase = aj < 0 ? 0 : aj;
        const anext =
          (abase + action.delta + AUTO_PROCEED_MAX_PRESETS.length) %
          AUTO_PROCEED_MAX_PRESETS.length;
        return {
          ...state,
          settingsPicker: {
            ...sp,
            autoProceedMaxIterations: expectDefined(AUTO_PROCEED_MAX_PRESETS[anext]),
            hint: undefined,
          },
        };
      }
      // Field 17: enhance delay (cycle presets)
      if (f === 17) {
        const ej = ENHANCE_DELAY_PRESETS.indexOf(sp.enhanceDelayMs);
        const ebase = ej < 0 ? 0 : ej;
        const enext =
          (ebase + action.delta + ENHANCE_DELAY_PRESETS.length) % ENHANCE_DELAY_PRESETS.length;
        return {
          ...state,
          settingsPicker: {
            ...sp,
            enhanceDelayMs: expectDefined(ENHANCE_DELAY_PRESETS[enext]),
            hint: undefined,
          },
        };
      }
      // Field 18: enhance enabled (boolean)
      if (f === 18)
        return {
          ...state,
          settingsPicker: { ...sp, enhanceEnabled: !sp.enhanceEnabled, hint: undefined },
        };
      // Field 19: enhance language (cycle original/english)
      if (f === 19) {
        const i = ENHANCE_LANGUAGES.indexOf(sp.enhanceLanguage);
        const base = i < 0 ? 0 : i;
        const next = (base + action.delta + ENHANCE_LANGUAGES.length) % ENHANCE_LANGUAGES.length;
        return {
          ...state,
          settingsPicker: {
            ...sp,
            enhanceLanguage: expectDefined(ENHANCE_LANGUAGES[next]),
            hint: undefined,
          },
        };
      }
      // Field 20: index on start (boolean)
      if (f === 20)
        return {
          ...state,
          settingsPicker: { ...sp, indexOnStart: !sp.indexOnStart, hint: bootHint },
        };
      // Field 21: multi-diff summary threshold (cycle presets). 0 disables
      // the summary footer; positive values set the minimum file count.
      if (f === 21) {
        const j = MULTI_DIFF_SUMMARY_THRESHOLD_PRESETS.indexOf(sp.multiDiffSummaryThreshold);
        const base = j < 0 ? 0 : j;
        const next =
          (base + action.delta + MULTI_DIFF_SUMMARY_THRESHOLD_PRESETS.length) %
          MULTI_DIFF_SUMMARY_THRESHOLD_PRESETS.length;
        const multiDiffSummaryThreshold = expectDefined(MULTI_DIFF_SUMMARY_THRESHOLD_PRESETS[next]);
        return {
          ...state,
          settingsPicker: { ...sp, multiDiffSummaryThreshold, hint: undefined },
        };
      }
      // Field 22: thinking word — ←/→ cycles curated presets (Enter opens
      // free-text editing, handled by the settingsThinkingEdit* actions). The
      // current word is folded into the list so cycling never drops a custom
      // value set via the editor or config.
      if (f === THINKING_WORD_FIELD) {
        const cur = sp.thinkingWord;
        const list: string[] = (THINKING_WORD_PRESETS as readonly string[]).includes(cur)
          ? [...THINKING_WORD_PRESETS]
          : [cur, ...THINKING_WORD_PRESETS];
        const i = list.indexOf(cur);
        const base = i < 0 ? 0 : i;
        const next = (base + action.delta + list.length) % list.length;
        return {
          ...state,
          settingsPicker: { ...sp, thinkingWord: expectDefined(list[next]), hint: undefined },
        };
      }
      // ── Reasoning ───────────────────────────────────────────────────────────
      // Field 23: reasoning mode (cycle auto/on/off)
      if (f === 23) {
        const i = REASONING_MODES.indexOf(sp.reasoningMode as (typeof REASONING_MODES)[number]);
        const base = i < 0 ? 0 : i;
        const next = (base + action.delta + REASONING_MODES.length) % REASONING_MODES.length;
        return {
          ...state,
          settingsPicker: {
            ...sp,
            reasoningMode: expectDefined(REASONING_MODES[next]),
            hint: undefined,
          },
        };
      }
      // Field 24: reasoning effort (cycle)
      if (f === 24) {
        const i = REASONING_EFFORTS.indexOf(
          sp.reasoningEffort as (typeof REASONING_EFFORTS)[number],
        );
        const base = i < 0 ? REASONING_EFFORTS.indexOf('high') : i;
        const next = (base + action.delta + REASONING_EFFORTS.length) % REASONING_EFFORTS.length;
        return {
          ...state,
          settingsPicker: {
            ...sp,
            reasoningEffort: expectDefined(REASONING_EFFORTS[next]),
            hint: undefined,
          },
        };
      }
      // Field 25: reasoning preserve (boolean toggle)
      if (f === 25)
        return {
          ...state,
          settingsPicker: { ...sp, reasoningPreserve: !sp.reasoningPreserve, hint: undefined },
        };
      // Field 26: cache TTL (cycle default/5m/1h)
      if (f === 26) {
        const i = CACHE_TTLS.indexOf(sp.cacheTtl as (typeof CACHE_TTLS)[number]);
        const base = i < 0 ? 0 : i;
        const next = (base + action.delta + CACHE_TTLS.length) % CACHE_TTLS.length;
        return {
          ...state,
          settingsPicker: { ...sp, cacheTtl: expectDefined(CACHE_TTLS[next]), hint: undefined },
        };
      }
      // ── Context ────────────────────────────────────────────────────────────
      // Field 27: context auto-compact (boolean)
      if (f === 27)
        return {
          ...state,
          settingsPicker: { ...sp, contextAutoCompact: !sp.contextAutoCompact, hint: undefined },
        };
      // Field 28: compactor strategy (cycle)
      if (f === 28) {
        const i = COMPACTOR_STRATEGIES.indexOf(sp.contextStrategy);
        const base = i < 0 ? 0 : i;
        const next =
          (base + action.delta + COMPACTOR_STRATEGIES.length) % COMPACTOR_STRATEGIES.length;
        return {
          ...state,
          settingsPicker: {
            ...sp,
            contextStrategy: expectDefined(COMPACTOR_STRATEGIES[next]),
            hint: bootHint,
          },
        };
      }
      // Field 29: context mode (cycle)
      if (f === 29) {
        const i = CONTEXT_MODES.indexOf(sp.contextMode);
        const base = i < 0 ? 0 : i;
        const next = (base + action.delta + CONTEXT_MODES.length) % CONTEXT_MODES.length;
        return {
          ...state,
          settingsPicker: {
            ...sp,
            contextMode: expectDefined(CONTEXT_MODES[next]),
            hint: bootHint,
          },
        };
      }
      // ── Fleet ──────────────────────────────────────────────────────────────
      // Field 30: max concurrent (cycle presets)
      if (f === 30) {
        const j = MAX_CONCURRENT_PRESETS.indexOf(sp.maxConcurrent);
        const base = j < 0 ? 0 : j;
        const next =
          (base + action.delta + MAX_CONCURRENT_PRESETS.length) % MAX_CONCURRENT_PRESETS.length;
        const maxConcurrent = expectDefined(MAX_CONCURRENT_PRESETS[next]);
        return {
          ...state,
          settingsPicker: {
            ...sp,
            maxConcurrent,
            hint: maxConcurrent === 0 ? bootHint : undefined,
          },
        };
      }
      // ── Logging ────────────────────────────────────────────────────────────
      // Field 31: log level (cycle)
      if (f === 31) {
        const i = LOG_LEVELS.indexOf(sp.logLevel);
        const base = i < 0 ? 0 : i;
        const next = (base + action.delta + LOG_LEVELS.length) % LOG_LEVELS.length;
        return {
          ...state,
          settingsPicker: { ...sp, logLevel: expectDefined(LOG_LEVELS[next]), hint: undefined },
        };
      }
      // Field 32: audit level (cycle)
      if (f === 32) {
        const i = AUDIT_LEVELS.indexOf(sp.auditLevel);
        const base = i < 0 ? 0 : i;
        const next = (base + action.delta + AUDIT_LEVELS.length) % AUDIT_LEVELS.length;
        return {
          ...state,
          settingsPicker: { ...sp, auditLevel: expectDefined(AUDIT_LEVELS[next]), hint: undefined },
        };
      }
      // ── Debug ──────────────────────────────────────────────────────────────
      // Field 33: debug stream (boolean toggle)
      if (f === 33)
        return {
          ...state,
          settingsPicker: { ...sp, debugStream: !sp.debugStream, hint: undefined },
        };
      // Field 34: statusline mode (cycle minimum/detailed)
      if (f === 34) {
        const i = STATUSLINE_MODES.indexOf(sp.statuslineMode);
        const base = i < 0 ? STATUSLINE_MODES.indexOf('detailed') : i;
        const next = (base + action.delta + STATUSLINE_MODES.length) % STATUSLINE_MODES.length;
        return {
          ...state,
          settingsPicker: {
            ...sp,
            statuslineMode: expectDefined(STATUSLINE_MODES[next]),
            hint: undefined,
          },
        };
      }
      // Field 35: config scope (cycle global/project)
      if (f === 35) {
        const i = CONFIG_SCOPES.indexOf(sp.configScope);
        const base = i < 0 ? 0 : i;
        const next = (base + action.delta + CONFIG_SCOPES.length) % CONFIG_SCOPES.length;
        return {
          ...state,
          settingsPicker: {
            ...sp,
            configScope: expectDefined(CONFIG_SCOPES[next]),
            hint: undefined,
          },
        };
      }
      // Field 36: animation style (cycle ANIMATION_STYLE_CHOICES)
      if (f === 36) {
        const i = ANIMATION_STYLE_CHOICES.indexOf(sp.animationStyle as AnimationStyleChoice);
        const base = i < 0 ? 0 : i;
        const next =
          (base + action.delta + ANIMATION_STYLE_CHOICES.length) % ANIMATION_STYLE_CHOICES.length;
        return {
          ...state,
          settingsPicker: {
            ...sp,
            animationStyle: expectDefined(ANIMATION_STYLE_CHOICES[next]),
            hint: undefined,
          },
        };
      }
      return state;
    }
    case 'settingsValueSet': {
      // Direct value-set from the `/settings <chord> <value>` slash
      // command. The patch is already validated by
      // `resolveSettingsFieldValue` before dispatch, so the reducer just
      // spreads it and clears any stale hint.
      return {
        ...state,
        settingsPicker: { ...state.settingsPicker, ...action.patch, hint: undefined },
      };
    }
    case 'settingsHint':
      return { ...state, settingsPicker: { ...state.settingsPicker, hint: action.text } };
    case 'settingsThinkingEditStart':
      return {
        ...state,
        settingsPicker: {
          ...state.settingsPicker,
          thinkingWordEditing: true,
          // Seed the draft with the current word so the user edits from it.
          thinkingWordDraft: state.settingsPicker.thinkingWord,
          hint: undefined,
        },
      };
    case 'settingsThinkingEditChange':
      return {
        ...state,
        settingsPicker: {
          ...state.settingsPicker,
          // Hard-cap the draft so it can't grow past the persisted limit.
          thinkingWordDraft: action.draft.slice(0, MAX_TUI_THINKING_WORD_LENGTH),
          hint: undefined,
        },
      };
    case 'settingsThinkingEditCommit': {
      const sp = state.settingsPicker;
      const raw = sp.thinkingWordDraft.trim();
      // Empty draft = cancel (keep the current word). Otherwise validate: an
      // invalid word keeps the current value and surfaces a hint rather than
      // silently snapping to the default.
      if (raw.length === 0) {
        return {
          ...state,
          settingsPicker: {
            ...sp,
            thinkingWordEditing: false,
            thinkingWordDraft: '',
            hint: undefined,
          },
        };
      }
      const normalized = normalizeTuiThinkingWord(raw);
      const valid = normalized === raw; // normalize falls back to default on invalid input
      return {
        ...state,
        settingsPicker: {
          ...sp,
          thinkingWord: valid ? normalized : sp.thinkingWord,
          thinkingWordEditing: false,
          thinkingWordDraft: '',
          hint: valid
            ? undefined
            : `Invalid word — keep it ≤${MAX_TUI_THINKING_WORD_LENGTH} chars (letters/digits/_/-)`,
        },
      };
    }
    case 'settingsThinkingEditCancel':
      return {
        ...state,
        settingsPicker: {
          ...state.settingsPicker,
          thinkingWordEditing: false,
          thinkingWordDraft: '',
          hint: undefined,
        },
      };
    // ── Statusline picker ───────────────────────────────────────────────
    case 'statuslineOpen':
      return {
        ...state,
        ...closePanels(state),
        statuslinePicker: {
          open: true,
          field: 0,
          hiddenItems: action.hiddenItems,
          visibleChips: state.statuslinePicker.visibleChips,
          hint: undefined,
        },
      };
    case 'statuslineClose':
      return {
        ...state,
        statuslinePicker: { ...state.statuslinePicker, open: false, hint: undefined },
      };
    case 'statuslineFieldMove': {
      const totalFields = STATUSLINE_FIELD_COUNT;
      const next = (state.statuslinePicker.field + action.delta + totalFields) % totalFields;
      return {
        ...state,
        statuslinePicker: { ...state.statuslinePicker, field: next, hint: undefined },
      };
    }
    case 'statuslineFieldSet': {
      const totalFields = STATUSLINE_FIELD_COUNT;
      const field = action.field >= 0 && action.field < totalFields ? action.field : 0;
      return { ...state, statuslinePicker: { ...state.statuslinePicker, field, hint: undefined } };
    }
    case 'statuslineToggle': {
      const cur = state.statuslinePicker;
      const hiddenSet = new Set(cur.hiddenItems);
      if (hiddenSet.has(action.item)) {
        hiddenSet.delete(action.item);
      } else {
        hiddenSet.add(action.item);
      }
      return {
        ...state,
        statuslinePicker: { ...cur, hiddenItems: [...hiddenSet] as typeof cur.hiddenItems },
      };
    }
    case 'statuslineHint':
      return { ...state, statuslinePicker: { ...state.statuslinePicker, hint: action.text } };
    case 'statuslineChipShow': {
      const cur = state.statuslinePicker;
      const existing = cur.visibleChips.findIndex((c) => c.key === action.key);
      // Only include expiresIn if it is explicitly set — with exactOptionalPropertyTypes,
      // assigning undefined to an optional property is a type error.
      const meta: ChipMeta =
        action.expiresIn != null
          ? { key: action.key, shownAt: Date.now(), expiresIn: action.expiresIn }
          : { key: action.key, shownAt: Date.now() };
      if (existing >= 0) {
        // Reset shownAt if already visible
        const updated = [...cur.visibleChips];
        updated[existing] = meta;
        return { ...state, statuslinePicker: { ...cur, visibleChips: updated } };
      }
      return { ...state, statuslinePicker: { ...cur, visibleChips: [...cur.visibleChips, meta] } };
    }
    case 'statuslineChipExpire': {
      const cur = state.statuslinePicker;
      return {
        ...state,
        statuslinePicker: {
          ...cur,
          visibleChips: cur.visibleChips.filter((c) => c.key !== action.key),
        },
      };
    }
    case 'statuslineVisibleChipsSync':
      return {
        ...state,
        statuslinePicker: { ...state.statuslinePicker, visibleChips: action.visibleChips },
      };
    case 'pluginPickerOpen': {
      const items = action.items ?? state.pluginPicker.items;
      return {
        ...state,
        ...closePanels(state),
        pluginPicker: {
          open: true,
          items,
          selected: Math.min(state.pluginPicker.selected, Math.max(0, items.length - 1)),
          busy: items.length === 0,
          hint: undefined,
        },
      };
    }
    case 'pluginPickerClose':
      return { ...state, pluginPicker: { ...state.pluginPicker, open: false, busy: false } };
    case 'pluginPickerMove': {
      const count = state.pluginPicker.items.length;
      if (count === 0) return state;
      return {
        ...state,
        pluginPicker: {
          ...state.pluginPicker,
          selected: (state.pluginPicker.selected + action.delta + count) % count,
          hint: undefined,
        },
      };
    }
    case 'pluginPickerSetItems':
      return {
        ...state,
        pluginPicker: {
          ...state.pluginPicker,
          items: action.items,
          selected: Math.min(state.pluginPicker.selected, Math.max(0, action.items.length - 1)),
          busy: false,
        },
      };
    case 'pluginPickerBusy':
      return { ...state, pluginPicker: { ...state.pluginPicker, busy: action.busy } };
    case 'pluginPickerHint':
      return { ...state, pluginPicker: { ...state.pluginPicker, hint: action.text } };
    case 'mcpPickerOpen': {
      const items = action.items ?? state.mcpPicker.items;
      return {
        ...state,
        ...closePanels(state),
        mcpPicker: {
          open: true,
          items,
          selected: Math.min(state.mcpPicker.selected, Math.max(0, items.length - 1)),
          busy: items.length === 0,
          hint: undefined,
        },
      };
    }
    case 'mcpPickerClose':
      return { ...state, mcpPicker: { ...state.mcpPicker, open: false, busy: false } };
    case 'mcpPickerMove': {
      const count = state.mcpPicker.items.length;
      if (count === 0) return state;
      return {
        ...state,
        mcpPicker: {
          ...state.mcpPicker,
          selected: (state.mcpPicker.selected + action.delta + count) % count,
          hint: undefined,
        },
      };
    }
    case 'mcpPickerSetItems':
      return {
        ...state,
        mcpPicker: {
          ...state.mcpPicker,
          items: action.items,
          selected: Math.min(state.mcpPicker.selected, Math.max(0, action.items.length - 1)),
          busy: false,
        },
      };
    case 'mcpPickerBusy':
      return { ...state, mcpPicker: { ...state.mcpPicker, busy: action.busy } };
    case 'mcpPickerHint':
      return { ...state, mcpPicker: { ...state.mcpPicker, hint: action.text } };
    case 'toolsPickerOpen': {
      const items = action.items ?? state.toolsPicker.items;
      return {
        ...state,
        ...closePanels(state),
        toolsPicker: {
          open: true,
          items,
          selected: Math.min(state.toolsPicker.selected, Math.max(0, items.length - 1)),
          busy: items.length === 0,
          hint: undefined,
          filter: undefined,
        },
      };
    }
    case 'toolsPickerClose':
      return { ...state, toolsPicker: { ...state.toolsPicker, open: false, busy: false, filter: undefined } };
    case 'toolsPickerMove': {
      const count = state.toolsPicker.items.length;
      if (count === 0) return state;
      return {
        ...state,
        toolsPicker: {
          ...state.toolsPicker,
          selected: (state.toolsPicker.selected + action.delta + count) % count,
          hint: undefined,
        },
      };
    }
    case 'toolsPickerSetItems':
      return {
        ...state,
        toolsPicker: {
          ...state.toolsPicker,
          items: action.items,
          selected: Math.min(state.toolsPicker.selected, Math.max(0, action.items.length - 1)),
          busy: false,
        },
      };
    case 'toolsPickerToggle':
      // The toggle is handled by the host callback; this case just
      // prevents the reducer from crashing on the action type.
      return state;
    case 'toolsPickerBusy':
      return { ...state, toolsPicker: { ...state.toolsPicker, busy: action.busy } };
    case 'toolsPickerHint':
      return { ...state, toolsPicker: { ...state.toolsPicker, hint: action.text } };
    case 'toolsPickerFilter':
      return { ...state, toolsPicker: { ...state.toolsPicker, filter: action.filter } };
    case 'brainOpen': {
      return {
        ...state,
        ...closePanels(state),
        brainPanel: {
          open: true,
          riskLevel: action.riskLevel,
          log: action.log,
          selected: 0,
          hint: undefined,
        },
      };
    }
    case 'brainClose':
      return { ...state, brainPanel: { ...state.brainPanel, open: false } };
    case 'brainMove': {
      const count = state.brainPanel.log.length;
      if (count === 0) return state;
      return {
        ...state,
        brainPanel: {
          ...state.brainPanel,
          selected: (state.brainPanel.selected + action.delta + count) % count,
          hint: undefined,
        },
      };
    }
    case 'brainRiskChange': {
      const levels = ['off', 'low', 'medium', 'high', 'all'] as const;
      const cur = levels.indexOf(state.brainPanel.riskLevel as typeof levels[number]);
      const next = (cur + action.delta + levels.length) % levels.length;
      return {
        ...state,
        brainPanel: {
          ...state.brainPanel,
          riskLevel: levels[next] as typeof state.brainPanel.riskLevel,
        },
      };
    }
    case 'brainSetLog':
      return {
        ...state,
        brainPanel: {
          ...state.brainPanel,
          log: action.log,
          selected: Math.min(state.brainPanel.selected, Math.max(0, action.log.length - 1)),
        },
      };
    case 'brainHint':
      return { ...state, brainPanel: { ...state.brainPanel, hint: action.text } };
    case 'shadowOpen':
      return {
        ...state,
        ...closePanels(state),
        shadowPanel: { open: true, shadow: action.shadow, hint: undefined },
      };
    case 'shadowClose':
      return { ...state, shadowPanel: { ...state.shadowPanel, open: false } };
    case 'shadowUpdate':
      return { ...state, shadowPanel: { ...state.shadowPanel, shadow: action.shadow } };
    case 'shadowHint':
      return { ...state, shadowPanel: { ...state.shadowPanel, hint: action.text } };
    case 'authOpen':
      return {
        ...state,
        ...closePanels(state),
        authPanel: {
          ...AUTH_PANEL_INITIAL,
          open: true,
          view: action.view ?? 'list',
          providers: action.providers ?? state.authPanel.providers,
          presets: action.presets ?? state.authPanel.presets,
          catalog: state.authPanel.catalog,
          busy: action.providers === undefined,
        },
      };
    case 'authClose':
      return { ...state, authPanel: { ...state.authPanel, open: false, busy: false } };
    case 'authProviders': {
      const next = { ...state.authPanel, providers: action.providers, busy: false };
      return { ...state, authPanel: { ...next, selected: clampAuthSelected(next) } };
    }
    case 'authCatalog': {
      const next = { ...state.authPanel, catalog: action.catalog, busy: false };
      return { ...state, authPanel: { ...next, selected: clampAuthSelected(next) } };
    }
    case 'authView':
      return {
        ...state,
        authPanel: {
          ...state.authPanel,
          view: action.view,
          providerId: action.providerId ?? state.authPanel.providerId,
          selected: 0,
          filter: '',
          hint: undefined,
        },
      };
    case 'authMove':
      return {
        ...state,
        authPanel: {
          ...state.authPanel,
          selected: authMoveSelected(state.authPanel, action.delta),
          hint: undefined,
        },
      };
    case 'authBusy':
      return { ...state, authPanel: { ...state.authPanel, busy: action.busy } };
    case 'authHint':
      return { ...state, authPanel: { ...state.authPanel, hint: action.text } };
    case 'authFilter': {
      const next = { ...state.authPanel, filter: action.filter, selected: 0 };
      return { ...state, authPanel: next };
    }
    case 'authFlowStart':
      return {
        ...state,
        authPanel: {
          ...state.authPanel,
          view: 'flow',
          flowTitle: action.title,
          log: [],
          flowDone: false,
          flowOk: undefined,
          busy: true,
          hint: undefined,
        },
      };
    case 'authFlowLog': {
      // Cap the retained log so a chatty flow can't grow state unboundedly.
      const log = [...state.authPanel.log, action.line].slice(-200);
      return { ...state, authPanel: { ...state.authPanel, log } };
    }
    case 'authFlowDone': {
      const log = action.message
        ? [...state.authPanel.log, action.message].slice(-200)
        : state.authPanel.log;
      return {
        ...state,
        authPanel: {
          ...state.authPanel,
          flowDone: true,
          flowOk: action.ok,
          busy: false,
          log,
          input: undefined,
        },
      };
    }
    case 'authPromptStart':
      return {
        ...state,
        authPanel: {
          ...state.authPanel,
          input: { label: action.label, masked: action.masked, draft: '' },
        },
      };
    case 'authPromptChange':
      return state.authPanel.input
        ? {
            ...state,
            authPanel: {
              ...state.authPanel,
              input: { ...state.authPanel.input, draft: action.draft },
            },
          }
        : state;
    case 'authPromptEnd':
      return { ...state, authPanel: { ...state.authPanel, input: undefined } };
    case 'authConfirmStart':
      return {
        ...state,
        authPanel: {
          ...state.authPanel,
          confirm: { question: action.question, action: action.action },
        },
      };
    case 'authConfirmEnd':
      return { ...state, authPanel: { ...state.authPanel, confirm: undefined } };
    case 'projectPickerOpen':
      return {
        ...state,
        ...closePanels(state),
        projectPicker: {
          open: true,
          allItems: action.items,
          items: action.items,
          selected: firstSelectable(action.items),
          filter: '',
          hint: undefined,
        },
      };
    case 'projectPickerClose':
      return {
        ...state,
        projectPicker: {
          open: false,
          allItems: [],
          items: [],
          selected: 0,
          filter: '',
          hint: undefined,
        },
      };
    case 'projectPickerMove': {
      const cur = state.projectPicker;
      const list = cur.items;
      if (list.length === 0) return state;
      const nextRaw = (cur.selected + action.delta + list.length) % list.length;
      const next = skipDivider(list, nextRaw, action.delta > 0 ? 1 : (-1 as 1 | -1));
      return { ...state, projectPicker: { ...cur, selected: next } };
    }
    case 'projectPickerFilter': {
      const cur = state.projectPicker;
      const filtered = action.filter
        ? cur.allItems.filter(
            (item) =>
              item.kind !== 'project' ||
              item.label.toLowerCase().includes(action.filter.toLowerCase()) ||
              (item.subtitle ?? '').toLowerCase().includes(action.filter.toLowerCase()),
          )
        : cur.allItems;
      return {
        ...state,
        projectPicker: {
          ...cur,
          filter: action.filter,
          items: filtered,
          selected: firstSelectable(filtered),
        },
      };
    }
    case 'projectPickerHint':
      return { ...state, projectPicker: { ...state.projectPicker, hint: action.text } };
    case 'fKeyPickerOpen':
      return { ...state, ...closePanels(state), fKeyPicker: { open: true, selected: 0 } };
    case 'fKeyPickerClose':
      return { ...state, fKeyPicker: { open: false, selected: 0 } };
    case 'fKeyPickerMove': {
      const count = 12; // F1–F12
      const next = (state.fKeyPicker.selected + action.delta + count) % count;
      return { ...state, fKeyPicker: { ...state.fKeyPicker, selected: next } };
    }
    case 'confirmOpen':
      return { ...state, confirmQueue: [...state.confirmQueue, action.info] };
    case 'confirmClose':
      return { ...state, confirmQueue: state.confirmQueue.slice(1) };
    case 'enhanceOpen':
      return { ...state, enhance: action.info };
    case 'enhanceClose':
      return { ...state, enhance: null };
    case 'enhanceSet':
      return { ...state, enhanceEnabled: action.enabled };
    case 'enhanceBusy':
      return { ...state, enhanceBusy: action.on };
    case 'escConfirmOpen':
      return { ...state, escConfirm: { snapshot: action.snapshot } };
    case 'escConfirmClose':
      return { ...state, escConfirm: null };
    case 'sendModePickerOpen':
      return { ...state, sendModePicker: action.info };
    case 'sendModePickerMove': {
      if (!state.sendModePicker) return state;
      const next = nextSendModeIndex(
        state.sendModePicker.selected,
        action.delta,
        SEND_MODE_OPTIONS.length,
      );
      return { ...state, sendModePicker: { ...state.sendModePicker, selected: next } };
    }
    case 'sendModePickerClose':
      return { ...state, sendModePicker: null };
    case 'resetContextChip':
      return { ...state, contextChipVersion: state.contextChipVersion + 1 };
    // fleetBatch runs below (cannot be extracted because it needs the reducer ref).
    // --- Fleet & leader (delegated to reducers/fleet.ts) ---
    case 'fleetSeed':
    case 'fleetSpawn':
    case 'fleetToolStart':
    case 'fleetToolEnd':
    case 'fleetStart':
    case 'fleetDelta':
    case 'fleetMessage':
    case 'fleetTool':
    case 'fleetUsage':
    case 'fleetDone':
    case 'fleetBudgetWarning':
    case 'fleetBudgetExtended':
    case 'fleetCtxPct':
    case 'fleetCost':
    case 'fleetConcurrency':
    case 'leaderIterStart':
    case 'leaderIterEnd':
    case 'leaderToolStart':
    case 'leaderToolEnd':
    case 'leaderCtxPct':
    case 'setStreamFleet': {
      const fleetResult = reduceFleetState(state, action);
      if (fleetResult) return fleetResult;
      return state;
    }
    case 'toggleMonitor': {
      const opening = !state.monitorOpen;
      return opening
        ? { ...state, ...closePanels(state), monitorOpen: true }
        : { ...state, monitorOpen: false };
    }
    case 'toggleAgentsMonitor': {
      const opening = !state.agentsMonitorOpen;
      return opening
        ? { ...state, ...closePanels(state), agentsMonitorOpen: true }
        : { ...state, agentsMonitorOpen: false };
    }
    case 'toggleHelp': {
      const opening = !state.helpOpen;
      return opening
        ? { ...state, ...closePanels(state), helpOpen: true }
        : { ...state, helpOpen: false };
    }
    case 'toggleTodosMonitor': {
      const opening = !state.todosMonitorOpen;
      return opening
        ? { ...state, ...closePanels(state), todosMonitorOpen: true }
        : { ...state, todosMonitorOpen: false };
    }
    case 'toggleQueuePanel': {
      const opening = !state.queuePanelOpen;
      return opening
        ? { ...state, ...closePanels(state), queuePanelOpen: true }
        : { ...state, queuePanelOpen: false };
    }
    case 'toggleProcessList': {
      const opening = !state.processListOpen;
      return opening
        ? { ...state, ...closePanels(state), processListOpen: true }
        : { ...state, processListOpen: false };
    }
    case 'togglePlanPanel': {
      const opening = !state.planPanelOpen;
      return opening
        ? { ...state, ...closePanels(state), planPanelOpen: true }
        : { ...state, planPanelOpen: false };
    }
    case 'toggleKanbanPanel': {
      const opening = !state.kanbanPanelOpen;
      return opening
        ? { ...state, ...closePanels(state), kanbanPanelOpen: true }
        : { ...state, kanbanPanelOpen: false };
    }
    case 'toggleGoalPanel': {
      const opening = !state.goalPanelOpen;
      return opening
        ? { ...state, ...closePanels(state), goalPanelOpen: true }
        : { ...state, goalPanelOpen: false };
    }
    case 'checkpointReceived': {
      const existing = state.checkpoints.find((c) => c.promptIndex === action.cp.promptIndex);
      if (existing) return state;
      return { ...state, checkpoints: [...state.checkpoints, action.cp] };
    }
    case 'rewindOverlayOpen': {
      return {
        ...state,
        rewindOverlay: { checkpoints: state.checkpoints, selected: state.checkpoints.length - 1 },
      };
    }
    case 'rewindOverlayClose': {
      return { ...state, rewindOverlay: null };
    }
    case 'rewindOverlayMove': {
      if (!state.rewindOverlay) return state;
      const len = state.rewindOverlay.checkpoints.length;
      if (len === 0) return { ...state, rewindOverlay: null };
      const selected = Math.max(0, Math.min(len - 1, state.rewindOverlay.selected + action.delta));
      return { ...state, rewindOverlay: { ...state.rewindOverlay, selected } };
    }
    case 'sessionRewound': {
      return {
        ...state,
        checkpoints: state.checkpoints.filter((c) => c.promptIndex <= action.toPromptIndex),
        rewindOverlay: null,
      };
    }
    case 'eternalStage': {
      return { ...state, eternalStage: action.stage };
    }
    case 'goalSummary': {
      return { ...state, goalSummary: action.summary };
    }
    case 'autoPhaseInit': {
      return {
        ...state,
        autoPhase: {
          title: action.title,
          phases: {},
          runningPhaseIds: [],
          elapsedMs: 0,
          monitorOpen: false,
        },
      };
    }
    case 'autoPhasePhaseUpdate': {
      // Lazily initialize autoPhase state on first phase event — the title
      // is not shown in the PhaseMonitor so a placeholder is fine here.
      const existing = state.autoPhase ?? {
        title: 'AutoPhase',
        phases: {},
        runningPhaseIds: [],
        elapsedMs: 0,
        monitorOpen: false,
      };
      return {
        ...state,
        autoPhase: {
          ...existing,
          phases: {
            ...existing.phases,
            [action.phaseId]: {
              name: action.name,
              status: action.status,
              completedTasks: action.completedTasks,
              totalTasks: action.totalTasks,
              startedAt: action.startedAt,
              // Preserve the live worker list across status/count updates.
              activeTasks: existing.phases[action.phaseId]?.activeTasks,
            },
          },
        },
      };
    }
    case 'autoPhaseTaskActive': {
      if (!state.autoPhase) return state;
      const phase = state.autoPhase.phases[action.phaseId];
      if (!phase) return state;
      const without = (phase.activeTasks ?? []).filter((t) => t.taskId !== action.taskId);
      const activeTasks = action.active
        ? [...without, { taskId: action.taskId, title: action.title, agent: action.agent }]
        : without;
      return {
        ...state,
        autoPhase: {
          ...state.autoPhase,
          phases: {
            ...state.autoPhase.phases,
            [action.phaseId]: { ...phase, activeTasks },
          },
        },
      };
    }
    case 'autoPhaseRunningPhases': {
      if (!state.autoPhase) return state;
      return {
        ...state,
        autoPhase: { ...state.autoPhase, runningPhaseIds: action.phaseIds },
      };
    }
    case 'autoPhaseElapsed': {
      if (!state.autoPhase) return state;
      return { ...state, autoPhase: { ...state.autoPhase, elapsedMs: action.ms } };
    }
    case 'autoPhaseMonitorToggle': {
      if (!state.autoPhase) return state;
      const opening = !state.autoPhase.monitorOpen;
      return opening
        ? {
            ...state,
            ...closePanels(state),
            autoPhase: { ...state.autoPhase, monitorOpen: true },
          }
        : {
            ...state,
            autoPhase: { ...state.autoPhase, monitorOpen: false },
          };
    }
    case 'autoPhaseReset': {
      return { ...state, autoPhase: null };
    }
    case 'sddBoardSnapshot': {
      // Preserve the overlay's open state across snapshots; default closed on
      // the very first snapshot of a run.
      const monitorOpen = state.sddBoard?.monitorOpen ?? false;
      const prevFocus = state.sddBoard?.focusColumn;
      const focusColumn =
        typeof prevFocus === 'number' &&
        prevFocus >= 0 &&
        prevFocus < action.snapshot.columns.length
          ? prevFocus
          : undefined;
      return { ...state, sddBoard: { snapshot: action.snapshot, monitorOpen, focusColumn } };
    }
    case 'toggleSddBoardMonitor': {
      // Nothing to show until the first snapshot arrives.
      if (!state.sddBoard) return state;
      const opening = !state.sddBoard.monitorOpen;
      return opening
        ? {
            ...state,
            ...closePanels(state),
            sddBoard: { ...state.sddBoard, monitorOpen: true },
          }
        : {
            ...state,
            sddBoard: { ...state.sddBoard, monitorOpen: false, focusColumn: undefined },
          };
    }
    case 'sddBoardFocusNext': {
      if (!state.sddBoard) return state;
      if (!state.sddBoard.monitorOpen) return state;
      const max = state.sddBoard.snapshot.columns.length - 1;
      if (max < 0) return state;
      const current = state.sddBoard.focusColumn;
      const next = typeof current === 'number' ? Math.min(max, current + 1) : 0;
      return { ...state, sddBoard: { ...state.sddBoard, focusColumn: next } };
    }
    case 'sddBoardFocusPrev': {
      if (!state.sddBoard) return state;
      if (!state.sddBoard.monitorOpen) return state;
      const current = state.sddBoard.focusColumn;
      if (typeof current !== 'number') return state;
      const next = current <= 0 ? undefined : current - 1;
      return { ...state, sddBoard: { ...state.sddBoard, focusColumn: next } };
    }
    case 'worktreeUpsert': {
      const prev = state.worktrees[action.handleId];
      const merged: WorktreeRow & { baseBranch?: string | undefined } = {
        branch: '',
        ownerLabel: '',
        status: 'active',
        insertions: 0,
        deletions: 0,
        files: 0,
        allocatedAt: Date.now(),
        ...prev,
        ...action.row,
      };
      return {
        ...state,
        worktrees: { ...state.worktrees, [action.handleId]: merged },
        worktreeBase: action.baseBranch ?? state.worktreeBase,
      };
    }
    case 'worktreeRemove': {
      if (!state.worktrees[action.handleId]) return state;
      const next = { ...state.worktrees };
      delete next[action.handleId];
      return { ...state, worktrees: next };
    }
    case 'worktreeMonitorToggle': {
      const opening = !state.worktreeMonitorOpen;
      return opening
        ? { ...state, ...closePanels(state), worktreeMonitorOpen: true }
        : { ...state, worktreeMonitorOpen: false };
    }
    // --- In-app chat scroll ---
    case 'scrollBy': {
      const maxOffset = Math.max(0, state.totalLines - state.viewportRows);
      const next = Math.max(0, Math.min(maxOffset, state.scrollOffset + action.delta));
      return {
        ...state,
        scrollOffset: next,
        pendingNewLines: next === 0 ? 0 : state.pendingNewLines,
      };
    }
    case 'scrollPage': {
      const page = Math.max(1, state.viewportRows - 1);
      const delta = action.dir === 'up' ? page : -page;
      const maxOffset = Math.max(0, state.totalLines - state.viewportRows);
      const next = Math.max(0, Math.min(maxOffset, state.scrollOffset + delta));
      return {
        ...state,
        scrollOffset: next,
        pendingNewLines: next === 0 ? 0 : state.pendingNewLines,
      };
    }
    case 'scrollTo': {
      const maxOffset = Math.max(0, state.totalLines - state.viewportRows);
      const next = Math.max(0, Math.min(maxOffset, action.offset));
      return {
        ...state,
        scrollOffset: next,
        pendingNewLines: next === 0 ? 0 : state.pendingNewLines,
      };
    }
    case 'scrollToBottom':
      return { ...state, scrollOffset: 0, pendingNewLines: 0 };
    case 'scrollToTop': {
      const maxOffset = Math.max(0, state.totalLines - state.viewportRows);
      return { ...state, scrollOffset: maxOffset };
    }
    case 'setMeasuredLines': {
      const newTotal = action.totalLines;
      const oldTotal = state.totalLines;
      const maxOffset = Math.max(0, newTotal - state.viewportRows);
      // Content grew while the user is scrolled up → keep the visible window
      // anchored on the same older rows by pushing the offset along with the
      // growth, and surface the new-line count for the "jump to bottom" hint.
      if (state.scrollOffset > 0 && newTotal > oldTotal) {
        const grew = newTotal - oldTotal;
        return {
          ...state,
          totalLines: newTotal,
          scrollOffset: Math.min(maxOffset, state.scrollOffset + grew),
          pendingNewLines: state.pendingNewLines + grew,
        };
      }
      // Pinned, or content shrank (e.g. /clear): re-clamp and keep following.
      return {
        ...state,
        totalLines: newTotal,
        scrollOffset: Math.min(state.scrollOffset, maxOffset),
      };
    }
    case 'setViewportRows': {
      const maxOffset = Math.max(0, state.totalLines - action.rows);
      return {
        ...state,
        viewportRows: action.rows,
        scrollOffset: Math.min(state.scrollOffset, maxOffset),
      };
    }
    case 'fleetBatch':
      // Fold each batched action through the reducer; one new state, one render.
      return action.actions.reduce((s, a) => reducer(s, a), state);
    // --- Collab session ---
    case 'collabSubagentSpawned': {
      // Lazily initialize collab state on the first subagent spawn.
      if (state.collabSession) return state;
      return {
        ...state,
        collabSession: {
          sessionId: null,
          bugCount: 0,
          planCount: 0,
          evalCount: 0,
          overallVerdict: null,
          timeline: [{ at: Date.now(), icon: '⚡', color: 'cyan', text: `${action.role} spawned` }],
          startedAt: Date.now(),
        },
      };
    }
    case 'collabBugFound': {
      const cs = state.collabSession;
      if (!cs) {
        // Lazily bootstrap collab state on first event.
        return {
          ...state,
          collabSession: {
            sessionId: action.sessionId,
            bugCount: 1,
            planCount: 0,
            evalCount: 0,
            overallVerdict: null,
            timeline: [
              {
                at: Date.now(),
                icon: '🐛',
                color: 'red',
                text: `bug: ${action.description.slice(0, 60)}…`,
              },
            ],
            startedAt: Date.now(),
          },
        };
      }
      const entry = {
        at: Date.now(),
        icon: '🐛',
        color: 'red',
        text: `bug [${action.severity}]: ${action.description.slice(0, 55)}…`,
      };
      return {
        ...state,
        collabSession: {
          ...cs,
          sessionId: action.sessionId,
          bugCount: cs.bugCount + 1,
          timeline: [entry, ...cs.timeline].slice(0, 30),
        },
      };
    }
    case 'collabPlanEmitted': {
      const cs = state.collabSession;
      if (!cs) return state;
      const entry = {
        at: Date.now(),
        icon: '📐',
        color: 'yellow',
        text: `plan [${action.riskScore}]: ${action.phaseCount} phases`,
      };
      return {
        ...state,
        collabSession: {
          ...cs,
          sessionId: action.sessionId,
          planCount: cs.planCount + 1,
          timeline: [entry, ...cs.timeline].slice(0, 30),
        },
      };
    }
    case 'collabEvalComplete': {
      const cs = state.collabSession;
      if (!cs) return state;
      const entry = {
        at: Date.now(),
        icon: '⚖️',
        color:
          action.verdict === 'approve' ? 'green' : action.verdict === 'reject' ? 'red' : 'yellow',
        text: `eval ${action.score}/10 → ${action.verdict}`,
      };
      return {
        ...state,
        collabSession: {
          ...cs,
          sessionId: action.sessionId,
          evalCount: cs.evalCount + 1,
          timeline: [entry, ...cs.timeline].slice(0, 30),
        },
      };
    }
    case 'collabSessionDone': {
      const cs = state.collabSession;
      if (!cs) return state;
      const entry = {
        at: Date.now(),
        icon: '🏁',
        color: 'green',
        text: `session done — ${action.verdict}`,
      };
      return {
        ...state,
        collabSession: {
          ...cs,
          overallVerdict: action.verdict,
          timeline: [entry, ...cs.timeline].slice(0, 30),
        },
      };
    }
    case 'debugStreamStats': {
      return {
        ...state,
        debugStreamStats: {
          chunkCount: action.chunkCount,
          lastChunkSize: action.lastChunkSize,
          lastDeltaMs: action.lastDeltaMs,
          totalBytes: action.totalBytes,
          lastChunkAt: action.lastChunkAt,
        },
      };
    }
    case 'debugStreamStatsClear': {
      if (state.debugStreamStats === null) return state;
      return { ...state, debugStreamStats: null };
    }
    case 'toggleSessionsPanel': {
      const opening = !state.sessionsPanelOpen;
      return opening
        ? { ...state, ...closePanels(state), sessionsPanelOpen: true, sessionResumeConfirm: null }
        : { ...state, sessionsPanelOpen: false, sessionResumeConfirm: null };
    }
    case 'sessionsPanelSet': {
      const sessions = Array.isArray(action.sessions) ? action.sessions : [];
      return {
        ...state,
        sessionsPanel: { sessions, busy: false, selected: sessions.length > 0 ? 0 : -1 },
      };
    }
    case 'sessionsPanelMove': {
      const cur = state.sessionsPanel;
      if (cur.sessions.length === 0) return state;
      const next = (cur.selected + action.delta + cur.sessions.length) % cur.sessions.length;
      return { ...state, sessionsPanel: { ...cur, selected: next } };
    }
    case 'sessionsPanelBusy': {
      return {
        ...state,
        sessionsPanel: { ...state.sessionsPanel, busy: action.on },
      };
    }
    case 'sessionResumeConfirmSet': {
      return {
        ...state,
        sessionResumeConfirm: { sessionId: action.sessionId, sessionName: action.sessionName },
      };
    }
    case 'sessionResumeConfirmClear': {
      return { ...state, sessionResumeConfirm: null };
    }
    // --- Auto-proceed countdown ---
    case 'countdownTick': {
      // Upsert: the first tick creates the countdown (there is no separate
      // "started" event from the host), and a 0-tick clears it so the chip
      // never freezes at the last value.
      if (action.remainingSeconds <= 0) {
        return state.countdown ? { ...state, countdown: null } : state;
      }
      return { ...state, countdown: { remainingSeconds: action.remainingSeconds } };
    }
    case 'countdownEnded': {
      if (state.countdown === null) return state;
      return { ...state, countdown: null };
    }
    // --- AutonomousCoordinator ---
    case 'coordinatorEvent': {
      const { event } = action;
      const now = Date.now();
      // Build timeline entry from raw event
      let kind: State['coordinator']['timeline'][0]['kind'];
      let icon: string;
      switch (event.type) {
        case 'goal:added':
          kind = 'goal';
          icon = '🎯';
          break;
        case 'goal:completed':
          kind = 'goal';
          icon = '✅';
          break;
        case 'goal:failed':
          kind = 'goal';
          icon = '❌';
          break;
        case 'task:ready':
          kind = 'task';
          icon = '⚡';
          break;
        case 'task:completed':
          kind = 'task';
          icon = '✓';
          break;
        case 'knowledge:added':
          kind = 'knowledge';
          icon = '💡';
          break;
        case 'consensus:reached':
          kind = 'consensus';
          icon = '🤝';
          break;
        case 'deadlock:detected':
          kind = 'deadlock';
          icon = '⚠️';
          break;
        default:
          kind = 'goal';
          icon = '•';
          break;
      }
      const timelineEntry = {
        at: now,
        kind,
        icon,
        text: event.text ?? event.type,
      };
      return {
        ...state,
        coordinator: {
          ...state.coordinator,
          healthy: true,
          knowledgeCount:
            event.type === 'knowledge:added'
              ? state.coordinator.knowledgeCount + 1
              : state.coordinator.knowledgeCount,
          timeline: [timelineEntry, ...state.coordinator.timeline].slice(0, 50),
        },
      };
    }
    case 'toggleAuditPanel': {
      const opening = !state.auditPanelOpen;
      return opening
        ? { ...state, ...closePanels(state), auditPanelOpen: true }
        : { ...state, auditPanelOpen: false };
    }
    case 'toggleCoordinatorMonitor': {
      const opening = !state.coordinator.monitorOpen;
      return opening
        ? {
            ...state,
            ...closePanels(state),
            coordinator: { ...state.coordinator, monitorOpen: true },
          }
        : { ...state, coordinator: { ...state.coordinator, monitorOpen: false } };
    }
  }
}
