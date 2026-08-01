import { type PersistedQueueItem, retainPersistedQueueItems } from '@wrongstack/core/storage';
import type { Action } from '../app-action-type.js';
import type { QueueItem, State } from '../app-state.js';
import { filterPromptPicker } from '../components/prompt-picker.js';
import { retainTuiHistory } from '../history-retention.js';
import {
  closePanels,
  MAX_TOOL_STREAM_RETAINED_CHARS,
  retainStreamTail,
} from './helpers.js';

const composerActionTypes = [
  'brainPromptSet',
  'brainPromptClear',
  'pickerOpen',
  'pickerClose',
  'pickerSetMatches',
  'pickerMove',
  'toolStarted',
  'toolEnded',
  'toolStreamAppend',
  'toolStreamClear',
  'enqueue',
  'dequeueFirst',
  'queueClear',
  'queueDelete',
  'queueToggleRefine',
  'slashPickerOpen',
  'slashPickerClose',
  'slashPickerMove',
  'historyPush',
  'historyUp',
  'historyDown',
  'setInputHistory',
  'clearInputHistory',
  'modelPickerOpen',
  'modelPickerClose',
  'modelPickerMove',
  'modelPickerPickProvider',
  'modelPickerBack',
  'modelPickerSearch',
  'modelPickerHint',
  'autonomyPickerOpen',
  'autonomyPickerClose',
  'autonomyPickerMove',
  'autonomyPickerHint',
  'modePickerOpen',
  'modePickerClose',
  'modePickerMove',
  'modePickerHint',
  'designPickerOpen',
  'designPickerClose',
  'designPickerMove',
  'designPickerStack',
  'promptPickerOpen',
  'promptPickerClose',
  'promptPickerMove',
  'promptPickerCategory',
  'resumePickerOpen',
  'resumePickerClose',
  'resumePickerMove',
  'resumePickerBusy',
  'resumePickerHint',
  'resumePickerError',
  'replaceHistory',
] as const satisfies readonly Action['type'][];

type ComposerAction = Extract<Action, { type: (typeof composerActionTypes)[number] }>;
const composerActionTypeSet = new Set<string>(composerActionTypes);

export function isComposerAction(action: Action): action is ComposerAction {
  return composerActionTypeSet.has(action.type);
}

/** Reduces composer tools, queues, history navigation, and session/model pickers. */
export function reduceComposer(state: State, action: ComposerAction): State {
  switch (action.type) {
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
        return {
          ...state,
          toolStream: {
            ...cur,
            text: retainStreamTail(cur.text, action.text, MAX_TOOL_STREAM_RETAINED_CHARS),
          },
        };
      }
      return {
        ...state,
        toolStream: {
          toolUseId: action.toolUseId,
          name: action.name,
          // The first partial-output event can itself be an oversized chunk,
          // so apply the same cap used for later appends at initialization.
          text: retainStreamTail('', action.text, MAX_TOOL_STREAM_RETAINED_CHARS),
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
      const candidate = [...state.queue, item];
      const persisted: PersistedQueueItem[] = candidate.map(
        ({ displayText, blocks, shouldRefine }) => ({
          displayText,
          blocks,
          ...(shouldRefine !== undefined ? { shouldRefine } : {}),
        }),
      );
      // Reject the newest item when the shared queue budget is exhausted.
      // Keeping the existing FIFO prefix avoids silently discarding work the
      // user already queued and keeps the persisted/in-memory contracts equal.
      if (retainPersistedQueueItems(persisted).length !== candidate.length) return state;
      return {
        ...state,
        queue: candidate,
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
    case 'queueToggleRefine': {
      const pos = action.position;
      if (pos < 0 || pos >= state.queue.length) return state;
      const updated = [...state.queue];
      const existing = updated[pos];
      if (!existing) return state;
      updated[pos] = { ...existing, shouldRefine: !existing.shouldRefine };
      return { ...state, queue: updated };
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
    case 'modelPickerOpen': {
      const purpose = action.purpose ?? 'switch';
      return {
        ...state,
        // Generic 'pick' invocations are transient overlays ON TOP of the
        // calling panel (e.g. the Brain panel) — leave other panels open so
        // the caller is still there when the promise resolves.
        ...(purpose === 'pick' ? {} : closePanels(state)),
        modelPicker: {
          open: true,
          step: 'provider',
          providerOptions: action.providers,
          modelOptions: [],
          filteredOptions: [],
          selected: 0,
          hint: undefined,
          searchQuery: '',
          purpose,
          title: action.title,
        },
      };
    }
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
          purpose: 'switch',
          title: undefined,
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
      // Apply the host's context-window snapshot (if any) so the statusline
      // chip and `/context` panel reflect the rebuilt context immediately,
      // instead of staying at zero until the next ctx.pct event lands.
      //
      // `replaceHistory` is only ever dispatched on a session resume (see
      // `hooks/use-app-picker-keys.ts`), so any pre-existing
      // `state.leader.ctxTokens` is the PREVIOUS session's value — stale the
      // moment the user resumes. The snapshot is computed from the resumed
      // session's tokenCounter after accounting its persisted usage, so it is
      // the authoritative number for the newly-active session and must
      // overwrite the stale value. Gating on `ctxTokens === undefined` here
      // would reject every snapshot after the first resume (or after any
      // ctx.pct event), leaving the chip showing the old session's tokens
      // until the next loop event. The loop's next ctx.pct for the resumed
      // session later overwrites this with a live measurement (authoritative
      // per `context-fill.ts:20-22`).
      const snap = action.contextSnapshot;
      const leaderWithSnap =
        snap && snap.tokens > 0
          ? {
              ...state.leader,
              ctxTokens: snap.tokens,
              ctxMaxTokens: snap.maxContext > 0 ? snap.maxContext : state.leader.ctxMaxTokens,
            }
          : state.leader;
      return {
        ...state,
        entries: retainTuiHistory([...banners, ...shifted]),
        nextId,
        historyGen: state.historyGen + 1,
        leader: leaderWithSnap,
        contextChipVersion: state.contextChipVersion + 1,
      };
    }
    default:
      void (action satisfies never);
      return state;
  }
}
