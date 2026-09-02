/**
 * Menu builder types and interfaces.
 */
import type {
  DesktopRuntimeRecord,
  DesktopWebuiCommand,
  DesktopWebuiPrefs,
} from '../../shared/types.js';

// ============================================================================
// Menu Action Callbacks
// ============================================================================

export interface ProjectMenuActions {
  activate(runtimeId: string): void;
  activateAndNavigate(runtimeId: string, command: DesktopWebuiCommand): void;
  newSession(runtimeId: string): void;
  openBrowser(runtimeId: string): void;
  reload(runtimeId: string): void;
  close(runtimeId: string): void;
  reveal(runtimeId: string): void;
  /** Register a project folder without opening it. */
  registerProject?(): void;
}

export interface ProjectMenuGroup {
  key: string;
  name: string;
  root: string;
  sessions: DesktopRuntimeRecord[];
}

// ============================================================================
// Menu Builder Context
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
  getWebuiViews(): Map<string, { status: { prefs?: DesktopWebuiPrefs | undefined } }>;
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
  restoreLastWorkspace(): Promise<void>;
  /** Open URL in external browser */
  openExternal(url: string): void;
  /** Reveal path in file explorer */
  revealInExplorer(root: string): void;
}
