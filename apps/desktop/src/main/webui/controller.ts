import type { TrustBoundary } from '@wrongstack/core/security';
import { shell, WebContentsView, type BaseWindow } from 'electron';
import type {
  DesktopWebuiCommand,
  DesktopWebuiPrefs,
  DesktopWebuiStatusSnapshot,
} from '../../shared/types.js';
import { authorizeDesktopAction } from '../desktop-privileged-actions.js';
import { IPC } from '../ipc.js';
import type { DesktopRuntimeManager } from '../runtime-manager.js';
import { webuiPreloadPath } from '../runtime-manager.js';
import {
  MAX_PENDING_FLUSH_ATTEMPTS,
  MAX_PENDING_WEBUI_COMMANDS,
  WEBUI_COMMAND_ACK_TIMEOUT_MS,
  WEBUI_COMMAND_FALLBACK_MS,
} from '../state/constants.js';
import type { DesktopWebuiRuntimeView, PendingWebuiCommandAck } from '../state/types.js';
import {
  buildWebuiCommandFallbackScript,
  normalizeDesktopWebuiCommand,
} from '../webui-command-bridge.js';
import { allowedExternalProtocol, sameOrigin } from './navigation.js';

export interface DesktopWebuiControllerContext {
  manager: DesktopRuntimeManager;
  trustBoundary: TrustBoundary;
  getMainWindow: () => BaseWindow | null;
  getShellView: () => WebContentsView | null;
  getLocale: () => string;
  layoutViews: () => void;
  onPrefsChanged?:
    | ((previous: DesktopWebuiPrefs | undefined, next: DesktopWebuiPrefs | undefined) => void)
    | undefined;
}

/** Instance-owned lifecycle and command authority for embedded WebUI views. */
export class DesktopWebuiController {
  readonly views = new Map<string, DesktopWebuiRuntimeView>();
  readonly pendingAcks = new Map<string, PendingWebuiCommandAck>();
  activeRuntimeId: string | null = null;
  status: DesktopWebuiStatusSnapshot = { runtimeId: null, status: 'idle' };
  private commandSequence = 0;

  constructor(private readonly ctx: DesktopWebuiControllerContext) {}

  private openExternal(target: string): void {
    const protocol = allowedExternalProtocol(target);
    if (!protocol) return;
    void authorizeDesktopAction(this.ctx.trustBoundary, {
      capability: 'url.open-external',
      subject: { kind: 'url', id: target, attributes: { protocol } },
      risk: 'elevated',
      metadata: { operation: 'webui-navigation' },
    })
      .then((decision) => (decision.allowed ? void shell.openExternal(target) : undefined))
      .catch(() => undefined);
  }

  private publishStatus(next: DesktopWebuiStatusSnapshot): void {
    this.status = next;
    const shellView = this.ctx.getShellView();
    if (!shellView || shellView.webContents.isDestroyed()) return;
    shellView.webContents.send(IPC.webuiStatusChanged, next);
  }

  setEntryStatus(entry: DesktopWebuiRuntimeView, next: DesktopWebuiStatusSnapshot): void {
    const previousPrefs = entry.status.prefs;
    entry.status = {
      ...next,
      ...(next.prefs === undefined && previousPrefs !== undefined ? { prefs: previousPrefs } : {}),
      // `pendingCommands` is always derived from the entry's own array (source of truth).
      // Any `next.pendingCommands` value is intentionally overwritten.
      pendingCommands: entry.pendingCommands.length,
    };
    if (this.activeRuntimeId === entry.runtimeId) {
      this.publishStatus(entry.status);
      this.ctx.onPrefsChanged?.(previousPrefs, entry.status.prefs);
    }
  }

  ensure(runtimeId: string): DesktopWebuiRuntimeView | null {
    const mainWindow = this.ctx.getMainWindow();
    if (!mainWindow) return null;
    const existing = this.views.get(runtimeId);
    if (existing) return existing;
    const view = new WebContentsView({
      webPreferences: {
        preload: webuiPreloadPath(),
        contextIsolation: true,
        nodeIntegration: false,
        // This is the view that renders agent output, tool results, file
        // contents, and fetched pages — i.e. the most attacker-influenceable
        // surface in the app, and the one that most needs process-level
        // containment rather than only bridge-level. webui-preload.ts imports
        // just electron's contextBridge/ipcRenderer and a constants map, so it
        // is already within the sandboxed preload subset (WS-093).
        sandbox: true,
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
      this.openExternal(url);
      return { action: 'deny' };
    });
    view.webContents.on('will-navigate', (event, url) => {
      if (sameOrigin(url, entry.url)) return;
      event.preventDefault();
      this.openExternal(url);
    });
    view.webContents.on('did-start-loading', () => {
      if (this.views.get(runtimeId) !== entry) return;
      entry.bridgeReady = false;
      this.setEntryStatus(entry, { runtimeId, status: 'loading' });
    });
    view.webContents.on('did-finish-load', () => {
      if (this.views.get(runtimeId) !== entry) return;
      this.scheduleFlush(entry);
      try {
        entry.view.webContents.send(IPC.webuiLocaleChanged, this.ctx.getLocale());
      } catch {}
    });
    view.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
      if (this.views.get(runtimeId) !== entry || errorCode === -3) return;
      this.setEntryStatus(entry, { runtimeId, status: 'error', error: errorDescription });
    });
    view.webContents.on('render-process-gone', (_event, details) => {
      if (this.views.get(runtimeId) !== entry) return;
      this.setEntryStatus(entry, {
        runtimeId,
        status: 'error',
        error: `WebUI renderer exited: ${details.reason}`,
      });
    });
    this.views.set(runtimeId, entry);
    return entry;
  }

  attach(entry: DesktopWebuiRuntimeView): void {
    const mainWindow = this.ctx.getMainWindow();
    if (!mainWindow || entry.attached) return;
    mainWindow.contentView.addChildView(entry.view);
    entry.attached = true;
  }

  dispose(entry: DesktopWebuiRuntimeView): void {
    this.views.delete(entry.runtimeId);
    entry.pendingCommands.length = 0;
    this.settleRuntimeAcks(entry.runtimeId, false);
    if (entry.pendingFlushTimer) clearTimeout(entry.pendingFlushTimer);
    entry.pendingFlushTimer = null;
    const mainWindow = this.ctx.getMainWindow();
    if (mainWindow && entry.attached) mainWindow.contentView.removeChildView(entry.view);
    entry.attached = false;
    if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close();
    if (this.activeRuntimeId === entry.runtimeId) this.activeRuntimeId = null;
  }

  disposeAll(): void {
    for (const entry of [...this.views.values()]) this.dispose(entry);
  }

  findBySenderId(senderId: number): DesktopWebuiRuntimeView | undefined {
    return [...this.views.values()].find((entry) => entry.view.webContents.id === senderId);
  }

  syncActive(): void {
    if (!this.ctx.getMainWindow()) return;
    const snapshot = this.ctx.manager.snapshot();
    const live = new Set(snapshot.runtimes.filter((r) => r.status === 'running').map((r) => r.id));
    for (const [id, entry] of this.views) if (!live.has(id)) this.dispose(entry);
    const active = snapshot.runtimes.find((runtime) => runtime.id === snapshot.activeRuntimeId);
    if (active?.status !== 'running') {
      this.activeRuntimeId = active?.id ?? null;
      this.publishStatus({ runtimeId: active?.id ?? null, status: 'idle' });
      this.ctx.layoutViews();
      return;
    }
    const url = this.ctx.manager.getRuntimeUrlWithToken(active.id);
    if (!url) {
      this.activeRuntimeId = active.id;
      this.publishStatus({ runtimeId: active.id, status: 'idle' });
      this.ctx.layoutViews();
      return;
    }
    const entry = this.ensure(active.id);
    if (!entry) return;
    this.activeRuntimeId = active.id;
    this.attach(entry);
    this.ctx.layoutViews();
    this.publishStatus(entry.status);
    if (entry.url === url) return;
    entry.url = url;
    entry.bridgeReady = false;
    this.setEntryStatus(entry, { runtimeId: active.id, status: 'loading' });
    void entry.view.webContents.loadURL(url).catch((error) => {
      this.setEntryStatus(entry, {
        runtimeId: active.id,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  broadcastLocale(locale: string): void {
    for (const entry of this.views.values()) {
      if (!entry.view.webContents.isDestroyed())
        entry.view.webContents.send(IPC.webuiLocaleChanged, locale);
    }
  }

  private activeEntry(): DesktopWebuiRuntimeView | undefined {
    const id = this.ctx.manager.snapshot().activeRuntimeId;
    return id ? this.views.get(id) : undefined;
  }

  async dispatch(commandInput: unknown): Promise<boolean> {
    const command = normalizeDesktopWebuiCommand(commandInput);
    if (!command) return false;
    const entry = this.activeEntry();
    if (!entry?.url) return false;
    if (entry.status.status !== 'ready' || !entry.bridgeReady) {
      if (!entry.view.webContents.isLoading() && entry.status.status !== 'error')
        return this.dispatchNow(entry, command);
      this.queue(entry, command);
      this.scheduleFlush(entry);
      return true;
    }
    return this.dispatchNow(entry, command);
  }

  async reload(): Promise<boolean> {
    const entry = this.activeEntry();
    if (!entry?.url) return false;
    entry.bridgeReady = false;
    this.setEntryStatus(entry, { runtimeId: entry.runtimeId, status: 'loading' });
    return entry.view.webContents
      .loadURL(entry.url)
      .then(() => true)
      .catch((error) => {
        this.setEntryStatus(entry, {
          runtimeId: entry.runtimeId,
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      });
  }

  private queue(entry: DesktopWebuiRuntimeView, command: DesktopWebuiCommand): void {
    entry.pendingCommands.push(command);
    if (entry.pendingCommands.length > MAX_PENDING_WEBUI_COMMANDS)
      entry.pendingCommands.splice(0, entry.pendingCommands.length - MAX_PENDING_WEBUI_COMMANDS);
    entry.pendingFlushAttempts = 0;
    this.setEntryStatus(entry, entry.status);
  }

  private dispatchNow(
    entry: DesktopWebuiRuntimeView,
    command: DesktopWebuiCommand,
  ): Promise<boolean> {
    if (this.views.get(entry.runtimeId) !== entry || !entry.url) return Promise.resolve(false);
    const requestId = `${entry.runtimeId}:${Date.now()}:${++this.commandSequence}`;
    const outbound = { ...command, requestId };
    return new Promise<boolean>((resolve) => {
      const fallbackTimer = setTimeout(() => {
        if (!this.pendingAcks.has(requestId)) return;
        if (this.views.get(entry.runtimeId) !== entry || entry.view.webContents.isDestroyed())
          return;
        void entry.view.webContents
          .executeJavaScript(buildWebuiCommandFallbackScript(outbound), true)
          .catch(() => undefined);
      }, WEBUI_COMMAND_FALLBACK_MS);
      const timer = setTimeout(
        () => this.settleAck(requestId, false),
        WEBUI_COMMAND_ACK_TIMEOUT_MS,
      );
      this.pendingAcks.set(requestId, {
        runtimeId: entry.runtimeId,
        timer,
        fallbackTimer,
        resolve,
      });
      try {
        entry.view.webContents.send(IPC.webuiCommand, outbound);
        if (this.activeRuntimeId === entry.runtimeId) entry.view.webContents.focus();
      } catch {
        this.settleAck(requestId, false);
      }
    });
  }

  settleAck(requestId: string, handled: boolean): void {
    const pending = this.pendingAcks.get(requestId);
    if (!pending) return;
    this.pendingAcks.delete(requestId);
    clearTimeout(pending.timer);
    if (pending.fallbackTimer) clearTimeout(pending.fallbackTimer);
    if (handled) {
      const entry = this.views.get(pending.runtimeId);
      if (entry) {
        entry.bridgeReady = true;
        this.setEntryStatus(entry, { ...entry.status, status: 'ready' });
      }
    }
    pending.resolve(handled);
  }

  private settleRuntimeAcks(runtimeId: string, handled: boolean): void {
    for (const [id, pending] of [...this.pendingAcks])
      if (pending.runtimeId === runtimeId) this.settleAck(id, handled);
  }

  scheduleFlush(entry: DesktopWebuiRuntimeView): void {
    if (entry.pendingFlushTimer) return;
    entry.pendingFlushTimer = setTimeout(() => {
      entry.pendingFlushTimer = null;
      void this.flush(entry);
    }, 250);
  }

  private async flush(entry: DesktopWebuiRuntimeView): Promise<void> {
    if (this.views.get(entry.runtimeId) !== entry || entry.pendingCommands.length === 0) return;
    if (!entry.bridgeReady) {
      entry.pendingFlushAttempts += 1;
      const shouldExecuteFallback =
        !entry.view.webContents.isLoading() && entry.pendingFlushAttempts >= 4;
      if (!shouldExecuteFallback && entry.pendingFlushAttempts <= MAX_PENDING_FLUSH_ATTEMPTS) {
        this.scheduleFlush(entry);
        this.setEntryStatus(entry, entry.status);
        return;
      }
      if (!shouldExecuteFallback) {
        entry.pendingCommands.length = 0;
        this.setEntryStatus(entry, {
          runtimeId: entry.runtimeId,
          status: 'error',
          error: 'WebUI command bridge did not become ready.',
        });
        return;
      }
    }
    entry.pendingFlushAttempts = 0;
    const commands = entry.pendingCommands.splice(0);
    this.setEntryStatus(entry, entry.status);
    for (const command of commands) await this.dispatchNow(entry, command).catch(() => undefined);
  }
}
