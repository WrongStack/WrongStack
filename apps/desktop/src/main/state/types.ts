/**
 * Shared state types for the desktop application.
 * These types are used across multiple modules to ensure type safety.
 */
import type {
  DesktopRuntimeRecord,
  DesktopWebuiCommand,
  DesktopWebuiPrefs,
  DesktopWebuiStatusSnapshot,
} from '../../shared/types.js';

// ============================================================================
// WebUI View State
// ============================================================================

export interface DesktopWebuiRuntimeView {
  runtimeId: string;
  view: import('electron').WebContentsView;
  url: string | null;
  status: DesktopWebuiStatusSnapshot;
  bridgeReady: boolean;
  attached: boolean;
  pendingCommands: DesktopWebuiCommand[];
  pendingFlushTimer: ReturnType<typeof setTimeout> | null;
  pendingFlushAttempts: number;
}

export interface PendingWebuiCommandAck {
  runtimeId: string;
  timer: ReturnType<typeof setTimeout>;
  fallbackTimer: ReturnType<typeof setTimeout> | null;
  resolve: (handled: boolean) => void;
}

// ============================================================================
// Application State
// ============================================================================

// ============================================================================
// Store Interfaces (for dependency injection)
// ============================================================================

export interface IRuntimeManager {
  snapshot(): import('../../shared/types.js').DesktopStateSnapshot;
  getRuntime(id: string): import('../../shared/types.js').DesktopRuntimeRecord | undefined;
  getRuntimeUrlWithToken(id: string): string | undefined;
  getRuntimeWsUrlWithToken(id: string): string | undefined;
  activateRuntime(id: string): Promise<void>;
  closeRuntime(id: string): Promise<void>;
  openProject(
    projectRoot: string,
    options?: {
      name?: string;
      kind?: import('../../shared/types.js').DesktopRuntimeKind;
      touchRecent?: boolean;
      forceNew?: boolean;
      runtimeId?: string;
    },
  ): Promise<DesktopRuntimeRecord>;
  registerProject(projectRoot: string): Promise<void>;
  unregisterProject(projectRoot: string): Promise<void>;
  openProjectSession(
    runtimeId?: string,
  ): Promise<import('../../shared/types.js').DesktopStateSnapshot>;
  saveWindowState(window: import('../../shared/types.js').DesktopWindowState): Promise<void>;
  restoreLastWorkspace(): Promise<void>;
  on(event: 'changed', listener: () => void): this;
}

export interface IAgentBridge {
  snapshot(runtimeId: string): import('../../shared/types.js').DesktopConversationSnapshot;
  sendMessage(
    runtimeId: string,
    wsUrl: string,
    content: string,
  ): Promise<import('../../shared/types.js').DesktopConversationSnapshot>;
  abort(
    runtimeId: string,
    wsUrl: string,
  ): Promise<import('../../shared/types.js').DesktopConversationSnapshot>;
  close(runtimeId: string): void;
  closeAll(): void;
  on(
    event: 'changed',
    listener: (conversation: import('../../shared/types.js').DesktopConversationSnapshot) => void,
  ): this;
}

interface IConfigIo {
  readUiLocale(): Promise<string | undefined>;
  writeUiLocale(code: string): Promise<void>;
  readonly desktopConfigPaths: {
    readonly bootstrapConfigPath: string;
    readonly profileConfigPath: string;
    readonly vault: import('@wrongstack/core/types').SecretVault;
  };
}

interface II18n {
  getMainLocale(): string;
  setMainLocale(locale: string): void;
  tMain(key: string): string;
}

// ============================================================================
// Event Handlers & Context
// ============================================================================

export interface IpcHandlerContext {
  getMainWindow(): import('electron').BaseWindow | null;
  getShellView(): import('electron').WebContentsView | null;
  getWebuiViews(): Map<string, DesktopWebuiRuntimeView>;
  getWebuiStatus(): DesktopWebuiStatusSnapshot;
  getRuntimeManager(): IRuntimeManager;
  getAgentBridge(): IAgentBridge;
  getI18n(): II18n;
  getConfigIo(): IConfigIo;
  getShellSidebarCollapsed(): boolean;
  setShellSidebarCollapsed(collapsed: boolean): void;
  broadcastState(): void;
  publishWebuiStatus(next: DesktopWebuiStatusSnapshot): void;
  syncActiveWebuiView(): void;
  configureApplicationMenu(): void;
  broadcastLocaleToEmbeddedWebuis(locale: string): void;
  dispatchWebuiCommand(command: unknown): Promise<boolean>;
  reloadActiveWebuiView(): Promise<boolean>;
  openProject(
    requestedRoot?: string,
  ): Promise<import('../../shared/types.js').DesktopStateSnapshot>;
  registerProject(
    requestedRoot?: string,
  ): Promise<import('../../shared/types.js').DesktopStateSnapshot>;
  unregisterProject(root: string): Promise<import('../../shared/types.js').DesktopStateSnapshot>;
  openProjectSession(
    runtimeId?: string,
  ): Promise<import('../../shared/types.js').DesktopStateSnapshot>;
  activateRuntime(id: string): Promise<import('../../shared/types.js').DesktopStateSnapshot>;
  closeRuntime(id: string): Promise<import('../../shared/types.js').DesktopStateSnapshot>;
  openSettings(): Promise<import('../../shared/types.js').DesktopStateSnapshot>;
  sendMessage(
    id: string,
    wsUrl: string,
    content: string,
  ): Promise<import('../../shared/types.js').DesktopConversationSnapshot>;
  abortRuntime(
    id: string,
    wsUrl: string,
  ): Promise<import('../../shared/types.js').DesktopConversationSnapshot>;
  openExternal(url: string): void;
  revealInExplorer(root: string): void;
  findWebuiEntryBySenderId(senderId: number): DesktopWebuiRuntimeView | undefined;
  getPendingWebuiCommandAcks(): Map<string, PendingWebuiCommandAck>;
  settlePendingWebuiCommandAck(requestId: string, handled: boolean): void;
  setEntryWebuiStatus(entry: DesktopWebuiRuntimeView, next: DesktopWebuiStatusSnapshot): void;
  schedulePendingWebuiFlush(entry: DesktopWebuiRuntimeView): void;
}

// ============================================================================
// Menu Context
// ============================================================================

export interface MenuBuilderContext {
  getSnapshot(): {
    runtimes: DesktopRuntimeRecord[];
    activeRuntimeId: string | null;
  };
  getActiveRuntime(): DesktopRuntimeRecord | undefined;
  getActiveWebuiPrefs(): DesktopWebuiPrefs | undefined;
  getShellSidebarCollapsed(): boolean;
  t(key: string): string;
  getRuntimeManager(): {
    getRuntimeUrlWithToken(id: string): string | undefined;
    getRuntime(id: string): DesktopRuntimeRecord | undefined;
  };
  getWebuiViews(): Map<string, { status: { prefs?: DesktopWebuiPrefs } }>;
  dispatchWebuiCommand(command: DesktopWebuiCommand): Promise<boolean>;
  reloadActiveWebuiView(): Promise<boolean>;
  activateRuntime(id: string): Promise<void>;
  openProject(): Promise<void>;
  registerProject(): Promise<void>;
  openSettings(): Promise<void>;
  openProjectSession(runtimeId?: string): Promise<void>;
  closeRuntime(id: string): Promise<void>;
  unregisterProject(root: string): Promise<void>;
  getActiveRuntimeId(): string | null;
  setShellSidebarCollapsed(collapsed: boolean): void;
  openExternal(url: string): void;
  revealInExplorer(root: string): void;
}
