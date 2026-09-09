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
  DesktopSessionEntry,
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

/** Per-project session list, loaded when a project row is expanded. */
export interface SessionList {
  status: 'idle' | 'loading' | 'ready' | 'error';
  entries: DesktopSessionEntry[];
}

export interface ShellState {
  desktop: DesktopStateSnapshot;
  webuiStatus: DesktopWebuiStatusSnapshot;
  /** Project roots whose session list is expanded in the tree. */
  expanded: ReadonlySet<string>;
  /** Session lists keyed by project root. */
  sessions: ReadonlyMap<string, SessionList>;
  sidebarCollapsed: boolean;
  /** Free-text filter over the project tree. */
  filter: string;
  busy: boolean;
  error: string | null;
  launcher: LauncherFeedback | null;
}

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
  sessions: new Map(),
  sidebarCollapsed: false,
  filter: '',
  busy: false,
  error: null,
  launcher: null,
};

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
    sessions: new Map(),
    sidebarCollapsed: false,
    filter: '',
    busy: false,
    error: null,
    launcher: null,
  };
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
 * Expand or collapse a project's session list.
 *
 * Loading is driven from here rather than from an effect in the row: the row
 * unmounts while virtualised, and an effect would re-fetch every time it
 * scrolled back into view.
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
  void loadSessions(projectRoot);
}

export async function loadSessions(projectRoot: string, force = false): Promise<void> {
  const current = state.sessions.get(projectRoot);
  if (!force && (current?.status === 'loading' || current?.status === 'ready')) return;
  const loading = new Map(state.sessions);
  loading.set(projectRoot, { status: 'loading', entries: current?.entries ?? [] });
  set({ sessions: loading });
  try {
    const entries = await window.wrongstackDesktop.listProjectSessions(projectRoot);
    const ready = new Map(state.sessions);
    ready.set(projectRoot, { status: 'ready', entries });
    set({ sessions: ready });
  } catch {
    const failed = new Map(state.sessions);
    failed.set(projectRoot, { status: 'error', entries: [] });
    set({ sessions: failed });
  }
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
  const offState = bridge.onStateChanged((next) => {
    // The active project can change under us (restore, a runtime dying). Its
    // session list is loaded lazily and stays valid, so nothing to invalidate.
    set({ desktop: next });
  });
  const offWebui = bridge.onWebuiStatusChanged((next) => set({ webuiStatus: next }));
  const offSidebar = bridge.onShellSidebarCollapsedChanged((collapsed) =>
    set({ sidebarCollapsed: collapsed }),
  );

  void (async () => {
    try {
      const [desktop, webuiStatus] = await Promise.all([
        bridge.getState(),
        bridge.getWebuiStatus(),
      ]);
      set({ desktop, webuiStatus });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  })();

  return () => {
    offState();
    offWebui();
    offSidebar();
  };
}
