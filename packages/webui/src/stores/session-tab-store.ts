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
import { disposeStreakState } from './auto-submit-streak';
import { chatLane, disposeLane, hasLane, MAX_LANES, readLane, setActiveLane } from './chat-lanes';
import { useCouncilLogStore } from './council-log-store';
import { useFallbackStore } from './fallback-store';
import { useFleetStore } from './fleet-store';
import { useLocalPrefs } from './local-prefs';
import { useMemoryInjectorTraceStore } from './memory-injector-store';
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
  openTab: (sessionId: string, options?: { resumeSession?: (id: string) => void }) => OpenTabResult;
  closeTab: (sessionId: string) => void;
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
  // Two diagnostic logs are FOREGROUND-ONLY by construction: their handlers
  // drop anything that is not the tab in front, so they hold whatever the
  // previous tab produced and nothing for this one. Left standing they read as
  // this tab's memory injections and this tab's Brain deliberations — the chat
  // header even counts them. Empty is honest; stale is not.
  useMemoryInjectorTraceStore.getState().clear();
  useCouncilLogStore.getState().clear();
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

/** A tab is disposable when it is idle AND has nothing in it. */
function isTabDisposable(sessionId: string): boolean {
  if (isTabBusy(sessionId)) return false;
  const lane = readLane(sessionId);
  return lane.messages.length === 0 && lane.queue.length === 0;
}

/**
 * Everything one slot owns, freed in one place.
 *
 * `closeTab` and `setOpenTabIds` both retire a tab, and they used to free
 * different things: the lanes always, the preference overrides and
 * auto-submit streak only on the explicit close. A tab dropped by the other
 * path left state that the NEXT session to be handed that id silently
 * inherited, which is the one thing the four-lane model exists to prevent.
 */
function releaseTab(sessionId: string): void {
  disposeLane(sessionId);
  disposeSessionLane(sessionId);
  useLocalPrefs.getState().forgetSession(sessionId);
  useSystemPromptStore.getState().dropSession(sessionId);
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
    const activeId = foregroundTabId();
    const tabs = [...get().openTabIds];

    // The session in front always owns a slot, even if the strip has not
    // caught up with it yet.
    if (activeId && !tabs.includes(activeId) && tabs.length < MAX_OPEN_TABS) tabs.push(activeId);

    if (sessionId === activeId) {
      if (!tabs.includes(sessionId)) {
        const next = [...tabs.slice(0, MAX_OPEN_TABS - 1), sessionId];
        set({ openTabIds: next });
        writeStoredTabs(next);
      }
      get().markSeen(sessionId);
      return { success: true, reason: 'already_active' };
    }

    // Already open: switch to its slot. One session, one slot — never a
    // second copy of the same session in another tab.
    if (tabs.includes(sessionId)) {
      activate(sessionId);
      get().markSeen(sessionId);
      options?.resumeSession?.(sessionId);
      return { success: true, reason: 'switched' };
    }

    if (tabs.length < MAX_OPEN_TABS) {
      const next = [...tabs, sessionId];
      set({ openTabIds: next });
      writeStoredTabs(next);
      activate(sessionId);
      get().markSeen(sessionId);
      options?.resumeSession?.(sessionId);
      return { success: true, reason: 'opened_new_tab' };
    }

    // Full. Recycle an idle, empty slot rather than growing past four.
    const recyclable = tabs.find((id) => isTabDisposable(id));
    if (recyclable) {
      // One retirement path for every slot owner: `releaseTab` frees the
      // lanes AND the preference overrides / system-prompt pick / streak.
      // Disposing the lanes alone is the exact leak its doc comment warns
      // about — the next session handed this id inherits the old one's state.
      releaseTab(recyclable);
      const next = tabs.map((id) => (id === recyclable ? sessionId : id));
      set({ openTabIds: next });
      writeStoredTabs(next);
      activate(sessionId);
      get().markSeen(sessionId);
      options?.resumeSession?.(sessionId);
      return { success: true, reason: 'replaced_empty_tab' };
    }

    toast.error(
      'Maksimum 4 aktif sekme dolu. Başka bir oturum açmak için önce bir sekmeyi kapatın.',
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
    repointForegroundAfterRelease(next);
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
    title: meta.session?.title || sessionId.slice(0, 8),
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
export function summarizeTabs(): TabSummary[] {
  return useSessionTabStore.getState().openTabIds.map((id, i) => summarizeTab(id, i));
}

/** Which slot a session sits in, or -1. Enforces the one-session-one-tab rule
 *  at read time so callers cannot invent a second home for a session. */
export function slotOf(sessionId: string): number {
  return useSessionTabStore.getState().openTabIds.indexOf(sessionId);
}

/** True when the session has a lane but no slot — a state that should never
 *  persist; used by the reconciler to clean up after a dropped tab. */
export function isOrphanLane(sessionId: string): boolean {
  return hasLane(sessionId) && slotOf(sessionId) === -1;
}

export { chatLane };
