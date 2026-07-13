/**
 * WrongStack Desktop - Electron Application Entry Point
 *
 * Architecture:
 * - Main state is managed here (centralized for simplicity)
 * - Modules handle specific concerns:
 *   - layout/     → Window layout and sizing
 *   - menu/       → Application menu building
 *   - ipc-handlers/ → IPC message handlers
 *   - runtime/    → Project/runtime operations
 *   - state/      → Types and constants
 */
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { wstackGlobalRoot } from '@wrongstack/core/utils';
import {
  app,
  BaseWindow,
  dialog,
  ipcMain,
  screen,
  shell,
  WebContentsView,
  type BaseWindowConstructorOptions,
} from 'electron';
import type {
  DesktopWebuiCommand,
  DesktopWebuiPrefs,
  DesktopWebuiStatusSnapshot,
  DesktopWindowState,
} from '../shared/types.js';
import { DesktopAgentBridge } from './agent-bridge.js';
import { IPC } from './ipc.js';
import { getMainLocale, setMainLocale, tMain } from './i18n-main.js';
import { desktopConfigPaths, readUiLocale, writeUiLocale } from './desktop-config-io.js';
import {
  DesktopRuntimeManager,
  preloadPath,
  rendererIndexPath,
  webuiPreloadPath,
  desktopSettingsWorkspaceRoot,
} from './runtime-manager.js';
import { watchProviderConfig } from '@wrongstack/core/storage';
import {
  buildWebuiCommandFallbackScript,
  normalizeDesktopWebuiCommand,
} from './webui-command-bridge.js';

// Layout module
import { getSidebarWidth } from './layout/index.js';

// Menu module
import { configureApplicationMenu as buildMenu } from './menu/index.js';
import type { MenuBuilderContext } from './menu/types.js';

// Constants
const OPEN_EXTERNAL_ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);
const MIN_WINDOW_WIDTH = 760;
const MIN_WINDOW_HEIGHT = 520;
const MAX_PENDING_WEBUI_COMMANDS = 50;
const MAX_PENDING_FLUSH_ATTEMPTS = 80;
const WEBUI_COMMAND_FALLBACK_MS = 350;
const WEBUI_COMMAND_ACK_TIMEOUT_MS = 2_000;
// Mutter/Wayland can fire 60+ resize events per second during a
// single drag — every event triggers a full layoutViews() pass
// (two setBounds calls per WebContentsView). Debounce to a 30 fps
// ceiling (33 ms) so we only re-layout ~30 times/sec max.
const LAYOUT_DEBOUNCE_MS = 33;

app.setAppUserModelId('com.wrongstack.desktop');
app.setPath('userData', path.join(wstackGlobalRoot(), 'desktop', 'electron-profile'));

// ── Wayland support (Fedora 43 / Mutter) ────────────────────────
// Electron on Linux defaults to XWayland, which causes rendering
// glitches, HiDPI scaling issues, and resize flicker under Mutter.
// 'auto' prefers native Wayland when available, falls back to X11
// gracefully (headless, SSH, older desktops). Wayland support in
// Electron requires chromium >= 125 (Electron 31+); we target 43.
app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
// Mutter's compositor vsync and Electron's in-process GPU
// compositing interact poorly with resize/layout loops. Disabling
// hardware acceleration on Linux avoids visual tearing without
// meaningfully impacting performance (the app's view layer is DOM,
// not WebGL). A user can override with --enable-gpu if desired.
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('disable-gpu');
}

// ============================================================================
// Application State
// ============================================================================

const manager = new DesktopRuntimeManager();
const bridge = new DesktopAgentBridge();

interface DesktopWebuiRuntimeView {
  runtimeId: string;
  view: WebContentsView;
  url: string | null;
  status: DesktopWebuiStatusSnapshot;
  bridgeReady: boolean;
  attached: boolean;
  pendingCommands: DesktopWebuiCommand[];
  pendingFlushTimer: ReturnType<typeof setTimeout> | null;
  pendingFlushAttempts: number;
}

interface PendingWebuiCommandAck {
  runtimeId: string;
  timer: ReturnType<typeof setTimeout>;
  fallbackTimer: ReturnType<typeof setTimeout> | null;
  resolve: (handled: boolean) => void;
}

let mainWindow: BaseWindow | null = null;
let shellView: WebContentsView | null = null;
const webuiViews = new Map<string, DesktopWebuiRuntimeView>();
let activeWebuiRuntimeId: string | null = null;
let webuiStatus: DesktopWebuiStatusSnapshot = { runtimeId: null, status: 'idle' };
let webuiCommandSequence = 0;
let shellSidebarCollapsed = false;
const pendingWebuiCommandAcks = new Map<string, PendingWebuiCommandAck>();
let saveWindowStateTimer: ReturnType<typeof setTimeout> | null = null;
let layoutDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let quittingAfterCleanup = false;

// ============================================================================
// Utility Functions
// ============================================================================

function safeOpenExternal(target: string): void {
  let protocol: string;
  try {
    protocol = new URL(target).protocol;
  } catch {
    return;
  }
  if (OPEN_EXTERNAL_ALLOWED_PROTOCOLS.has(protocol)) {
    void shell.openExternal(target);
  }
}

function sameOrigin(candidate: string, base: string | null): boolean {
  if (!base) return false;
  try {
    return new URL(candidate).origin === new URL(base).origin;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function runtimeWsUrlOrThrow(runtimeId: string): string {
  const wsUrl = manager.getRuntimeWsUrlWithToken(runtimeId);
  if (!wsUrl) throw new Error(`Runtime not found: ${runtimeId}`);
  return wsUrl;
}

// ============================================================================
// State Helpers
// ============================================================================

function setShellSidebarCollapsed(collapsed: boolean): void {
  shellSidebarCollapsed = collapsed;
  layoutWebuiViews();
  configureApplicationMenu();
  if (!shellView || shellView.webContents.isDestroyed()) return;
  shellView.webContents.send(IPC.shellSidebarCollapsedChanged, shellSidebarCollapsed);
}

function menuRelevantPrefsChanged(
  previous: DesktopWebuiPrefs | undefined,
  next: DesktopWebuiPrefs | undefined,
): boolean {
  return (
    previous?.yolo !== next?.yolo ||
    previous?.nextPrediction !== next?.nextPrediction ||
    previous?.contextAutoCompact !== next?.contextAutoCompact
  );
}

function setEntryWebuiStatus(
  entry: DesktopWebuiRuntimeView,
  next: DesktopWebuiStatusSnapshot,
): void {
  const previousPrefs = entry.status.prefs;
  entry.status = {
    ...next,
    prefs: next.prefs ?? entry.status.prefs,
    pendingCommands: entry.pendingCommands.length || undefined,
  };
  if (activeWebuiRuntimeId === entry.runtimeId) {
    publishWebuiStatus(entry.status);
    if (menuRelevantPrefsChanged(previousPrefs, entry.status.prefs)) {
      configureApplicationMenu();
    }
  }
}

// ============================================================================
// Window State
// ============================================================================

function scheduleWindowStateSave(): void {
  if (saveWindowStateTimer) clearTimeout(saveWindowStateTimer);
  saveWindowStateTimer = setTimeout(() => {
    saveWindowStateTimer = null;
    void saveWindowState();
  }, 350);
}

async function saveWindowState(): Promise<void> {
  if (!mainWindow) return;
  const bounds = mainWindow.getNormalBounds();
  await manager.saveWindowState({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    maximized: mainWindow.isMaximized(),
  });
}

function validatedWindowState(state: DesktopWindowState | null): DesktopWindowState | null {
  if (!state) return null;
  if (state.width < MIN_WINDOW_WIDTH || state.height < MIN_WINDOW_HEIGHT) return null;
  if (state.x === undefined || state.y === undefined) return state;
  const candidate = {
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
  };
  const visibleOnSomeDisplay = screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    return rectanglesIntersect(candidate, area);
  });
  return visibleOnSomeDisplay ? state : null;
}

function rectanglesIntersect(
  left: { x: number; y: number; width: number; height: number },
  right: { x: number; y: number; width: number; height: number },
): boolean {
  return (
    left.x < right.x + right.width &&
    left.x + left.width > right.x &&
    left.y < right.y + right.height &&
    left.y + left.height > right.y
  );
}

// ============================================================================
// Layout Functions
// ============================================================================

function layoutViews(): void {
  if (!mainWindow || !shellView) return;
  const size = mainWindow.getContentSize();
  const width = size[0] ?? 0;
  const height = size[1] ?? 0;
  shellView.setBounds({ x: 0, y: 0, width, height });
  layoutWebuiViews();
}

function layoutWebuiViews(): void {
  if (!mainWindow) return;
  const size = mainWindow.getContentSize();
  const width = size[0] ?? 0;
  const height = size[1] ?? 0;
  const snapshot = manager.snapshot();
  const active = snapshot.runtimes.find((runtime) => runtime.id === snapshot.activeRuntimeId);
  const sidebarWidth = getSidebarWidth(width, shellSidebarCollapsed);
  const contentWidth = Math.max(0, width - sidebarWidth);

  for (const entry of webuiViews.values()) {
    const runtime = snapshot.runtimes.find((r) => r.id === entry.runtimeId);
    if (active?.id === entry.runtimeId && runtime?.status === 'running') {
      entry.view.setBounds({ x: sidebarWidth, y: 0, width: contentWidth, height });
    } else {
      entry.view.setBounds({ x: sidebarWidth, y: 0, width: 0, height });
    }
  }
}

// ============================================================================
// WebUI View Management
// ============================================================================

function ensureWebuiEntry(runtimeId: string): DesktopWebuiRuntimeView | null {
  if (!mainWindow) return null;
  const existing = webuiViews.get(runtimeId);
  if (existing) return existing;

  const view = new WebContentsView({
    webPreferences: {
      preload: webuiPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const entry: DesktopWebuiRuntimeView = {
    runtimeId,
    view,
    url: null,
    status: { runtimeId, status: 'idle' },
    bridgeReady: false,
    attached: false,
    pendingCommands: [],
    pendingFlushTimer: null,
    pendingFlushAttempts: 0,
  };

  view.webContents.setWindowOpenHandler(({ url }) => {
    safeOpenExternal(url);
    return { action: 'deny' };
  });

  view.webContents.on('will-navigate', (event, url) => {
    if (sameOrigin(url, entry.url)) return;
    event.preventDefault();
    safeOpenExternal(url);
  });

  view.webContents.on('did-start-loading', () => {
    if (webuiViews.get(runtimeId) !== entry) return;
    entry.bridgeReady = false;
    setEntryWebuiStatus(entry, { runtimeId, status: 'loading' });
  });

  view.webContents.on('did-finish-load', () => {
    if (webuiViews.get(runtimeId) !== entry) return;
    schedulePendingWebuiFlush(entry);
    try {
      entry.view.webContents.send(IPC.webuiLocaleChanged, getMainLocale());
    } catch {
      /* webui was destroyed mid-send */
    }
  });

  view.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    if (webuiViews.get(runtimeId) !== entry || errorCode === -3) return;
    setEntryWebuiStatus(entry, { runtimeId, status: 'error', error: errorDescription });
  });

  view.webContents.on('render-process-gone', (_event, details) => {
    if (webuiViews.get(runtimeId) !== entry) return;
    setEntryWebuiStatus(entry, {
      runtimeId,
      status: 'error',
      error: `WebUI renderer exited: ${details.reason}`,
    });
  });

  webuiViews.set(runtimeId, entry);
  return entry;
}

function attachWebuiEntry(entry: DesktopWebuiRuntimeView): void {
  if (!mainWindow) return;
  if (entry.attached) return;
  mainWindow.contentView.addChildView(entry.view);
  entry.attached = true;
}

function disposeWebuiEntry(entry: DesktopWebuiRuntimeView): void {
  webuiViews.delete(entry.runtimeId);
  entry.pendingCommands.length = 0;
  settlePendingWebuiCommandAcksForRuntime(entry.runtimeId, false);
  if (entry.pendingFlushTimer) {
    clearTimeout(entry.pendingFlushTimer);
    entry.pendingFlushTimer = null;
  }
  if (mainWindow && entry.attached) {
    mainWindow.contentView.removeChildView(entry.view);
  }
  entry.attached = false;
  if (!entry.view.webContents.isDestroyed()) {
    entry.view.webContents.close();
  }
  if (activeWebuiRuntimeId === entry.runtimeId) activeWebuiRuntimeId = null;
}

function disposeAllWebuiEntries(): void {
  for (const entry of Array.from(webuiViews.values())) {
    disposeWebuiEntry(entry);
  }
  webuiViews.clear();
}

function pruneWebuiEntries(runtimeIds: string[]): void {
  const live = new Set(runtimeIds);
  for (const [id, entry] of webuiViews) {
    if (!live.has(id)) {
      disposeWebuiEntry(entry);
    }
  }
}

function findWebuiEntryBySenderId(senderId: number): DesktopWebuiRuntimeView | undefined {
  return Array.from(webuiViews.values()).find(
    (candidate) => candidate.view.webContents.id === senderId,
  );
}

function syncActiveWebuiView(): void {
  if (!mainWindow) return;
  const snapshot = manager.snapshot();
  pruneWebuiEntries(
    snapshot.runtimes
      .filter((runtime) => runtime.status === 'running')
      .map((runtime) => runtime.id),
  );
  const active = snapshot.runtimes.find((runtime) => runtime.id === snapshot.activeRuntimeId);
  if (active?.status !== 'running') {
    activeWebuiRuntimeId = active?.id ?? null;
    publishWebuiStatus({ runtimeId: active?.id ?? null, status: 'idle' });
    layoutWebuiViews();
    return;
  }

  const url = manager.getRuntimeUrlWithToken(active.id);
  if (!url) {
    activeWebuiRuntimeId = active.id;
    publishWebuiStatus({ runtimeId: active.id, status: 'idle' });
    layoutWebuiViews();
    return;
  }
  const entry = ensureWebuiEntry(active.id);
  if (!entry) return;
  activeWebuiRuntimeId = active.id;
  attachWebuiEntry(entry);
  layoutWebuiViews();
  publishWebuiStatus(entry.status);
  if (entry.url !== url) {
    entry.url = url;
    entry.bridgeReady = false;
    setEntryWebuiStatus(entry, { runtimeId: active.id, status: 'loading' });
    void entry.view.webContents.loadURL(url).catch((err) => {
      setEntryWebuiStatus(entry, {
        runtimeId: active.id,
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'desktop.webui_view_load_failed',
          runtimeId: active.id,
          message: err instanceof Error ? err.message : String(err),
          timestamp: new Date().toISOString(),
        }),
      );
    });
  }
}

// ============================================================================
// State Broadcasting
// ============================================================================

function broadcastState(): void {
  if (!shellView || shellView.webContents.isDestroyed()) return;
  shellView.webContents.send(IPC.stateChanged, manager.snapshot());
}

function publishWebuiStatus(next: DesktopWebuiStatusSnapshot): void {
  webuiStatus = next;
  if (!shellView || shellView.webContents.isDestroyed()) return;
  shellView.webContents.send(IPC.webuiStatusChanged, webuiStatus);
}

function broadcastLocaleToEmbeddedWebuis(locale: string): void {
  for (const entry of webuiViews.values()) {
    if (entry.view.webContents.isDestroyed()) continue;
    try {
      entry.view.webContents.send(IPC.webuiLocaleChanged, locale);
    } catch {
      /* destroyed mid-send */
    }
  }
}

// ============================================================================
// WebUI Command Dispatch
// ============================================================================

function getActiveWebuiEntry(): DesktopWebuiRuntimeView | undefined {
  const activeId = manager.snapshot().activeRuntimeId;
  return activeId ? webuiViews.get(activeId) : undefined;
}

async function isWebuiCommandBridgeReady(entry: DesktopWebuiRuntimeView): Promise<boolean> {
  if (webuiViews.get(entry.runtimeId) !== entry || !entry.url) return false;
  return entry.bridgeReady;
}

function queueWebuiCommand(entry: DesktopWebuiRuntimeView, command: DesktopWebuiCommand): void {
  entry.pendingCommands.push(command);
  if (entry.pendingCommands.length > MAX_PENDING_WEBUI_COMMANDS) {
    entry.pendingCommands.splice(0, entry.pendingCommands.length - MAX_PENDING_WEBUI_COMMANDS);
  }
  entry.pendingFlushAttempts = 0;
  setEntryWebuiStatus(entry, entry.status);
}

function nextWebuiCommandRequestId(runtimeId: string): string {
  webuiCommandSequence += 1;
  return `${runtimeId}:${Date.now()}:${webuiCommandSequence}`;
}

async function dispatchWebuiCommand(commandInput: unknown): Promise<boolean> {
  const command = normalizeDesktopWebuiCommand(commandInput);
  if (!command) return false;
  const entry = getActiveWebuiEntry();
  if (!entry?.url) return false;

  if (entry.status.status !== 'ready') {
    if (!entry.view.webContents.isLoading() && entry.status.status !== 'error') {
      return dispatchWebuiCommandNow(entry, command);
    }
    queueWebuiCommand(entry, command);
    schedulePendingWebuiFlush(entry);
    return true;
  }

  if (!(await isWebuiCommandBridgeReady(entry))) {
    if (!entry.view.webContents.isLoading()) {
      return dispatchWebuiCommandNow(entry, command);
    }
    queueWebuiCommand(entry, command);
    schedulePendingWebuiFlush(entry);
    return true;
  }

  return dispatchWebuiCommandNow(entry, command);
}

async function reloadActiveWebuiView(): Promise<boolean> {
  const entry = getActiveWebuiEntry();
  if (!entry?.url) return false;
  entry.bridgeReady = false;
  setEntryWebuiStatus(entry, { runtimeId: entry.runtimeId, status: 'loading' });
  return entry.view.webContents
    .loadURL(entry.url)
    .then(() => true)
    .catch((err) => {
      setEntryWebuiStatus(entry, {
        runtimeId: entry.runtimeId,
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'desktop.webui_view_reload_failed',
          runtimeId: entry.runtimeId,
          message: err instanceof Error ? err.message : String(err),
          timestamp: new Date().toISOString(),
        }),
      );
      return false;
    });
}

async function dispatchWebuiCommandNow(
  entry: DesktopWebuiRuntimeView,
  command: DesktopWebuiCommand,
): Promise<boolean> {
  if (webuiViews.get(entry.runtimeId) !== entry || !entry.url) return false;
  const requestId = nextWebuiCommandRequestId(entry.runtimeId);
  const commandWithRequestId: DesktopWebuiCommand = { ...command, requestId };

  return new Promise<boolean>((resolve) => {
    const fallbackTimer = setTimeout(() => {
      const pending = pendingWebuiCommandAcks.get(requestId);
      if (!pending) return;
      sendWebuiCommandDomFallback(entry, commandWithRequestId);
    }, WEBUI_COMMAND_FALLBACK_MS);

    const timer = setTimeout(() => {
      settlePendingWebuiCommandAck(requestId, false);
    }, WEBUI_COMMAND_ACK_TIMEOUT_MS);

    pendingWebuiCommandAcks.set(requestId, {
      runtimeId: entry.runtimeId,
      timer,
      fallbackTimer,
      resolve,
    });

    try {
      entry.view.webContents.send(IPC.webuiCommand, commandWithRequestId);
      if (activeWebuiRuntimeId === entry.runtimeId) {
        entry.view.webContents.focus();
      }
    } catch {
      settlePendingWebuiCommandAck(requestId, false);
    }
  });
}

function sendWebuiCommandDomFallback(
  entry: DesktopWebuiRuntimeView,
  command: DesktopWebuiCommand,
): void {
  if (webuiViews.get(entry.runtimeId) !== entry || entry.view.webContents.isDestroyed()) return;
  void entry.view.webContents
    .executeJavaScript(buildWebuiCommandFallbackScript(command), true)
    .catch(() => undefined);
}

function settlePendingWebuiCommandAck(requestId: string, handled: boolean): void {
  const pending = pendingWebuiCommandAcks.get(requestId);
  if (!pending) return;
  pendingWebuiCommandAcks.delete(requestId);
  clearTimeout(pending.timer);
  if (pending.fallbackTimer) clearTimeout(pending.fallbackTimer);
  if (handled) {
    const entry = webuiViews.get(pending.runtimeId);
    if (entry) {
      entry.bridgeReady = true;
      setEntryWebuiStatus(entry, { ...entry.status, status: 'ready' });
    }
  }
  pending.resolve(handled);
}

function settlePendingWebuiCommandAcksForRuntime(runtimeId: string, handled: boolean): void {
  for (const [requestId, pending] of [...pendingWebuiCommandAcks]) {
    if (pending.runtimeId === runtimeId) {
      settlePendingWebuiCommandAck(requestId, handled);
    }
  }
}

async function flushPendingWebuiCommands(entry: DesktopWebuiRuntimeView): Promise<void> {
  if (webuiViews.get(entry.runtimeId) !== entry) return;
  if (entry.pendingCommands.length === 0) return;

  if (!(await isWebuiCommandBridgeReady(entry))) {
    entry.pendingFlushAttempts += 1;
    const canFallback = !entry.view.webContents.isLoading() && entry.pendingFlushAttempts >= 4;

    if (!canFallback && entry.pendingFlushAttempts <= MAX_PENDING_FLUSH_ATTEMPTS) {
      schedulePendingWebuiFlush(entry);
      setEntryWebuiStatus(entry, entry.status);
      return;
    }

    if (!canFallback) {
      entry.pendingCommands.length = 0;
      setEntryWebuiStatus(entry, {
        runtimeId: entry.runtimeId,
        status: 'error',
        error: 'WebUI command bridge did not become ready.',
      });
      return;
    }
  }

  entry.pendingFlushAttempts = 0;
  const commands = entry.pendingCommands.splice(0, entry.pendingCommands.length);
  setEntryWebuiStatus(entry, entry.status);

  for (const command of commands) {
    await dispatchWebuiCommandNow(entry, command).catch(() => undefined);
  }
}

function schedulePendingWebuiFlush(entry: DesktopWebuiRuntimeView): void {
  if (entry.pendingFlushTimer) return;
  entry.pendingFlushTimer = setTimeout(() => {
    entry.pendingFlushTimer = null;
    void flushPendingWebuiCommands(entry);
  }, 250);
}

// ============================================================================
// Project/Runtime Operations
// ============================================================================

async function openProject(
  requestedRoot?: string | undefined,
): Promise<ReturnType<DesktopRuntimeManager['snapshot']>> {
  let projectRoot = requestedRoot;
  if (!projectRoot) {
    const result = await dialog.showOpenDialog({
      title: tMain('openProject'),
      properties: ['openDirectory'],
    });
    projectRoot = result.filePaths[0];
  }
  if (!projectRoot) return manager.snapshot();
  await manager.openProject(projectRoot);
  syncActiveWebuiView();
  broadcastState();
  return manager.snapshot();
}

async function registerProject(
  requestedRoot?: string | undefined,
): Promise<ReturnType<DesktopRuntimeManager['snapshot']>> {
  let projectRoot = requestedRoot;
  if (!projectRoot) {
    const result = await dialog.showOpenDialog({
      title: tMain('registerProject'),
      properties: ['openDirectory'],
    });
    projectRoot = result.filePaths[0];
  }
  if (!projectRoot) return manager.snapshot();
  await manager.registerProject(projectRoot);
  broadcastState();
  return manager.snapshot();
}

async function unregisterProject(
  root: string,
): Promise<ReturnType<DesktopRuntimeManager['snapshot']>> {
  if (!root || typeof root !== 'string') return manager.snapshot();
  await manager.unregisterProject(root);
  broadcastState();
  return manager.snapshot();
}

async function openProjectSession(
  runtimeId?: string | undefined,
): Promise<ReturnType<DesktopRuntimeManager['snapshot']>> {
  const snapshot = manager.snapshot();
  const runtime =
    (runtimeId ? snapshot.runtimes.find((candidate) => candidate.id === runtimeId) : undefined) ??
    snapshot.runtimes.find((candidate) => candidate.id === snapshot.activeRuntimeId);
  if (runtime?.kind !== 'project') {
    return openProject();
  }
  await manager.openProject(runtime.root, { forceNew: true });
  syncActiveWebuiView();
  broadcastState();
  return manager.snapshot();
}

async function openSettings(): Promise<ReturnType<DesktopRuntimeManager['snapshot']>> {
  const snapshot = manager.snapshot();
  const active = snapshot.runtimes.find((runtime) => runtime.id === snapshot.activeRuntimeId);
  if (!active || active.kind === 'global-settings' || active.status !== 'running') {
    const root = desktopSettingsWorkspaceRoot();
    await fs.mkdir(root, { recursive: true });
    await manager.openProject(root, {
      name: 'Global Settings',
      kind: 'global-settings',
      touchRecent: false,
    });
    syncActiveWebuiView();
    broadcastState();
  }
  await dispatchWebuiCommand({ view: 'settings' });
  return manager.snapshot();
}

async function activateRuntime(
  id: string,
): Promise<ReturnType<DesktopRuntimeManager['snapshot']>> {
  await manager.activateRuntime(id);
  syncActiveWebuiView();
  broadcastState();
  return manager.snapshot();
}

async function closeRuntime(
  id: string,
): Promise<ReturnType<DesktopRuntimeManager['snapshot']>> {
  bridge.close(id);
  await manager.closeRuntime(id);
  const entry = webuiViews.get(id);
  if (entry) disposeWebuiEntry(entry);
  syncActiveWebuiView();
  broadcastState();
  return manager.snapshot();
}

async function restoreLastWorkspace(): Promise<void> {
  await manager.restoreLastWorkspace();
  syncActiveWebuiView();
  broadcastState();
}

// ============================================================================
// ============================================================================
// Menu Configuration (delegated to menu/ module)
// ============================================================================

/**
 * Create the menu context for building the application menu.
 * This context is passed to the menu/ module's configureApplicationMenu.
 */
function createMenuContext(): MenuBuilderContext {
  return {
    getSnapshot: () => manager.snapshot(),
    getActiveRuntime: () => {
      const snapshot = manager.snapshot();
      return snapshot.runtimes.find((r) => r.id === snapshot.activeRuntimeId);
    },
    getActiveWebuiPrefs: () => {
      const snapshot = manager.snapshot();
      if (!snapshot.activeRuntimeId) return undefined;
      return webuiViews.get(snapshot.activeRuntimeId)?.status.prefs;
    },
    getShellSidebarCollapsed: () => shellSidebarCollapsed,
    t: tMain,
    getRuntimeManager: () => manager,
    getWebuiViews: () => webuiViews,
    dispatchWebuiCommand,
    reloadActiveWebuiView,
    activateRuntime: async (id) => { await activateRuntime(id); },
    openProject: async () => { await openProject(); },
    registerProject: async () => { await registerProject(); },
    openSettings: async () => { await openSettings(); },
    openProjectSession: async (id) => { await openProjectSession(id); },
    closeRuntime: async (id) => { await closeRuntime(id); },
    unregisterProject: async (root) => { await unregisterProject(root); },
    getActiveRuntimeId: () => activeWebuiRuntimeId,
    setShellSidebarCollapsed: (collapsed) => { setShellSidebarCollapsed(collapsed); },
    restoreLastWorkspace: async () => { await restoreLastWorkspace(); },
    openExternal: (url) => { shell.openExternal(url); },
    revealInExplorer: (root) => { void shell.openPath(root); },
  };
}

/**
 * Configure the application menu using the menu module.
 */
function configureApplicationMenu(): void {
  buildMenu(createMenuContext());
}

// ============================================================================
// IPC Handlers
// ============================================================================

function registerIpcHandlers(): void {
  ipcMain.handle(IPC.getState, () => manager.snapshot());
  ipcMain.handle(IPC.getConversation, (_event, runtimeId: string) =>
    bridge.snapshot(runtimeId),
  );
  ipcMain.handle(IPC.getWebuiStatus, () => webuiStatus);

  ipcMain.handle(IPC.navigateWebui, async (_event, command: unknown) =>
    dispatchWebuiCommand(command),
  );
  ipcMain.handle(IPC.reloadWebui, async () => reloadActiveWebuiView());

  ipcMain.handle(IPC.setShellSidebarCollapsed, (_event, collapsed: unknown) => {
    setShellSidebarCollapsed(collapsed === true);
    return true;
  });
  ipcMain.handle(IPC.openSettings, async () => openSettings());

  ipcMain.handle(IPC.openProjectSession, async (_event, runtimeId?: string | undefined) =>
    openProjectSession(runtimeId),
  );
  ipcMain.handle(IPC.openProject, async (_event, requestedRoot?: string | undefined) =>
    openProject(requestedRoot),
  );
  ipcMain.handle(IPC.registerProject, async (_event, requestedRoot?: string | undefined) =>
    registerProject(requestedRoot),
  );
  ipcMain.handle(IPC.unregisterProject, async (_event, root: string) => unregisterProject(root));

  ipcMain.handle(IPC.activateRuntime, async (_event, id: string) => activateRuntime(id));
  ipcMain.handle(IPC.closeRuntime, async (_event, id: string) => closeRuntime(id));
  ipcMain.handle(IPC.sendMessage, async (_event, id: string, content: string) =>
    bridge.sendMessage(id, runtimeWsUrlOrThrow(id), content),
  );
  ipcMain.handle(IPC.abortRuntime, async (_event, id: string) =>
    bridge.abort(id, runtimeWsUrlOrThrow(id)),
  );
  ipcMain.handle(IPC.openRuntimeInBrowser, async (_event, id: string) => {
    const url = manager.getRuntimeUrlWithToken(id);
    if (url) safeOpenExternal(url);
  });
  ipcMain.handle(IPC.revealRuntimeRoot, async (_event, id: string) => {
    const runtime = manager.getRuntime(id);
    if (runtime) void shell.openPath(runtime.root);
  });

  ipcMain.on(IPC.webuiReadyChanged, (event, ready: boolean) => {
    const entry = findWebuiEntryBySenderId(event.sender.id);
    if (!entry) return;
    entry.bridgeReady = ready === true;
    if (entry.bridgeReady) {
      setEntryWebuiStatus(entry, { ...entry.status, status: 'ready' });
      schedulePendingWebuiFlush(entry);
    } else if (entry.status.status === 'ready') {
      setEntryWebuiStatus(entry, { ...entry.status, status: 'loading' });
    }
  });

  ipcMain.on(IPC.webuiPrefsChanged, (event, prefs: unknown) => {
    const entry = findWebuiEntryBySenderId(event.sender.id);
    if (!entry) return;
    const next: DesktopWebuiPrefs = {};
    if (isRecord(prefs) && typeof prefs['yolo'] === 'boolean') next.yolo = prefs['yolo'];
    if (isRecord(prefs) && typeof prefs['nextPrediction'] === 'boolean') {
      next.nextPrediction = prefs['nextPrediction'];
    }
    if (isRecord(prefs) && typeof prefs['contextAutoCompact'] === 'boolean') {
      next.contextAutoCompact = prefs['contextAutoCompact'];
    }
    if (Object.keys(next).length === 0) return;
    setEntryWebuiStatus(entry, {
      ...entry.status,
      prefs: { ...(entry.status.prefs ?? {}), ...next },
    });
  });

  ipcMain.on(
    IPC.webuiCommandAck,
    (event, requestId: unknown, handled: unknown, _message?: unknown) => {
      const entry = findWebuiEntryBySenderId(event.sender.id);
      if (!entry || typeof requestId !== 'string') return;
      const pending = pendingWebuiCommandAcks.get(requestId);
      if (!pending || pending.runtimeId !== entry.runtimeId) return;
      settlePendingWebuiCommandAck(requestId, handled === true);
    },
  );

  ipcMain.on(IPC.setLocale, (_event, locale: string) => {
    setMainLocale(locale);
    configureApplicationMenu();
    broadcastLocaleToEmbeddedWebuis(locale);
    void writeUiLocale(locale);
  });
}

// ============================================================================
// Boot Sequence
// ============================================================================

async function boot(): Promise<void> {
  const locale = await readUiLocale();
  if (locale) setMainLocale(locale);

  const shellUrl = rendererIndexPath();
  shellView = new WebContentsView({
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  shellView.webContents.setWindowOpenHandler(({ url }) => {
    safeOpenExternal(url);
    return { action: 'deny' };
  });

  // The shell preload can invoke desktop:* channels during renderer startup.
  registerIpcHandlers();

  await shellView.webContents.loadURL(shellUrl);

  const prevState = validatedWindowState(manager.getWindowState());
  const defaultWidth = 1180;
  const defaultHeight = 720;

  const winOptions: BaseWindowConstructorOptions = {
    width: prevState?.width ?? defaultWidth,
    height: prevState?.height ?? defaultHeight,
    show: false,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    title: tMain('windowTitle'),
  };
  if (prevState) {
    if (prevState.x !== undefined) winOptions.x = prevState.x;
    if (prevState.y !== undefined) winOptions.y = prevState.y;
  }

  mainWindow = new BaseWindow(winOptions);
  mainWindow.on('resized', scheduleWindowStateSave);
  mainWindow.on('moved', scheduleWindowStateSave);
  mainWindow.on('maximize', scheduleWindowStateSave);
  mainWindow.on('unmaximize', scheduleWindowStateSave);

  if (prevState?.maximized) {
    mainWindow.maximize();
  }

  mainWindow.contentView.addChildView(shellView);
  layoutViews();

  configureApplicationMenu();

  mainWindow.on('resize', () => {
    if (layoutDebounceTimer) return;
    layoutDebounceTimer = setTimeout(() => {
      layoutDebounceTimer = null;
      layoutViews();
    }, LAYOUT_DEBOUNCE_MS);
  });

  bridge.on('changed', (conversation) => {
    if (!shellView || shellView.webContents.isDestroyed()) return;
    shellView.webContents.send(IPC.conversationChanged, conversation);
  });

  manager.on('changed', () => {
    syncActiveWebuiView();
    configureApplicationMenu();
    broadcastState();
  });

  let lastWatchedLocale: string | undefined;
  watchProviderConfig(
    desktopConfigPaths.globalConfigPath,
    desktopConfigPaths.vault,
    (snapshot) => {
      const updated = snapshot.uiLocale;
      if (!updated || updated === lastWatchedLocale) return;
      lastWatchedLocale = updated;
      setMainLocale(updated);
      configureApplicationMenu();
      broadcastLocaleToEmbeddedWebuis(updated);
      if (shellView && !shellView.webContents.isDestroyed()) {
        shellView.webContents.send(IPC.localeChanged, updated);
      }
    },
  );

  mainWindow.on('close', (event) => {
    if (quittingAfterCleanup) return;
    event.preventDefault();
    bridge.closeAll();
    disposeAllWebuiEntries();
    void saveWindowState();
    quittingAfterCleanup = true;
    app.exit(0);
  });

  await restoreLastWorkspace();

  mainWindow.show();
  shellView.webContents.focus();
}

// ============================================================================
// App Lifecycle
// ============================================================================

app.whenReady().then(boot);

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  if (mainWindow) {
    mainWindow.removeAllListeners('close');
    void saveWindowState();
  }
  bridge.closeAll();
  disposeAllWebuiEntries();
});

app.on('activate', () => {
  if (!mainWindow) return;
  mainWindow.show();
  shellView?.webContents.focus();
});
