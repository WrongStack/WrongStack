import { useEffect } from 'react';
import { showPanel } from '@/components/activity-bar/nav';
import { useChatStore, useConfigStore, useSessionStore, useUIStore } from '@/stores';
import { activeLaneId, DEFAULT_LANE_ID, laneIds } from '@/stores/chat-lanes';
import { useLocalPrefs } from '@/stores/local-prefs';
import {
  activeSessionLaneId,
  sessionLaneIds,
  SESSION_DEFAULT_LANE_ID,
} from '@/stores/session-lanes';
import {
  releaseTab,
  restoreTabsAfterBoot,
  useSessionTabStore,
} from '@/stores/session-tab-store';

/**
 * F5 / tab-close resilience.
 *
 * Three concerns, all mounted once on app boot:
 *
 * 1. **Persist flush** — zustand's `persist` middleware writes asynchronously,
 *    so in-flight mutations can be lost on page teardown (F5, tab close,
 *    navigation). This effect hooks `pagehide` and `beforeunload` to force a
 *    synchronous flush of every persisted store before the page disappears.
 *
 * 2. **Lane/slot reconciliation** — the open-tab list and the lanes persist
 *    under separate keys, so a refresh can restore one without the other.
 *
 * 3. **Restore open tabs** — the inverse of reconciliation: the persisted
 *    slot list is promoted into active, foregrounded tabs so a browser
 *    refresh leaves the user's tabs where they were, not as a half-empty
 *    welcome screen. Per-tab preferences, subagent focus, history rebind
 *    and the WS open-set declaration all happen here, before the first
 *    React commit so server broadcasts resume on every lane immediately.
 *
 * 4. **View fallback** — if the persisted `currentView` was an exotic overlay
 *    (debug, analytics, design-gallery, setup), auto-navigate to `chat` so
 *    the user lands on a usable surface instead of a stale debug screen.
 */
/**
 * How long to wait for the boot `session.start` frame before restoring the tab
 * strip unfiltered. Long enough for a local socket round-trip, short enough
 * that a disconnected page still gets its tabs back promptly.
 */
const BOOT_RESTORE_FALLBACK_MS = 2_000;

export function useF5Resilience(): void {
  // ── 1. Persist flush ─────────────────────────────────────────────────────
  useEffect(() => {
    const flush = (): void => {
      try {
        // `useLocalPrefs` belongs here too: since preferences went per-tab it
        // holds the `bySession` override map, which is the only record of what
        // each background tab was configured with.
        const stores = [useSessionStore, useChatStore, useUIStore, useConfigStore, useLocalPrefs];
        for (const s of stores) {
          const persistApi = (
            s as unknown as {
              persist?: { flush?: () => void; getOptions?: () => { storage?: unknown } };
            }
          ).persist;
          if (persistApi && typeof persistApi.flush === 'function') {
            persistApi.flush();
          }
        }
      } catch {
        // ignore — best-effort flush.
      }
    };
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', flush);
    };
  }, []);

  // ── 2. Lane/slot reconciliation ──────────────────────────────────────────
  /**
   * Drop lanes that came back from localStorage without a slot.
   *
   * The four slots and the four lanes are persisted under SEPARATE keys, and
   * nothing makes the two writes atomic — a refresh caught between them (or an
   * older build's leftovers) restores a lane whose tab does not exist. Such a
   * lane is invisible and unclosable, yet it still counts against the
   * four-lane ceiling, so the FIFTH lane the user then legitimately opens is
   * the one whose events get dropped. Runs once, at boot, before any session
   * work starts.
   */
  useEffect(() => {
    const slots = new Set(useSessionTabStore.getState().openTabIds);
    // The lane pointer also survives a refresh, and the session it names gets
    // a slot back the moment the tab strip runs — it is not an orphan.
    const pointer = activeLaneId();
    for (const id of laneIds()) {
      if (slots.has(id) || id === pointer) continue;
      // The pre-session lane is not an orphan either: it is where boot-time
      // typing lands until the first session adopts it.
      if (id === DEFAULT_LANE_ID) continue;
      // releaseTab, not the bare lane disposals: the per-session preference
      // overrides and subagent chrome persist under their OWN keys, so a lane
      // dropped here must not leave them behind for a reused id to inherit.
      releaseTab(id);
    }
    // SESSION-lane orphans. Both concerns above walk the CHAT registry, but
    // the two lane registries persist under separate keys too — a partial
    // write can restore a session lane whose chat lane is gone. That orphan
    // survives the loop above, yet it still counts against the four-lane
    // ceiling inside `sessionFor`, so a fifth session's tokens and cost are
    // silently dropped. Keep a session lane only while a tab, the session
    // pointer, the pre-session default, or a live chat lane still names it.
    const chatIds = new Set(laneIds());
    const sessionPointer = activeSessionLaneId();
    for (const id of sessionLaneIds()) {
      if (slots.has(id) || id === sessionPointer) continue;
      if (id === SESSION_DEFAULT_LANE_ID || chatIds.has(id)) continue;
      releaseTab(id);
    }
  }, []);

  // ── 3. Restore open tabs ─────────────────────────────────────────────────
  /**
   * Promote the persisted slot list into active, foregrounded tabs.
   *
   * After the orphan-reconciliation above has cleared lanes that have no
   * slot, every remaining id in `useSessionTabStore.openTabIds` is a tab
   * the user had open before the refresh. Each gets its lane pair ensured
   * and its per-session preferences, subagent focus and history rebind
   * bound; the most-recently-visited one (or the first stored id on a tie)
   * is activated exactly as if the user had clicked it, and the open set
   * is declared to the WS client so broadcasts resume on every lane
   * before the first React commit. Runs once, at boot.
   *
   * MUST run AFTER the orphan-reconciliation effect above so the lanes we
   * promote are the ones that survived, and BEFORE `useSessionSubscription`
   * fires so the WS client's dedupe makes the later re-declaration a
   * no-op rather than racing against ours.
   */
  useEffect(() => {
    // The restore is DRIVEN BY THE SERVER now: the boot `session.start` frame
    // carries `openSessionIds`, and `handleSessionStart` calls
    // `restoreTabsAfterBoot` with it so stale slots are dropped before any of
    // them is promoted or fronted. Fronting a session this runtime never had
    // is what cost a full journal resume — todo board included — on a fresh
    // `wstack --webui`.
    //
    // This timer is the fallback for the cases where that frame never comes:
    // a server too old to send the field, or a page that fails to connect.
    // `restoreTabsAfterBoot` is a one-shot latch, so whichever fires first
    // wins and the other is a no-op.
    const timer = setTimeout(() => restoreTabsAfterBoot(undefined), BOOT_RESTORE_FALLBACK_MS);
    return () => clearTimeout(timer);
  }, []);

  // ── 4. View fallback ─────────────────────────────────────────────────────
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (
      window.location.pathname === '/debug' ||
      window.location.pathname === '/analytics' ||
      window.location.pathname === '/refresh-debug'
    ) {
      return;
    }
    const persistedView = useUIStore.getState().currentView;
    if (
      persistedView === 'debug' ||
      persistedView === 'analytics' ||
      persistedView === 'design-gallery' ||
      persistedView === 'setup'
    ) {
      showPanel('chat');
    }
  }, []);
}
