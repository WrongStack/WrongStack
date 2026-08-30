import type { Action } from '../app-action-type.js';
import type { State } from '../app-state.js';
import type { HistoryEntry } from '../history-entry.js';
import { retainTuiHistory } from '../history-retention.js';
import {
  MAX_ASSISTANT_STREAM_RETAINED_CHARS,
  pruneToolInput,
  retainStreamTail,
} from './helpers.js';

const conversationActionTypes = [
  'addEntry',
  'archiveLoaded',
  'startArchiveLoad',
  'compactHistory',
  'autoProceedRelease',
  'setBuffer',
  'clearInput',
  'clearHistory',
  'streamDelta',
  'streamReset',
  'status',
  'interrupt',
  'steerStart',
  'steerConsume',
  'resetInterrupts',
  'hint',
  'copiedNotice',
  'brainStatus',
] as const satisfies readonly Action['type'][];

type ConversationAction = Extract<Action, { type: (typeof conversationActionTypes)[number] }>;
const conversationActionTypeSet = new Set<string>(conversationActionTypes);

export function isConversationAction(action: Action): action is ConversationAction {
  return conversationActionTypeSet.has(action.type);
}

/** Reduces retained conversation history, input buffers, streams, and run status. */
export function reduceConversation(state: State, action: ConversationAction): State {
  switch (action.type) {
    case 'addEntry': {
      // Display history is a bounded cache. The canonical session remains on
      // disk, while the managed viewport keeps only a useful recent tail.
      // Large per-entry payloads (tool inputs) are pruned before retention.
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
      return {
        ...state,
        entries: retainTuiHistory(appended, state.historyBudget),
        nextId: state.nextId + 1,
      };
    }
    case 'archiveLoaded': {
      // Entries loaded from the history archive. Prepend them to the current
      // entries so the scroll window shifts to include archived content.
      // Use a simple slice cap instead of retainTuiHistory — that keeps the
      // newest entries and would drop the just-loaded archive entries first,
      // making scroll-back a no-op. The next addEntry dispatch will run
      // retainTuiHistory and trim from the front, naturally aging out the
      // oldest archive entries. This hard cap prevents unbounded growth from
      // repeated archive loads without the user submitting new entries.
      const loadedMaxId = action.entries.reduce((max, e) => Math.max(max, e.id), 0);
      const merged = [...action.entries, ...state.entries];
      const SOFT_MAX_ENTRIES = 800;
      return {
        ...state,
        archiveLoading: false,
        entries: merged.length > SOFT_MAX_ENTRIES ? merged.slice(-SOFT_MAX_ENTRIES) : merged,
        nextId: Math.max(state.nextId, loadedMaxId + 1),
      };
    }
    case 'startArchiveLoad':
      return { ...state, archiveLoading: true };
    case 'autoProceedRelease':
      // Idempotent: the manual submit path dispatches this on every message,
      // and returning the same object keeps that from scheduling a render.
      return state.autoProceedHold ? { ...state, autoProceedHold: false } : state;
    case 'compactHistory': {
      const entries = retainTuiHistory(state.entries, state.historyBudget);
      return entries === state.entries ? state : { ...state, entries };
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
      const refreshedBanner =
        banner && (action.model !== undefined || action.provider !== undefined)
          ? {
              ...banner,
              ...(action.model !== undefined ? { model: action.model } : {}),
              ...(action.provider !== undefined ? { provider: action.provider } : {}),
            }
          : banner;
      return {
        ...state,
        entries: refreshedBanner ? [refreshedBanner] : [],
        archiveLoading: false,
        queue: [],
        nextQueueId: 1,
        streamingText: '',
        toolStream: null,
        runningTools: new Map(),
        status: 'idle',
        interrupts: 0,
        steeringPending: false,
        steerSnapshot: null,
        confirmQueue: [],
        clearConfirm: null,
        slashConfirm: null,
        topicCheckBusy: false,
        brainPrompt: null,
        debugStreamStats: null,
        historyScrolled: false,
        // Drop any transient copy highlight: its target entry is being
        // discarded, so a stale copiedEntryId could otherwise flash a
        // surviving card (the banner) or dangle until the 2s host timer fires.
        copiedNotice: '',
        copiedEntryId: null,
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
        // ── Additional session-specific state that must not survive /clear ──
        // Input history (Up/Down navigation) from the old conversation.
        inputHistory: [],
        historyIndex: 0,
        historyDraft: '',
        // Brain analysis belongs to the old conversation.
        brain: { state: 'idle' },
        // Any pending interactive panel with a resolve callback must be
        // dismissed — the closures hold old-session state and the Promises
        // would never settle.
        enhance: null,
        enhanceBusy: false,
        refineCountdown: null,
        refineFailure: null,
        continueConfirm: null,
        sendModePicker: null,
        shellCommandWarning: null,
        escConfirm: null,
        exitConfirm: null,
        // Auto-proceed countdown from the old conversation.
        countdown: null,
        // Session checkpoints and the rewind overlay reference the old
        // conversation's prompt indices.
        checkpoints: [],
        rewindOverlay: null,
        // Collaborative debugging session timeline.
        collabSession: null,
      };
    }
    case 'streamDelta':
      return {
        ...state,
        streamingText: retainStreamTail(
          state.streamingText,
          action.delta,
          MAX_ASSISTANT_STREAM_RETAINED_CHARS,
        ),
      };
    case 'streamReset':
      return { ...state, streamingText: '' };
    case 'status':
      // Going idle means the stream has finished — clear any lingering
      // debug-stream stats so the statusline doesn't show stale "🐛 stream".
      // Also drop running-tool entries: tools cancelled mid-flight (steering,
      // Esc interrupt, provider errors) never emit `tool.executed`, and their
      // orphaned entries otherwise accumulate for the whole session.
      if (action.status === 'idle') {
        return {
          ...state,
          status: 'idle',
          debugStreamStats: null,
          ...(state.runningTools.size > 0 ? { runningTools: new Map() } : {}),
        };
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
    case 'copiedNotice':
      return { ...state, copiedNotice: action.text, copiedEntryId: action.entryId };
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
    default:
      void (action satisfies never);
      return state;
  }
}
