import type { Action } from '../app-action-type.js';
import type { State } from '../app-state.js';
import type { HistoryEntry } from '../history-entry.js';
import { retainTuiHistory } from '../history-retention.js';
import { closePanels, pruneToolInput } from './helpers.js';

const conversationActionTypes = [
  'addEntry',
  'archiveLoaded',
  'startArchiveLoad',
  'compactHistory',
  'autoProceedRelease',
  'setBuffer',
  'clearInput',
  'clearHistory',
  'status',
  'interrupt',
  'steerStart',
  'steerConsume',
  'resetInterrupts',
  'hint',
  'copiedNotice',
  'toolResultViewSet',
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
      // A page must never re-introduce an id already on screen: the scroll
      // cursor can legitimately reach line 0 (the banner is archived too),
      // and ids collide as duplicate React keys / ambiguous lookups.
      const seen = new Set(state.entries.map((entry) => entry.id));
      const fresh: HistoryEntry[] = [];
      for (const entry of action.entries) {
        if (seen.has(entry.id)) continue;
        seen.add(entry.id);
        fresh.push(entry);
      }
      if (fresh.length === 0) {
        return { ...state, archiveLoading: false };
      }
      const loadedMaxId = fresh.reduce((max, e) => Math.max(max, e.id), 0);
      const merged = [...fresh, ...state.entries];
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
        banner &&
        (action.model !== undefined ||
          action.provider !== undefined ||
          action.cwd !== undefined ||
          action.sessionId !== undefined)
          ? {
              ...banner,
              ...(action.model !== undefined ? { model: action.model } : {}),
              ...(action.provider !== undefined ? { provider: action.provider } : {}),
              ...(action.cwd !== undefined ? { cwd: action.cwd } : {}),
              ...(action.sessionId !== undefined ? { sessionId: action.sessionId } : {}),
            }
          : banner;
      // `/clear` (vs. `session.rewound` / `project.switched`) supplies all
      // three boot-resume sources as explicit `null` to signal "the boot-time
      // restored transcript is gone, treat this as a fresh launch." In that
      // case the reducer must also reset the slice of state that
      // `createInitialState` derives from those props:
      //   - historyBudget: a resume widens it; the widened budget would
      //     otherwise persist into the cleared session and let a stale tail
      //     of restored entries slip back through `retainTuiHistory`.
      //   - autoProceedHold: a resumed todo board sets the hold so the user
      //     sees the transcript before auto-proceed kicks in; clearing must
      //     release it (the cleared session has no resumed board to honour).
      //   - nextId: seeded from the highest restored id + 1; the surviving
      //     banner is id 0, so re-seeding from the post-wipe entries
      //     prevents id collisions on the first post-clear `addEntry`.
      // `undefined` (omitted) preserves the existing behavior used by
      // rewound/switched, where the resume slice is intentionally kept.
      const resumeDiscarded =
        action.restoredMessages === null &&
        action.restoredToolCalls === null &&
        action.restoredEvents === null;
      const survivingEntries = refreshedBanner ? [refreshedBanner] : [];
      // Default values match the `restoredEntries.length === 0` branch in
      // `createInitialState` (app-initial-state.ts:202–203, 169): a fresh
      // session gets the live default budget (undefined), no auto-proceed
      // hold, and `nextId` of 1 (the banner sits at id 0). Re-seeding
      // `nextId` from `survivingEntries` covers the edge case where the
      // banner was already missing — it matches the same arithmetic
      // `createInitialState` runs.
      const initialNextId = resumeDiscarded
        ? survivingEntries.reduce((next, entry) => Math.max(next, entry.id + 1), 1)
        : state.nextId;
      return {
        ...state,
        ...closePanels(state),
        entries: refreshedBanner ? [refreshedBanner] : [],
        // Invalidate stamped replay chunks still arriving from an old resume.
        resumeLoad: null,
        buffer: '',
        cursor: 0,
        hint: '',
        picker: { open: false, query: '', matches: [], selected: 0 },
        slashPicker: { open: false, query: '', matches: [], selected: 0 },
        sidebarScrollOffset: 0,
        goalRun: null,
        sddBoard: null,
        eternalStage: null,
        fallbackOverlay: null,
        archiveLoading: false,
        queue: [],
        nextQueueId: 1,
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
        // Resume-derived slice — only reset when `/clear` explicitly signals
        // the boot-time restored transcript is gone (all three props === null).
        // `session.rewound` / `project.switched` omit them, preserving the
        // existing resume-budget behavior.
        ...(resumeDiscarded
          ? {
              historyBudget: undefined,
              autoProceedHold: false,
              nextId: initialNextId,
            }
          : {}),
        // Drop any transient copy highlight: its target entry is being
        // discarded, so a stale copiedEntryId could otherwise flash a
        // surviving card (the banner) or dangle until the 2s host timer fires.
        copiedNotice: '',
        copiedEntryId: null,
        inspectOverlay: null,
        chatSearch: null,
        messageJump: { entryId: null, seq: 0 },
        toolResultViewOverrides: new Map(),
        // Bump the generation so <Static> remounts — without this, Ink's
        // already-written index exceeds the new (shorter) array and the
        // committed entries stay on screen even though `state.entries` no
        // longer references them. /clear would otherwise appear to do
        // nothing to the visible chat history.
        historyGen: state.historyGen + 1,
        // Reset fleet state on /clear so old subagent entries don't leave
        // stale per-agent chips on the async rail, and the fleet
        // cost/tokens chips show zero.
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
        bugHuntContinue: null,
        bugHuntRunning: null,
        sendModePicker: null,
        shellCommandWarning: null,
        bashMode: false,
        escConfirm: null,
        exitConfirm: null,
        // Auto-proceed countdown from the old conversation.
        countdown: null,
        // Session checkpoints and the rewind overlay reference the old
        // conversation's prompt indices. A rewind keeps the ones it did not
        // take back.
        checkpoints: action.keepCheckpoints ? state.checkpoints : [],
        rewindOverlay: null,
        // Collaborative debugging session timeline.
        collabSession: null,
      };
    }
    case 'status':
      // Going idle means the stream has finished — clear any lingering
      // debug-stream stats so the statusline doesn't show stale "🐛 stream".
      // The live tails and the activity line end in live-stream-store.ts.
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
    case 'toolResultViewSet': {
      const overrides = new Map(state.toolResultViewOverrides);
      for (const entryId of action.entryIds) overrides.set(entryId, action.mode);
      return { ...state, toolResultViewOverrides: overrides };
    }
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
