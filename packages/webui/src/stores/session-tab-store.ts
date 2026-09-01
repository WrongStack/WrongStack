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
import { useRestoreTabsStore } from './restore-tabs-store';
import { useResumeProgressStore } from './resume-progress-store';
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
import { useToolStatsStore } from './tool-stats-store';
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
  // Arriving at a tab always lands on the Leader chat — subagent focus is
  // foreground-only and never follows the user across tabs (setSubagentChatFocus
  // still stamps the session so ChatView can clear a focus that names another).
  const ui = useUIStore.getState();
  ui.bindSessionChrome(sessionId);
  ui.setSubagentChatFocus(null, sessionId);
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
/**
 * Tell the server this tab is in front. Never asks for its conversation back —
 * that is `session.resume`, and a tab already on screen must not be resumed.
 */
function focusOnServer(sessionId: string): void {
  try {
    getWSClient().focusSessionById(sessionId);
  } catch {
    // No socket (tests, a page before connect): the foreground is a client-side
    // pointer either way, and the next stamped message names the session.
  }
}

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
/**
 * Drop persisted tabs the SERVER is not holding, and return what survives.
 *
 * The tab strip lives in `localStorage`, so it outlives the process that
 * created it. After a restart every id in it names a session this runtime has
 * never heard of — and promoting them anyway is what made a fresh
 * `wstack --webui` open wearing the previous run's tabs, front a conversation
 * from days ago, and sit through a full journal resume (todo board included)
 * before the user had typed a character.
 *
 * A dropped tab is not a deleted session: the transcript stays on disk and in
 * History, where reopening it is an explicit act. This only says it is no
 * longer *open*.
 *
 * `live` is the runtime's own list (`openSessionIds` on the boot frame). An
 * empty or absent list means "trust nothing" and is treated as no tabs — the
 * caller then seeds the strip with the session the server just announced.
 */
export function pruneTabsToLiveSessions(live: readonly string[]): string[] {
  const alive = new Set(live.filter((id) => typeof id === 'string' && id.length > 0));
  const stored = useSessionTabStore.getState().openTabIds;
  const kept = stored.filter((id) => alive.has(id));
  if (kept.length === stored.length) return kept;
  for (const id of stored) {
    if (!alive.has(id)) releaseTab(id);
  }
  writeStoredTabs(kept);
  useSessionTabStore.setState({ openTabIds: kept });
  return kept;
}

/** One-shot latch: the boot restore may only run once per page load. */
let bootRestoreDone = false;

/** Test seam — lets a suite re-arm the one-shot latch. */
export function resetBootRestoreLatchForTests(): void {
  bootRestoreDone = false;
}

/**
 * Reconcile the persisted tab strip with the server, then promote what is left.
 *
 * Runs once per page load, driven by whichever comes first:
 *
 * - the boot `session.start` frame, which carries `openSessionIds` — the
 *   sessions this runtime is actually holding. Stale slots are dropped, and if
 *   NOTHING survives the strip stays empty so the announced session becomes the
 *   single tab. That is the whole point: a fresh `wstack --webui` must open on
 *   an empty conversation, not on a tab strip from a previous run.
 * - a fallback timer, for a server too old to send the field or a page that
 *   never connects. There the strip is restored unfiltered, which is the
 *   behaviour that existed before this reconciliation.
 *
 * `live === undefined` means "no answer", NOT "nothing is live" — the two must
 * not collapse, or an old server would wipe the user's tabs on every open.
 */
export function restoreTabsAfterBoot(
  live: readonly string[] | undefined,
  options: RestoreOpenTabsOptions = {},
): string[] {
  if (bootRestoreDone) return [];
  bootRestoreDone = true;
  if (live === undefined) return restoreOpenTabsOnBoot(options);

  const alive = new Set(live.filter((id) => typeof id === 'string' && id.length > 0));
  const stale = useSessionTabStore.getState().openTabIds.filter((id) => !alive.has(id));
  pruneTabsToLiveSessions(live);
  const restored = restoreOpenTabsOnBoot(options);
  // Offered, not resumed. A session the runtime does not hold costs a full
  // journal read to bring back, and doing that unasked is what made a fresh
  // WebUI open on somebody else's conversation.
  if (stale.length > 0) useRestoreTabsStore.getState().offer(stale);
  return restored;
}

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
    // Tell the server which tab this page came back on. Without it the runtime
    // stays wherever it was, which after a RESTART is a session that has
    // nothing to do with the restored strip: every message from the tab in
    // front is then answered with "this WebUI runtime is currently on …" and
    // the page looks alive but cannot be typed into. A focus on a session the
    // process is not holding opens it, so this doubles as the moment a
    // reloaded page reclaims its conversation.
    focusOnServer(foreground);
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
    // second copy of the same session in another tab.
    //
    // A session on screen is NEVER resumed again. Resuming re-reads a
    // conversation the page is already displaying and answers with a replay
    // rebuilt from the working set — no live tool cards, no audit markers,
    // every message under a new id — so a click that should have moved a
    // pointer rewrote the tab instead. What the server actually needs to know
    // is only which tab is in front, and that is `session.focus`: it moves the
    // runtime's session, the connection's acting id and the todo board, and
    // sends no transcript. (A focus on a session the server is not holding —
    // a page that outlived its process — still falls through to a real resume
    // server-side, so a stale tab is not left blank.)
    //
    // The busy-tab toast is emitted ONLY on the three branches that actually
    // move the foreground off `activeId` — a tabs_full refusal leaves the
    // busy tab in front and must not claim it "keeps running in background".
    // The recycle re-entry passes `recycleReentry`, so its hop stays silent.
    if (tabs.includes(sessionId)) {
      if (activeId && !recycleReentry) notifyBusyTabLeftBehind(activeId);
      activate(sessionId);
      get().markSeen(sessionId);
      // An EMPTY slot is the one focus that may turn into a real wait. The
      // server answers a focus for a session it holds with no transcript
      // (the tab already has it), but a page that outlived its process is
      // focusing a session the runtime has never opened — and there the
      // focus falls through to a full journal resume server-side. That slot
      // has nothing on screen meanwhile, which is the same blank pane the
      // resume indicator exists for. A focus the server answers immediately
      // clears the flag on arrival, so marking it costs nothing.
      if (readLane(sessionId).messages.length === 0) {
        useResumeProgressStore.getState().begin(sessionId);
      }
      focusOnServer(sessionId);
      return { success: true, reason: 'switched' };
    }

    if (tabs.length < MAX_OPEN_TABS) {
      if (activeId && !recycleReentry) notifyBusyTabLeftBehind(activeId);
      const next = [...tabs, sessionId];
      set({ openTabIds: next });
      writeStoredTabs(next);
      activate(sessionId);
      get().markSeen(sessionId);
      // Mark the wait BEFORE the request goes out. The slot is already on
      // screen and the lane is empty, so without this the pane renders the
      // welcome screen for however long the server needs to replay the
      // journal — which on a large one is long enough to read as "the
      // transcript is gone". Every resume reaches the server through this
      // callback, so one call here covers the history list, the tab strip, the
      // command palette and the restore-tabs modal alike.
      if (options?.resumeSession) {
        useResumeProgressStore.getState().begin(sessionId);
        options.resumeSession(sessionId);
      }
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

/** Which slot a session sits in, or -1. Enforces the one-session-one-tab rule
 *  at read time so callers cannot invent a second home for a session. */
export function slotOf(sessionId: string): number {
  return useSessionTabStore.getState().openTabIds.indexOf(sessionId);
}

export { chatLane };
