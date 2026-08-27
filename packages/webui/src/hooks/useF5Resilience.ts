import { useEffect } from 'react';
import { showPanel } from '@/components/activity-bar/nav';
import { useChatStore, useConfigStore, useSessionStore, useUIStore } from '@/stores';
import { activeLaneId, DEFAULT_LANE_ID, disposeLane, laneIds } from '@/stores/chat-lanes';
import { useLocalPrefs } from '@/stores/local-prefs';
import { disposeSessionLane } from '@/stores/session-lanes';
import { useSessionTabStore } from '@/stores/session-tab-store';

/**
 * F5 / tab-close resilience.
 *
 * Two concerns, both mounted once on app boot:
 *
 * 1. **Persist flush** — zustand's `persist` middleware writes asynchronously,
 *    so in-flight mutations can be lost on page teardown (F5, tab close,
 *    navigation). This effect hooks `pagehide` and `beforeunload` to force a
 *    synchronous flush of every persisted store before the page disappears.
 *
 * 2. **Lane/slot reconciliation** — the open-tab list and the lanes persist
 *    under separate keys, so a refresh can restore one without the other.
 *
 * 3. **View fallback** — if the persisted `currentView` was an exotic overlay
 *    (debug, analytics, design-gallery, setup), auto-navigate to `chat` so
 *    the user lands on a usable surface instead of a stale debug screen.
 */
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
      disposeLane(id);
      disposeSessionLane(id);
    }
  }, []);

  // ── 3. View fallback ─────────────────────────────────────────────────────
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
