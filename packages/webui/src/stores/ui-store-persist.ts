import type { PersistOptions } from "zustand/middleware";
import type { UIState } from "./ui-store-types.js";
import {
  coerceActivity,
  coerceView,
  coerceDockSection,
  coerceSettingsTab,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
} from "./ui-store-types.js";
import {
  isDesktopShellStorageContext,
  homeNavigationStatePatch,
} from "./ui-store-chrome.js";

export const uiPersistOptions: PersistOptions<UIState, Partial<UIState>> = {
      name: 'wrongstack-ui',
      version: 7,
      // v0 → v1: 'context'/'sessions' activities were removed and the
      // sidebar width bounds changed — coerce persisted values so a stale
      // localStorage entry can't select a panel that no longer exists.
      // v1 → v2: the modal FleetDrawer/AgentsDrawer were replaced by a
      // single docked InspectorPanel; drop the stale drawer booleans so
      // they can't force the (removed) fields back into state.
      // v2 → v3: added skillsState for Skills panel breadcrumb persistence.
      // v3 → v4: added knownRefs and updateAvailableCount to skillsState.
      // v4 → v5: added `currentView` and `dockSection` to partialize
      // (F5-resilience). No shape change to existing fields — the coerce
      // for the new fields is defensive in case a user with a hand-
      // edited localStorage entry lands here first.
      // v5 → v6: removed `draftInput` from partialize. The chat input draft
      // is now in-memory only (survives Settings→Chat view navigation but
      // NOT page reload or new sessions). Stale draftInput values from v5
      // localStorage are dropped here so they don't bleed into a new session.
      // v6 → v7: removed `chromeSessionId` and `chromeBySession` from
      // partialize. Per-session chrome is tab runtime state; keeping it after
      // a fresh WebUI boot resurrects stale session-local UI without the tabs
      // that owned it.
      migrate: (persisted, version) => {
        const p = (persisted ?? {}) as Record<string, unknown>;
        p.activeActivity = coerceActivity(p.activeActivity);
        if (typeof p.sidebarWidth === 'number') {
          p.sidebarWidth = Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, p.sidebarWidth));
        }
        if (version < 2) {
          delete p.fleetDrawerOpen;
          delete p.agentsDrawerOpen;
        }
        // v5: defensive coerce of the newly-persisted fields.
        if ('currentView' in p) {
          p.currentView = coerceView(p.currentView);
        }
        if ('dockSection' in p) {
          p.dockSection = coerceDockSection(p.dockSection);
        }
        if ('settingsActiveTab' in p) {
          p.settingsActiveTab = coerceSettingsTab(p.settingsActiveTab);
        }
        if (version < 6) {
          // v6: draftInput is no longer persisted — drop any stale value
          // so it doesn't bleed into a new session on next load.
          delete p.draftInput;
        }
        if (version < 7) {
          delete p.chromeSessionId;
          delete p.chromeBySession;
        }
        return p as never as UIState;
      },
      merge: (persisted, current) => {
        const merged = {
          ...current,
          ...((persisted ?? {}) as Partial<UIState>),
        } as UIState;
        merged.activeActivity = coerceActivity(merged.activeActivity);
        merged.currentView = coerceView(merged.currentView);
        merged.dockSection = coerceDockSection(merged.dockSection);
        merged.settingsActiveTab = coerceSettingsTab(merged.settingsActiveTab);
        if (typeof merged.chromeSessionId !== 'string') {
          merged.chromeSessionId = null;
        }
        if (typeof merged.chromeBySession !== 'object' || merged.chromeBySession === null) {
          merged.chromeBySession = {};
        }
        merged.sidebarWidth = Math.max(
          SIDEBAR_MIN_WIDTH,
          Math.min(SIDEBAR_MAX_WIDTH, merged.sidebarWidth),
        );
        return isDesktopShellStorageContext()
          ? { ...merged, ...homeNavigationStatePatch({ sidebarOpen: false }) }
          : merged;
      },
      partialize: (s) => ({
        sidebarOpen: s.sidebarOpen,
        activeActivity: s.activeActivity,
        sidebarWidth: s.sidebarWidth,
        promptHistory: s.promptHistory,
        pinnedIds: s.pinnedIds,
        compactMode: s.compactMode,
        favoriteSessionIds: s.favoriteSessionIds,
        sessionNicknames: s.sessionNicknames,
        fileExplorerWidth: s.fileExplorerWidth,
        refineEnabled: s.refineEnabled,
        hiddenChips: s.hiddenChips,
        workDashboardTab: s.workDashboardTab,
        inspectorOpen: s.inspectorOpen,
        inspectorTab: s.inspectorTab,
        skillsState: s.skillsState,
        // ── F5 resilience additions ──
        // currentView + dockSection pair: after F5 we land the user
        // back on whichever main view + dock section they were on. This
        // is the *last-known-good* view; if the active session switches
        // (e.g. resume of a different session), the connection layer is
        // expected to navigate back to chat defensively because
        // non-chat views are session-agnostic and can confuse the user
        // when the session doesn't actually own them. Navigation callers
        // should go through `view-navigation` helpers so the side-panel and
        // main view stay paired.
        //
        // We intentionally do NOT persist overlay open states
        // (processMonitorOpen, queuePanelOpen, terminalOpen, etc.):
        // those should land closed after F5. The dock, sidebar, and main
        // view *are* the user's persistent workspace, so they survive.
        currentView: s.currentView,
        dockSection: s.dockSection,
        settingsActiveTab: s.settingsActiveTab,
        scrollPositions: s.scrollPositions,
        // draftInput intentionally NOT persisted — it is in-memory only so
        // a stale draft from a previous session does not reappear on a
        // fresh WebUI load or after starting a new session. View navigation
        // (Settings → Chat) reads it from the live store, not localStorage.
      }),
};