import { type PersistedQueueItem, retainPersistedQueueItems } from '@wrongstack/core/storage';
import type { Action } from '../app-action-type.js';
import type { QueueItem, State } from '../app-state.js';
import { retainTuiHistory, TUI_RESUME_HISTORY_BUDGET } from '../history-retention.js';
import { appendResumeLog, type ResumeLoadState, renderResumeLoadBlock } from '../resume-load.js';
import { orderResumeEntries } from '../resume-session-tree.js';
import { type ComposerAction, composerActionTypes } from './composer-action-types.js';
import { reduceComposerPickers } from './composer-pickers.js';
import * as h from './helpers.js';

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
    case 'bashModeEnter':
      // Reset history navigation so the Up/Down walk restarts cleanly —
      // bash mode filters the walk to past shell commands (see historyUp),
      // and a stale normal-mode index would land on an arbitrary entry.
      return state.bashMode
        ? state
        : { ...state, bashMode: true, historyIndex: 0, historyDraft: '' };
    case 'bashModeExit':
      return state.bashMode
        ? { ...state, bashMode: false, historyIndex: 0, historyDraft: '' }
        : state;
    case 'toolStarted':
      // The output-less live-tail placeholder for this call is started by
      // the same action in live-stream-store.ts.
      return h.trackRunningTool(state, action.id, action.name);
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
    case 'enqueue': {
      const item: QueueItem = { ...action.item, id: state.nextQueueId };
      const candidate = [...state.queue, item];
      const persisted: PersistedQueueItem[] = candidate.map(
        ({ displayText, blocks, shouldRefine, journalRaw }) => ({
          displayText,
          blocks,
          ...(shouldRefine !== undefined ? { shouldRefine } : {}),
          ...(journalRaw !== undefined ? { journalRaw } : {}),
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
      // Bash mode walks ONLY past shell commands (stored with their `!`
      // prefix) — loading an arbitrary chat prompt above a shell line would
      // be one Enter away from executing it as a command. The prefix is
      // stripped so the line shows exactly what would run.
      const entries = state.bashMode
        ? state.inputHistory.filter((entry) => entry.startsWith('!'))
        : state.inputHistory;
      if (entries.length === 0) return state;
      const next = Math.min(state.historyIndex + 1, entries.length);
      const raw = entries[next - 1] ?? '';
      const entry = state.bashMode ? raw.slice(1) : raw;
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
      const entries = state.bashMode
        ? state.inputHistory.filter((entry) => entry.startsWith('!'))
        : state.inputHistory;
      if (state.historyIndex === 0) return state;
      const next = state.historyIndex - 1;
      // Returning to index 0 restores the draft captured on the first Up,
      // so the user's in-progress prompt survives a history peek.
      const raw = next === 0 ? state.historyDraft : (entries[next - 1] ?? '');
      const entry = state.bashMode && next !== 0 ? raw.slice(1) : raw;
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
    case 'modelPickerClose':
    case 'modelPickerMove':
    case 'modelPickerPickProvider':
    case 'modelPickerBack':
    case 'modelPickerSearch':
    case 'modelPickerEffort':
    case 'modelPickerHint':
    case 'autonomyPickerOpen':
    case 'autonomyPickerClose':
    case 'autonomyPickerMove':
    case 'autonomyPickerHint':
    case 'themePickerOpen':
    case 'themePickerClose':
    case 'themePickerMove':
    case 'themePickerHint':
    case 'themePickerFilter':
    case 'themePickerFilterMode':
    case 'themePickerPreview':
    case 'themePickerUndo':
    case 'themePickerSwapPrevious':
    case 'modePickerOpen':
    case 'modePickerClose':
    case 'modePickerMove':
    case 'modePickerHint':
    case 'skillPickerOpen':
    case 'skillMentionResults':
    case 'skillPickerClose':
    case 'skillPickerMove':
    case 'skillPickerHint':
    case 'resourceMenuOpen':
    case 'resourceMenuClose':
    case 'resourceMenuMove':
    case 'resourceMenuHint':
    case 'resourceMenuFilter':
    case 'resourceMenuConfirm':
    case 'designPickerOpen':
    case 'designPickerClose':
    case 'designPickerMove':
    case 'designPickerStack':
    case 'promptPickerOpen':
    case 'promptPickerClose':
    case 'promptPickerMove':
    case 'promptPickerCategory':
    case 'promptPickerLevel':
      return reduceComposerPickers(state, action);

    case 'resumePickerOpen':
      return {
        ...state,
        ...h.closePanels(state),
        resumePicker: {
          open: true,
          sessions: orderResumeEntries(action.sessions),
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
      return {
        ...state,
        resumePicker: { ...state.resumePicker, error: action.text, busy: false, hint: undefined },
      };
    case 'resumeLoadStart': {
      // A load is already in flight: double-Enter on the picker, or a resume
      // started from the F10 panel / another path while one runs (the per-hook
      // refs serialize same-path double-fires but are independent of each
      // other). `resumeLoad` is the shared in-flight marker; it clears on
      // completion (resumeStreamChunk done) or abort (resumeLoadAbort), both
      // of which re-arm a subsequent start.
      if (state.resumeLoad) return state;
      // Wipe to the same clean slate `/clear` leaves: the banner and nothing
      // else. The previous conversation must not sit under a different
      // session's loading block — that is how the user loses track of which
      // transcript is on screen.
      const banner = state.entries.find((e) => e.kind === 'banner');
      const blockId = (banner?.id ?? 0) + 1;
      const load: ResumeLoadState = {
        sessionId: action.sessionId,
        label: action.label,
        blockEntryId: blockId,
        phase: 'reading',
        loadedBytes: 0,
        totalBytes: 0,
        log: [],
        replayed: 0,
        total: 0,
        frame: 0,
      };
      return {
        ...state,
        entries: [
          ...(banner ? [banner] : []),
          { id: blockId, kind: 'info' as const, text: renderResumeLoadBlock(load) },
        ],
        nextId: blockId + 1,
        historyGen: state.historyGen + 1,
        // Pin the view to the tail so the block, and then the streaming
        // transcript, stay in sight without the user scrolling.
        historyScrolled: false,
        // Resume posture, set at the START of the operation rather than at the
        // commit: an auto-proceed countdown must not arm during the seconds the
        // journal is being read either.
        historyBudget: TUI_RESUME_HISTORY_BUDGET,
        autoProceedHold: true,
        resumeLoad: load,
        // Drop the LEAVING session's context reading with its transcript.
        //
        // `state.leader.ctxTokens` is the statusline's and `/context`'s
        // first-choice source, and nothing else clears it on a resume (the
        // agent loop only rewrites it on the next request). Left in place it
        // outlives the conversation it measured: the chip kept reporting a
        // 400k session's fill after resuming a 5k one, and would go on doing so
        // for a resumed session that never reached the model at all. Cleared,
        // the fill ladder falls through to the local estimate over whatever
        // context is actually loaded — which stays correct for a read-only
        // resume too, where the agent never left the session it was in.
        leader: { ...state.leader, ctxTokens: undefined, ctxMaxTokens: undefined },
        contextChipVersion: state.contextChipVersion + 1,
      };
    }
    case 'resumeLoadTick': {
      const current = state.resumeLoad;
      // Late ticks after an abort/finish are expected: the loader is throttled
      // and the spinner interval can fire once more before it is cleared.
      if (!current) return state;
      // A tick stamped for a SUPERSEDED run must not mutate the winning load's
      // block: after a cross-path start is rejected, the losing runResume
      // chain keeps ticking with the other session's byte counts. Unstamped
      // ticks (legacy callers) keep applying to the in-flight load.
      if (action.sessionId !== undefined && action.sessionId !== current.sessionId) {
        return state;
      }
      const next: ResumeLoadState = {
        ...current,
        frame: current.frame + 1,
        ...(action.loadedBytes !== undefined ? { loadedBytes: action.loadedBytes } : {}),
        ...(action.totalBytes !== undefined ? { totalBytes: action.totalBytes } : {}),
        ...(action.note !== undefined ? { log: appendResumeLog(current.log, action.note) } : {}),
      };
      const text = renderResumeLoadBlock(next);
      const entries = state.entries.map((entry) =>
        entry.id === current.blockEntryId && entry.kind === 'info' ? { ...entry, text } : entry,
      );
      return { ...state, entries, resumeLoad: next };
    }
    case 'resumeStreamChunk': {
      // A chunk stamped for a SUPERSEDED run must neither splice its entries
      // into the transcript nor settle the winning load (a stale done:true
      // would clear it). Unstamped chunks keep legacy semantics.
      if (action.sessionId !== undefined && action.sessionId !== state.resumeLoad?.sessionId) {
        return state;
      }
      const first = state.resumeLoad?.phase === 'reading';
      // The first batch drops the progress block: from here the transcript
      // itself is the progress indicator, scrolling into place the way it did
      // when it was live.
      const base = (first ? state.entries.filter((e) => e.kind === 'banner') : state.entries).map(
        (entry) => {
          if (entry.kind !== 'banner' || !action.banner) return entry;
          const { sessionId, cwd, model, provider } = action.banner;
          return {
            ...entry,
            sessionId,
            ...(cwd !== undefined ? { cwd } : {}),
            ...(model !== undefined ? { model } : {}),
            ...(provider !== undefined ? { provider } : {}),
          };
        },
      );
      let nextId = first ? (base.at(-1)?.id ?? 0) + 1 : state.nextId;
      const appended = [...base];
      for (const entry of action.entries) appended.push({ ...entry, id: nextId++ });
      const replayed = (first ? 0 : (state.resumeLoad?.replayed ?? 0)) + action.entries.length;
      const snap = action.contextSnapshot;
      return {
        ...state,
        entries: retainTuiHistory(appended, TUI_RESUME_HISTORY_BUDGET),
        nextId,
        historyScrolled: false,
        historyGen: first ? state.historyGen + 1 : state.historyGen,
        resumeLoad:
          action.done && !action.holdUntilSettled
            ? null
            : state.resumeLoad
              ? { ...state.resumeLoad, phase: 'replaying', replayed, total: action.total }
              : null,
        ...(action.done && snap && snap.tokens > 0
          ? {
              leader: {
                ...state.leader,
                ctxTokens: snap.tokens,
                ctxMaxTokens: snap.maxContext > 0 ? snap.maxContext : state.leader.ctxMaxTokens,
              },
              contextChipVersion: state.contextChipVersion + 1,
            }
          : {}),
      };
    }
    case 'resumeLoadAbort':
      // Leaves the entries alone: the block stays as the last thing that
      // happened, and the caller writes the reason beneath it. Blanking the
      // screen here would erase the only record of what was attempted.
      // An abort stamped for a SUPERSEDED run must not cancel the winning
      // load; unstamped aborts keep legacy semantics.
      if (
        action.sessionId !== undefined &&
        state.resumeLoad !== null &&
        action.sessionId !== state.resumeLoad.sessionId
      ) {
        return state;
      }
      return state.resumeLoad ? { ...state, resumeLoad: null } : state;
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
        entries: retainTuiHistory([...banners, ...shifted], TUI_RESUME_HISTORY_BUDGET),
        nextId,
        historyGen: state.historyGen + 1,
        // Persist the widened budget: the "Resumed session …" line dispatched
        // immediately after this would otherwise re-trim the transcript to the
        // live 400/1 MB window one tick later.
        historyBudget: TUI_RESUME_HISTORY_BUDGET,
        // A resume lands WAITING. Restoring the session's todo board would
        // otherwise arm auto-proceed and start a turn on a countdown that the
        // user never asked for. Autonomy itself is untouched; the next manual
        // submit releases the hold.
        autoProceedHold: true,
        leader: leaderWithSnap,
        contextChipVersion: state.contextChipVersion + 1,
      };
    }
    default:
      void (action satisfies never);
      return state;
  }
}
