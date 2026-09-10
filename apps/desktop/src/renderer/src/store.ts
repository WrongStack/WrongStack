/**
 * The shell's state, as one external store.
 *
 * Every IPC event used to call a `render()` that did
 * `appRoot.innerHTML = <the entire sidebar>`. Focus, scroll position and any
 * open input were destroyed on every runtime status change, and with several
 * projects open that happened many times a second.
 *
 * React subscribes here through `useSyncExternalStore` instead, so a runtime
 * status change re-renders the rows that actually changed. The store is a
 * plain module singleton rather than context: there is exactly one shell, and
 * the IPC bridge it wraps is a process-wide object.
 *
 * State is replaced immutably on every mutation so `useSyncExternalStore` can
 * compare snapshots by identity — mutating in place would make React skip the
 * update.
 */
import type {
  DesktopOpenSessionEntry,
  DesktopOpenSessionsSnapshot,
  DesktopStateSnapshot,
  DesktopWebuiCommand,
  DesktopWebuiStatusSnapshot,
} from '../../shared/types.js';

export interface LauncherFeedback {
  state: 'pending' | 'success' | 'error';
  label: string;
  commandKey: string;
  message?: string | undefined;
}

export interface ShellState {
  desktop: DesktopStateSnapshot;
  webuiStatus: DesktopWebuiStatusSnapshot;
  /** Project roots whose session list is expanded in the tree. */
  expanded: ReadonlySet<string>;
  /** The actual open WebUI slots, keyed by runtime id. */
  openSessions: ReadonlyMap<string, DesktopShellSession[]>;
  sidebarCollapsed: boolean;
  /** Free-text filter over the project tree. */
  filter: string;
  busy: boolean;
  error: string | null;
  launcher: LauncherFeedback | null;
}

export type DesktopShellSession = DesktopOpenSessionEntry & { runtimeId: string };

const EMPTY_DESKTOP: DesktopStateSnapshot = {
  activeRuntimeId: null,
  runtimes: [],
  recentProjects: [],
  registeredProjects: [],
  restoring: false,
};

let state: ShellState = {
  desktop: EMPTY_DESKTOP,
  webuiStatus: { runtimeId: null, status: 'idle' },
  expanded: new Set(),
  openSessions: new Map(),
  sidebarCollapsed: false,
  filter: '',
  busy: false,
  error: null,
  launcher: null,
};
let openSessionsRevision = 0;

const listeners = new Set<() => void>();

function set(patch: Partial<ShellState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSnapshot(): ShellState {
  return state;
}

/** Test seam: reset the module singleton between cases. */
export function __resetStore(): void {
  state = {
    desktop: EMPTY_DESKTOP,
    webuiStatus: { runtimeId: null, status: 'idle' },
    expanded: new Set(),
    openSessions: new Map(),
    sidebarCollapsed: false,
    filter: '',
    busy: false,
    error: null,
    launcher: null,
  };
  openSessionsRevision = 0;
  listeners.clear();
}

// ── UI-local state ──────────────────────────────────────────────────────────

export function setFilter(filter: string): void {
  set({ filter });
}

export function clearError(): void {
  set({ error: null });
}

export function setError(error: string): void {
  set({ error });
}

export function setLauncher(launcher: LauncherFeedback | null): void {
  set({ launcher });
}

/**
 * Expand or collapse a project's live WebUI tab list.
 */
export function toggleExpanded(projectRoot: string): void {
  const expanded = new Set(state.expanded);
  if (expanded.has(projectRoot)) {
    expanded.delete(projectRoot);
    set({ expanded });
    return;
  }
  expanded.add(projectRoot);
  set({ expanded });
}

function applyOpenSessions(snapshot: DesktopOpenSessionsSnapshot): void {
  openSessionsRevision += 1;
  const openSessions = new Map(state.openSessions);
  if (snapshot.sessions.length === 0) openSessions.delete(snapshot.runtimeId);
  else {
    openSessions.set(
      snapshot.runtimeId,
      snapshot.sessions.map((session) => ({ ...session, runtimeId: snapshot.runtimeId })),
    );
  }
  set({ openSessions });
}

// ── Bridge-backed actions ───────────────────────────────────────────────────

/**
 * Run a bridge call that returns a fresh snapshot, with a busy flag around it.
 *
 * The flag exists so the UI can disable controls during a project start rather
 * than letting a second click spawn a second runtime; errors surface in the
 * shell's error strip instead of being swallowed.
 */
async function withBusy(run: () => Promise<DesktopStateSnapshot | void>): Promise<void> {
  set({ busy: true, error: null });
  try {
    const next = await run();
    if (next) set({ desktop: next });
  } catch (err) {
    set({ error: err instanceof Error ? err.message : String(err) });
  } finally {
    set({ busy: false });
  }
}

const api = () => window.wrongstackDesktop;

export const actions = {
  openProject: (root?: string) => withBusy(() => api().openProject(root)),
  registerProject: () => withBusy(() => api().registerProject()),
  unregisterProject: (root: string) => withBusy(() => api().unregisterProject(root)),
  newSession: (runtimeId?: string) => withBusy(() => api().openProjectSession(runtimeId)),
  focusSession: (runtimeId: string, sessionId: string, title: string) =>
    actions.webuiCommand({ sessionId }, title, runtimeId),
  openSettings: () => withBusy(() => api().openSettings()),
  activate: (runtimeId: string) => withBusy(() => api().activateRuntime(runtimeId)),
  close: (runtimeId: string) => withBusy(() => api().closeRuntime(runtimeId)),
  openInBrowser: (runtimeId: string) => withBusy(() => api().openRuntimeInBrowser(runtimeId)),
  revealRoot: (runtimeId: string) => withBusy(() => api().revealRuntimeRoot(runtimeId)),
  reloadWebui: () =>
    withBusy(async () => {
      // Returns a boolean, not a snapshot; nothing about the runtime list changes.
      await api().reloadWebui();
    }),

  /** Activate a runtime and then reload its WebUI, in that order. */
  activateAndReload: (runtimeId: string) =>
    withBusy(async () => {
      const next = await api().activateRuntime(runtimeId);
      await api().reloadWebui();
      return next;
    }),

  toggleSidebar(): void {
    const sidebarCollapsed = !state.sidebarCollapsed;
    set({ sidebarCollapsed });
    void api().setShellSidebarCollapsed(sidebarCollapsed);
  },

  /**
   * Send a navigation command to the embedded WebUI, reporting progress in the
   * launcher strip. `runtimeId` activates that runtime first, for commands
   * fired from a row that is not the active one.
   */
  async webuiCommand(
    command: DesktopWebuiCommand,
    label: string,
    runtimeId?: string,
  ): Promise<void> {
    const commandKey = runtimeId ? `${runtimeId}:${label}` : label;
    set({ launcher: { state: 'pending', label, commandKey } });
    try {
      if (runtimeId) {
        const next = await api().activateRuntime(runtimeId);
        set({ desktop: next });
      }
      const ok = await api().navigateWebui(command);
      if (ok) {
        set({ launcher: { state: 'success', label, commandKey } });
        return;
      }
      set({
        launcher: {
          state: 'error',
          label,
          commandKey,
          message: 'WebUI did not accept the command',
        },
        error: 'WebUI did not accept the command',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ launcher: { state: 'error', label, commandKey, message }, error: message });
    }
  },
};

// ── IPC wiring ──────────────────────────────────────────────────────────────

/**
 * Attach to the main process and load the first snapshot.
 *
 * Returns a teardown so tests can detach; the shell itself never calls it.
 */
export function connect(): () => void {
  const bridge = window.wrongstackDesktop;
  const initialOpenSessionsRevision = openSessionsRevision;
  const offState = bridge.onStateChanged((next) => {
    // Open-session lifecycle arrives on its own narrow event; keep the runtime
    // snapshot independent so a status tick cannot overwrite the four slots.
    set({ desktop: next });
  });
  const offWebui = bridge.onWebuiStatusChanged((next) => set({ webuiStatus: next }));
  const offOpenSessions = bridge.onOpenSessionsChanged(applyOpenSessions);
  const offSidebar = bridge.onShellSidebarCollapsedChanged((collapsed) =>
    set({ sidebarCollapsed: collapsed }),
  );

  void (async () => {
    try {
      const [desktop, webuiStatus, openSessionSnapshots] = await Promise.all([
        bridge.getState(),
        bridge.getWebuiStatus(),
        bridge.getOpenSessions(),
      ]);
      set({
        desktop,
        webuiStatus,
        ...(openSessionsRevision === initialOpenSessionsRevision
          ? {
              openSessions: new Map(
                openSessionSnapshots.map((snapshot) => [
                  snapshot.runtimeId,
                  snapshot.sessions.map((session) => ({
                    ...session,
                    runtimeId: snapshot.runtimeId,
                  })),
                ]),
              ),
            }
          : {}),
      });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  })();

  return () => {
    offState();
    offWebui();
    offOpenSessions();
    offSidebar();
  };
}
