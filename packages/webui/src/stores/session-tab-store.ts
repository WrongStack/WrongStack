/**
 * session-tab-store.ts — The four slots, and the only place a tab is opened,
 * switched or closed.
 *
 * The model, stated plainly:
 *
 *   - There are exactly FOUR slots. Never more, never a fifth "just for now".
 *   - A slot holds AT MOST one session, and a session sits in AT MOST one slot.
 *     Both directions are enforced here; nothing else is allowed to bind them.
 *   - Switching slots moves a pointer. It does not park, copy, restore or clear
 *     anything, because every slot's state already lives in its own lane
 *     (`chat-lanes.ts`, `session-lanes.ts`) whether or not it is on screen.
 *   - Closing a slot disposes that lane. A closed tab keeps nothing alive.
 *
 * Think of the four slots as four layouts side by side. What makes them
 * side-by-side rather than one surface with four costumes is that no slot can
 * name another slot's state: the lane registries are keyed by session id and
 * every writer must name the session it is writing to.
 */

import { create } from 'zustand';
import { toast } from '@/components/Toaster';
import { i18n } from '@/i18n';
import { taskBriefPreview } from '@/lib/task-brief-preview';
import { getWSClient } from '@/lib/ws-client';
import { disposeStreakState } from './auto-submit-streak';
import {
  chatLane,
  disposeLane,
  ensureLane,
  hasLane,
  MAX_LANES,
  readLane,
  setActiveLane,
} from './chat-lanes';
import { useChimeraReportsStore } from './chimera-reports-store';
import { useFallbackStore } from './fallback-store';
import { useFileStore } from './file-store';
import { useFleetStore } from './fleet-store';
import { useGitChangesStore } from './git-changes-store';
import { useHistoryStore } from './history-store';
import { useLocalPrefs } from './local-prefs';
import { useToolStatsStore } from './tool-stats-store';
import {
  activeSessionLaneId,
  disposeSessionLane,
  ensureSessionLane,
  readSessionLane,
  SESSION_DEFAULT_LANE_ID,
  setActiveSessionLane,
  useSessionLanes,
} from './session-lanes';
import { useSessionStore } from './session-store';
import { useSystemPromptStore } from './system-prompt-store';
import { useUIStore } from './ui-store';

export const MAX_OPEN_TABS = MAX_LANES;
export const TAB_STORAGE_KEY = 'wrongstack.open_session_tabs';

export function readStoredTabs(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const saved = localStorage.getItem(TAB_STORAGE_KEY);
    if (!saved) return [];
    const parsed = JSON.parse(saved);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
      .slice(0, MAX_OPEN_TABS);
  } catch {
    return [];
  }
}

export function writeStoredTabs(tabs: string[]) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(TAB_STORAGE_KEY, JSON.stringify(tabs.slice(0, MAX_OPEN_TABS)));
  } catch {
    // ignore
  }
}

export interface OpenTabResult {
  success: boolean;
  reason: 'already_active' | 'switched' | 'opened_new_tab' | 'replaced_empty_tab' | 'tabs_full';
}

/** What the tab strip and the tab map render for one slot. */
export interface TabSummary {
  slot: number;
  sessionId: string;
  isActive: boolean;
  title: string;
  provider: string;
  model: string;
  mode: string;
  isRunning: boolean;
  messageCount: number;
  unread: number;
  queued: number;
  agentsRunning: number;
  agentsTotal: number;
  tokens: number;
  cost: number;
  contextPct: number;
  needsAttention: boolean;
}

interface SessionTabState {
  /** Slot order. Length is always <= MAX_OPEN_TABS. */
  openTabIds: string[];
  /** Transcript length each tab had when the user last looked at it. */
  lastSeenCounts: Record<string, number>;
  /** Tabs with a tool confirmation waiting. Set by the confirm handler. */
  attention: Record<string, boolean>;

  setOpenTabIds: (ids: string[]) => void;
  openTab: (
    sessionId: string,
    options?: { resumeSession?: (id: string) => void; recycleReentry?: boolean },
  ) => OpenTabResult;
  closeTab: (sessionId: string) => void;
  /**
   * Close every open tab bound to one of `sessionIds` so the caller can ask
   * the server to delete those records (a session a connection still
   * declares is refused). Returns the subset that is safe to delete:
   * sessions without a busy tab, minus the one tab kept so the strip never
   * drops to zero.
   */
  closeTabsForSessions: (sessionIds: string[]) => string[];
  markSeen: (sessionId: string) => void;
  setAttention: (sessionId: string, needsAttention: boolean) => void;
}

function syncUrl(sessionId: string) {
  if (typeof window === 'undefined') return;
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.get('session') === sessionId) return;
    url.searchParams.set('session', sessionId);
    window.history.replaceState({}, '', url.toString());
  } catch {
    // ignore
  }
}

/**
 * Which slot is in front, or `null` before any session is bound.
 *
 * The LANE POINTER, and only the lane pointer. `useSessionStore().session?.id`
 * reads the foreground lane's SessionInfo instead, and that record is null
 * from the moment a tab is opened until its `session.start` lands — during
 * which this store believed no tab was in front and happily opened a second
 * slot for the session already sitting in one.
 */
function foregroundTabId(): string | null {
  const pointer = activeSessionLaneId();
  return pointer && pointer !== SESSION_DEFAULT_LANE_ID ? pointer : null;
}

/**
 * Bind the foreground to one session. Both registries move together — a lane
 * pair that disagrees is how a transcript ended up next to another tab's token
 * counters.
 */
function activate(sessionId: string) {
  ensureSessionLane(sessionId);
  setActiveLane(sessionId);
  setActiveSessionLane(sessionId);
  useSessionStore.getState().switchSession(sessionId);
  // Restore what THIS tab was showing: its own subagent transcript, or the
  // leader. Leaving the previous tab's focus in place opened tab 2 on tab 1's
  // subagent.
  const ui = useUIStore.getState();
  ui.bindSessionChrome(sessionId);
  ui.setSubagentChatFocus(ui.subagentChatFocusBySession[sessionId] ?? null, sessionId);
  // Raise this tab's own unanswered approval prompt, and never another tab's:
  // the dialog is a single global surface, so switching away from a tab with a
  // live prompt must take it down with the tab.
  const lane = readLane(sessionId);
  const parked = lane.pendingConfirm;
  if (parked) ui.showConfirm(parked);
  else ui.hideConfirm();
  // Same rule for the provider-fallback dialog: one global surface, so it
  // shows this tab's unanswered prompt and comes down with the tab that
  // raised it.
  const parkedFallback = lane.pendingFallback;
  if (parkedFallback) useFallbackStore.getState().setPending(parkedFallback);
  else useFallbackStore.getState().clear();
  // The two diagnostic logs used to be wiped here: they were single global
  // objects that their handlers only ever filled for the tab in front, so on a
  // switch they held the PREVIOUS tab's memory injections and Brain panels and
  // nothing for this one — the chat header even counted them. They are now one
  // store instance per conversation (`createSessionScopedStore`), which is why
  // nothing is cleared: this tab's own records are already what shows, and the
  // tab we just left keeps its own instead of being emptied by a click.
  // The session catalogue is shared, but its "current" marker is not: it
  // disables resume on that row, drives the `active` filter, and spares the
  // row from the empty-session sweep. Re-point it at the tab now in front.
  useHistoryStore.getState().rebindCurrent(sessionId);
  // Slash-opened overlays (/queue, /kill, /cron) are one surface. Left open
  // they would operate on the tab we switched to — dequeueing, killing
  // processes — so they come down with the tab that opened them.
  ui.setQueuePanelOpen(false);
  ui.setProcessMonitorOpen(false);
  ui.setCronJobsOpen(false);
  syncUrl(sessionId);
}

/** A tab is "busy" when its own run is live or it owns a running subagent. */
export function isTabBusy(sessionId: string): boolean {
  if (readLane(sessionId).isLoading) return true;
  for (const agent of useFleetStore.getState().agents.values()) {
    if (agent.sessionId === sessionId && agent.status === 'running') return true;
  }
  return false;
}

/** Everything a busy-tab warning needs to say about one session, gathered in
 *  one place. The close dialog and the switch-away toast render the same
 *  `lines`, so the two warnings cannot drift apart or go vague. */
interface SessionActivityReport {
  sessionId: string;
  isBusy: boolean;
  /** True when the tab holds nothing at all — no chat history, no agents
   *  (running or finished), no queued messages, no live run. Such a tab has
   *  nothing to lose and may close without asking. */
  isEmpty: boolean;
  leaderRunning: boolean;
  runningAgents: Array<{ id: string; name: string; brief: string }>;
  finishedAgents: number;
  queuedMessages: number;
  /** Pre-localized, factual inventory lines (no framing). */
  lines: string[];
}

/** Complete inventory of what a session has in flight: its own run, every
 *  running subagent with a task preview, finished agents on record, queued
 *  messages. Reads the lane registries directly, like `isTabBusy`. */
export function describeSessionActivity(sessionId: string): SessionActivityReport {
  const lane = readLane(sessionId);
  const leaderRunning = lane.isLoading;
  const runningAgents: SessionActivityReport['runningAgents'] = [];
  let finishedAgents = 0;
  for (const agent of useFleetStore.getState().agents.values()) {
    if (agent.sessionId !== sessionId) continue;
    if (agent.status === 'running') {
      runningAgents.push({
        id: agent.id,
        name: agent.name ?? agent.id,
        brief: agent.description ? taskBriefPreview(agent.description, 120) : '',
      });
    } else {
      finishedAgents += 1;
    }
  }
  const queuedMessages = lane.queue.length;
  const lines: string[] = [];
  if (leaderRunning) {
    lines.push(
      i18n.t('activity:sessions.warnLeaderRunning', { defaultValue: 'Leader run in progress' }),
    );
  }
  for (const agent of runningAgents) {
    lines.push(
      i18n.t('activity:sessions.warnSubagentLine', {
        defaultValue: '{{name}} — running{{suffix}}',
        name: agent.name,
        suffix: agent.brief ? `: ${agent.brief}` : '',
      }),
    );
  }
  if (finishedAgents > 0) {
    lines.push(
      i18n.t('activity:sessions.warnFinishedAgents', {
        defaultValue: '{{count}} finished subagent(s) on record',
        count: finishedAgents,
      }),
    );
  }
  if (queuedMessages > 0) {
    lines.push(
      i18n.t('activity:sessions.warnQueuedMessages', {
        defaultValue: '{{count}} queued message(s)',
        count: queuedMessages,
      }),
    );
  }
  // "Completely empty" means nothing on record and nothing in flight: closing
  // such a tab cannot lose work, so it needs no warning.
  const isEmpty =
    !leaderRunning &&
    runningAgents.length === 0 &&
    finishedAgents === 0 &&
    queuedMessages === 0 &&
    lane.messages.length === 0;
  return {
    sessionId,
    isBusy: leaderRunning || runningAgents.length > 0,
    isEmpty,
    leaderRunning,
    runningAgents,
    finishedAgents,
    queuedMessages,
    lines,
  };
}

/** Thorough, non-blocking notice fired when the foreground moves OFF a busy
 *  tab: the tab keeps running in its slot, and the user sees exactly what
 *  stays behind. Switching back is always one click, so this must inform,
 *  not block. */
function notifyBusyTabLeftBehind(sessionId: string): void {
  if (!isTabBusy(sessionId)) return;
  const report = describeSessionActivity(sessionId);
  if (report.lines.length === 0) return;
  const title = readSessionLane(sessionId).session?.title ?? sessionId.slice(0, 8);
  toast.warn(
    i18n.t('activity:sessions.stillRunningToast', {
      defaultValue: '"{{title}}" keeps running in background:\n{{lines}}',
      title,
      lines: report.lines.join('\n'),
    }),
    7000,
  );
}

/**
 * Everything one slot owns, freed in one place.
 *
 * `closeTab` and `setOpenTabIds` both retire a tab, and they used to free
 * different things: the lanes always, the preference overrides and
 * auto-submit streak only on the explicit close. A tab dropped by the other
 * path left state that the NEXT session to be handed that id silently
 * inherited, which is the one thing the four-lane model exists to prevent.
 * The boot-time lane/slot reconciler in `useF5Resilience` retires through this
 * same path for the same reason. `restoreOpenTabsOnBoot` is the symmetric
 * opposite: it REBINDS every persisted slot so a browser refresh leaves the
 * user's tabs where they were, not as a half-empty welcome screen.
 */
export function releaseTab(sessionId: string): void {
  disposeLane(sessionId);
  disposeSessionLane(sessionId);
  useLocalPrefs.getState().forgetSession(sessionId);
  useSystemPromptStore.getState().dropSession(sessionId);
  useUIStore.getState().forgetSession(sessionId);
  useFileStore.getState().forgetSessionFiles(sessionId);
  useGitChangesStore.getState().forgetSessionGitChanges(sessionId);
  useFleetStore.getState().applyEvent({ kind: 'session_stopped', sessionId });
  useChimeraReportsStore.getState().forgetSession(sessionId);
  useToolStatsStore.getState().resetSession(sessionId);
  disposeStreakState(sessionId);
}

/**
 * Put the foreground back on a slot that still exists.
 *
 * Disposing the lane a pointer names does not move the pointer, and a pointer
 * aimed at a freed lane is worse than no pointer: the lane registries recreate
 * a lane on first write, so the next stray event for the closed session
 * resurrects it — invisible, unclosable, and counting against the four-lane
 * ceiling that a real new tab needs. With no slots left the pointer goes back
 * to "nothing in front", which is also what lets untagged events land again.
 */
function repointForegroundAfterRelease(remaining: string[]): void {
  const pointer = activeSessionLaneId();
  if (pointer !== SESSION_DEFAULT_LANE_ID && remaining.includes(pointer)) return;
  const fallback = remaining[remaining.length - 1];
  if (fallback !== undefined) {
    activate(fallback);
    useSessionTabStore.getState().markSeen(fallback);
    return;
  }
  setActiveLane(null);
  setActiveSessionLane(SESSION_DEFAULT_LANE_ID);
  // With no tab in front there is no `activate()` to take the modals down, and
  // both of them ask a question ON BEHALF of a session that no longer exists —
  // an approval or a model choice answered here would be sent for a closed
  // conversation.
  useUIStore.getState().hideConfirm();
  useFallbackStore.getState().clear();
}

/**
 * Declare the open set to the server NOW, not on the next React commit.
 *
 * A deletion sent right after a tab close must not overtake the subscription
 * update on the socket: the server refuses to delete a session a connection
 * still declares, and the effect in `useSessionSubscription` that re-declares
 * runs only after paint. `subscribeSessions` dedupes, so the later effect
 * call for the same set is a no-op.
 */
function declareOpenTabsNow(openTabIds: string[]): void {
  const active = foregroundTabId();
  const ids = active && !openTabIds.includes(active) ? [...openTabIds, active] : openTabIds;
  if (ids.length === 0) return;
  try {
    getWSClient().subscribeSessions(ids);
  } catch {
    // No socket yet — the reconnect path re-declares.
  }
}

/**
 * Foreground picker for `restoreOpenTabsOnBoot`. Deterministic for tests.
 *
 * The persisted `openTabIds` order reflects the user's last tab strip;
 * `lastVisitedAt` is per-tab and survives F5 inside `useSessionLanes`.
 * Picking the most-recently-visited tab and falling back to the persisted
 * order on a tie keeps the foreground where the user left it without
 * inventing a new ordering rule. The `now` parameter is injected so the
 * helper stays pure and testable.
 */
type RestorePickForeground = (candidates: string[], now: number) => string | null;

const defaultPickForeground: RestorePickForeground = (candidates, _now) => {
  // `_now` is the RestorePickForeground test seam (tests inject a frozen
  // clock); the default picker is clock-free — most-recently-visited wins.
  if (candidates.length === 0) return null;
  let best = candidates[0]!;
  let bestVisited = readSessionLane(best).lastVisitedAt || 0;
  for (let i = 1; i < candidates.length; i += 1) {
    const id = candidates[i]!;
    const visited = readSessionLane(id).lastVisitedAt || 0;
    if (visited > bestVisited) {
      best = id;
      bestVisited = visited;
    }
  }
  return best;
};

interface RestoreOpenTabsOptions {
  /** Injected clock for tests. Defaults to `Date.now()`. */
  now?: number;
  /** Injected picker for tests. Defaults to `defaultPickForeground`. */
  pickForeground?: RestorePickForeground;
}

/**
 * Promote the persisted slot list into active, foregrounded tabs at boot.
 *
 * The inverse of `releaseTab`: every id stored in
 * `wrongstack.open_session_tabs` has its chat lane and session lane
 * ensured, its per-session preferences bound, and its subagent focus and
 * history rebinds wired up. The most-recently-visited id (or the first
 * stored id on a tie) becomes the foreground, re-routing through
 * `activate()` so URL sync, modal disposal, slash-overlay closing and
 * history rebinding happen exactly the way they do when the user clicks
 * the tab. Finally the open set is declared to the WS client so the
 * server resumes broadcasts to all four lanes on the very first paint.
 *
 * Called once from `useF5Resilience` at app mount; safe to call again
 * later but a no-op once the foreground has been set.
 */
export function restoreOpenTabsOnBoot(options: RestoreOpenTabsOptions = {}): string[] {
  // Doc-promise guard: once any foreground is bound, a repeat call is a
  // no-op — re-running the picker would yank the user off the tab they are
  // reading back to the boot pick.
  if (foregroundTabId()) return [];
  const now = options.now ?? Date.now();
  const pick = options.pickForeground ?? defaultPickForeground;
  const slots = useSessionTabStore.getState().openTabIds.slice(0, MAX_OPEN_TABS);
  if (slots.length === 0) return [];

  // Every persisted slot gets its lane pair ensured and its per-session
  // chrome bound, so the user's preferences, subagent focus, file/git
  // state and queued messages for that tab are not dormant after F5.
  for (const id of slots) {
    ensureLane(id);
    ensureSessionLane(id);
    // Bind per-session overrides so a switch to a rehydrated tab shows
    // ITS autonomy/yolo/context-strategy, not whatever defaults leaked
    // from the foreground. `forgetSession` on close is the symmetric move
    // and `releaseTab` already does it; this is the other half of the
    // contract that keeps state from leaking across id reuse.
    useLocalPrefs.getState().bindSession(id);
    // Subagent focus, slash overlays, queue/process/cron panel flags and
    // confirm/fallback visibility are tab-owned; rebinding here means a
    // switch back to the tab finds ITS focus, not the one left in front.
    useUIStore.getState().bindSessionChrome(id);
    // The session catalogue's "current" marker is the row the user is
    // editing; without the rebind the tab strip would show the row as
    // resumable, which would let the user open a duplicate of it.
    useHistoryStore.getState().rebindCurrent(id);
  }

  // Pick the foreground deterministically. `activate()` does the heavy
  // lifting — URL sync, modal disposal, slash-overlay closing, history
  // rebind — exactly as if the user clicked the tab.
  const foreground = pick(slots, now) ?? slots[0];
  if (foreground) {
    activate(foreground);
    useSessionTabStore.getState().markSeen(foreground);
  }

  // Declare the open set to the server BEFORE the first React commit so
  // broadcasts for every lane reach this page on the very first message
  // after reload. `useSessionSubscription` will re-declare on the next
  // effect run; `subscribeSessions` dedupes (see `ws-client.ts`), so the
  // later effect call is a no-op.
  declareOpenTabsNow(slots);

  return slots;
}

export const useSessionTabStore = create<SessionTabState>((set, get) => ({
  openTabIds: readStoredTabs(),
  lastSeenCounts: {},
  attention: {},

  setOpenTabIds: (ids) => {
    const seen = new Set<string>();
    const valid: string[] = [];
    for (const id of ids) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      valid.push(id);
      if (valid.length === MAX_OPEN_TABS) break;
    }
    // A session that lost its slot loses everything the slot owned. This used
    // to dispose the two lanes and stop, so a tab dropped through this path
    // (history purge, slot recycling, a re-announce) left its preference
    // overrides, auto-submit streak, unread count and attention flag behind —
    // and a later session that reused the id inherited them.
    const dropped = get().openTabIds.filter((id) => !seen.has(id));
    for (const id of dropped) releaseTab(id);
    const keep = <T>(record: Record<string, T>): Record<string, T> =>
      Object.fromEntries(Object.entries(record).filter(([id]) => seen.has(id)));
    set({
      openTabIds: valid,
      lastSeenCounts: keep(get().lastSeenCounts),
      attention: keep(get().attention),
    });
    writeStoredTabs(valid);
    if (dropped.length > 0) repointForegroundAfterRelease(valid);
  },

  openTab: (sessionId, options) => {
    if (!sessionId) return { success: false, reason: 'tabs_full' };
    const recycleReentry = options?.recycleReentry === true;
    const activeId = foregroundTabId();
    const tabs = [...get().openTabIds];

    // The session in front always owns a slot, even if the strip has not
    // caught up with it yet.
    if (activeId && !tabs.includes(activeId) && tabs.length < MAX_OPEN_TABS) tabs.push(activeId);

    if (sessionId === activeId) {
      // Guard against the STORED strip, not the local copy above: the push
      // already put the foreground session into `tabs`, so a local check can
      // never fire — the strip stayed without the tab in front (dead branch),
      // and no tab appeared no matter how often that session was opened.
      if (!get().openTabIds.includes(sessionId)) {
        const next = [...tabs.slice(0, MAX_OPEN_TABS - 1), sessionId];
        // Route through setOpenTabIds so a displaced slot (a strip skewed full
        // without the foreground) is RELEASED, not silently overwritten.
        get().setOpenTabIds(next);
      }
      get().markSeen(sessionId);
      return { success: true, reason: 'already_active' };
    }

    // Already open: switch to its slot. One session, one slot — never a
    // second copy of the same session in another tab, and never a second
    // resume request for a session that is already attached to this page.
    // The busy-tab toast is emitted ONLY on the three branches that actually
    // move the foreground off `activeId` — a tabs_full refusal leaves the
    // busy tab in front and must not claim it "keeps running in background".
    // The recycle re-entry passes `recycleReentry`, so its hop stays silent.
    if (tabs.includes(sessionId)) {
      if (activeId && !recycleReentry) notifyBusyTabLeftBehind(activeId);
      activate(sessionId);
      get().markSeen(sessionId);
      return { success: true, reason: 'switched' };
    }

    if (tabs.length < MAX_OPEN_TABS) {
      if (activeId && !recycleReentry) notifyBusyTabLeftBehind(activeId);
      const next = [...tabs, sessionId];
      set({ openTabIds: next });
      writeStoredTabs(next);
      activate(sessionId);
      get().markSeen(sessionId);
      options?.resumeSession?.(sessionId);
      // A re-entry through the recycle path reports the honest reason: the
      // strip did not simply gain a slot — an empty slot was REPLACED.
      return {
        success: true,
        reason: recycleReentry ? 'replaced_empty_tab' : 'opened_new_tab',
      };
    }

    // Strip full: before refusing, recycle ONE empty background slot — a tab
    // whose session never started (no transcript, no run, no agents, no
    // parked prompts) has nothing to lose, so its slot can host the new
    // session instead of bouncing the user with "all four slots are full".
    // The tab in front is never recycled, and a busy slot is never recycled
    // (isTabBusy covers a live run and running subagents). closeTab frees the
    // lane and its per-session state exactly like a manual close; the
    // recursive call then takes the normal below-cap path and terminates —
    // the strip is below MAX, so it cannot re-enter this branch.
    const recyclable = tabs.find((id) => {
      if (id === activeId || isTabBusy(id)) return false;
      // Boot-restore ensures lanes WITHOUT replaying transcripts, so an
      // in-memory-empty lane can still belong to a session with REAL
      // persisted history. Mirror SessionList's empty-session sweep: the
      // record must be content-free (no tokens, no messages) before its
      // slot may host a new session. No record at all = never persisted.
      const entry = useHistoryStore.getState().entries.find((e) => e.id === id);
      if (entry && (entry.tokenTotal > 0 || (entry.messageCount ?? 0) > 0)) return false;
      const lane = readLane(id);
      return (
        describeSessionActivity(id).isEmpty &&
        lane.pendingConfirm === null &&
        lane.pendingFallback === null &&
        lane.pendingRefinement === null
      );
    });
    if (recyclable) {
      if (activeId && !recycleReentry) notifyBusyTabLeftBehind(activeId);
      get().closeTab(recyclable);
      return get().openTab(sessionId, { ...options, recycleReentry: true });
    }

    toast.error(
      i18n.t('activity:sessions.allTabsRunning', {
        defaultValue:
          'Maksimum 4 aktif sekme dolu. Başka bir oturum açmak için önce bir sekmeyi kapatın.',
      }),
    );
    return { success: false, reason: 'tabs_full' };
  },

  closeTab: (sessionId) => {
    const tabs = get().openTabIds;
    const next = tabs.filter((id) => id !== sessionId);

    // Free the lane BEFORE re-pointing, so nothing can land in a slot that no
    // longer exists.
    releaseTab(sessionId);

    const { [sessionId]: _seen, ...lastSeenCounts } = get().lastSeenCounts;
    const { [sessionId]: _att, ...attention } = get().attention;
    set({ openTabIds: next, lastSeenCounts, attention });
    writeStoredTabs(next);
    // Re-point FIRST: the delete below is tagged with whichever session is in
    // front, and the server needs that tag (the session it should move the
    // runtime onto) to allow deleting its own current session.
    repointForegroundAfterRelease(next);
    declareOpenTabsNow(next);
  },

  closeTabsForSessions: (sessionIds) => {
    // The server refuses to delete a session with an active run, so a busy
    // session is neither closable nor deletable here — its tab stays visible
    // and its run stays observable.
    const removable = new Set(sessionIds.filter((id) => !isTabBusy(id)));
    const tabs = [...get().openTabIds];
    if (removable.size === 0) return [];

    if (tabs.length === 0) return [...removable];

    let keep = tabs.filter((id) => !removable.has(id));
    if (keep.length === 0) {
      // Every slot belongs to a doomed session. The strip never drops to
      // zero: keep exactly one tab — the foreground when possible — and
      // report its session as NOT removable so the caller skips deleting it.
      const active = foregroundTabId();
      const spared = active && removable.has(active) ? active : tabs[tabs.length - 1];
      keep = [spared];
      removable.delete(spared);
    }

    get().setOpenTabIds(keep);
    // Declare the shrunken set before the caller's deletes go out, so the
    // deletions cannot be refused as "still displayed by this connection".
    declareOpenTabsNow(keep);
    return [...removable];
  },

  markSeen: (sessionId) =>
    set((s) => ({
      lastSeenCounts: { ...s.lastSeenCounts, [sessionId]: readLane(sessionId).messages.length },
      attention: { ...s.attention, [sessionId]: false },
    })),

  setAttention: (sessionId, needsAttention) =>
    set((s) => ({ attention: { ...s.attention, [sessionId]: needsAttention } })),
}));

/**
 * Everything the tab strip and the tab map need about one slot, read straight
 * from the lane registries. There is no separate per-tab mirror to drift.
 */
export function summarizeTab(sessionId: string, slot: number): TabSummary {
  const chat = readLane(sessionId);
  const meta = readSessionLane(sessionId);
  const tabState = useSessionTabStore.getState();
  const activeId = useSessionLanes.getState().activeSessionId;

  let agentsRunning = 0;
  let agentsTotal = 0;
  for (const agent of useFleetStore.getState().agents.values()) {
    if (agent.sessionId !== sessionId) continue;
    agentsTotal += 1;
    if (agent.status === 'running') agentsRunning += 1;
  }

  const seen = tabState.lastSeenCounts[sessionId] ?? chat.messages.length;
  const isActive = sessionId === activeId;
  const tokens = meta.totalTokens.input + meta.totalTokens.output;

  return {
    slot,
    sessionId,
    isActive,
    title:
      useUIStore.getState().sessionNicknames[sessionId] ||
      meta.session?.title ||
      sessionId.slice(0, 8),
    provider: meta.session?.provider ?? '',
    model: meta.session?.model ?? '',
    mode: meta.mode,
    isRunning: chat.isLoading,
    messageCount: chat.messages.length,
    unread: isActive ? 0 : Math.max(0, chat.messages.length - seen),
    queued: chat.queue.length,
    agentsRunning,
    agentsTotal,
    tokens,
    cost: meta.cost,
    contextPct:
      meta.maxContext > 0 && meta.lastInputTokens > 0
        ? Math.min(100, Math.round((meta.lastInputTokens / meta.maxContext) * 100))
        : 0,
    needsAttention: !isActive && tabState.attention[sessionId] === true,
  };
}

/** Ordered summaries for every open slot. */
function summarizeTabs(): TabSummary[] {
  return useSessionTabStore.getState().openTabIds.map((id, i) => summarizeTab(id, i));
}

/** Which slot a session sits in, or -1. Enforces the one-session-one-tab rule
 *  at read time so callers cannot invent a second home for a session. */
export function slotOf(sessionId: string): number {
  return useSessionTabStore.getState().openTabIds.indexOf(sessionId);
}

/** True when the session has a lane but no slot — a state that should never
 *  persist; used by the reconciler to clean up after a dropped tab. */
function isOrphanLane(sessionId: string): boolean {
  return hasLane(sessionId) && slotOf(sessionId) === -1;
}

export { chatLane };
