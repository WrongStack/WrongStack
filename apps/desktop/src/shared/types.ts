export interface DesktopProjectEntry {
  name: string;
  root: string;
  slug: string;
  lastSeen?: string | undefined;
  createdAt?: string | undefined;
  lastWorkingDir?: string | undefined;
}

export type DesktopRuntimeStatus = 'starting' | 'running' | 'stopped' | 'error';
export type DesktopRuntimeKind = 'project' | 'global-settings';

export interface DesktopRuntimeRecord {
  id: string;
  name: string;
  root: string;
  slug: string;
  kind: DesktopRuntimeKind;
  status: DesktopRuntimeStatus;
  httpPort: number;
  wsPort: number;
  url: string;
  pid?: number | undefined;
  startedAt: string;
  error?: string | undefined;
  recentLogs?: string[] | undefined;
}

export interface DesktopWindowState {
  x?: number | undefined;
  y?: number | undefined;
  width: number;
  height: number;
  maximized?: boolean | undefined;
}

export interface DesktopStateSnapshot {
  activeRuntimeId: string | null;
  runtimes: DesktopRuntimeRecord[];
  recentProjects: DesktopProjectEntry[];
  registeredProjects: DesktopProjectEntry[];
  restoring: boolean;
}

export type DesktopConversationStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'running'
  | 'error';

export interface DesktopConversationMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  text: string;
  timestamp: number;
}

export interface DesktopConversationSnapshot {
  runtimeId: string;
  status: DesktopConversationStatus;
  sessionId?: string | undefined;
  error?: string | undefined;
  messages: DesktopConversationMessage[];
}

export type DesktopWebuiStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface DesktopWebuiStatusSnapshot {
  runtimeId: string | null;
  status: DesktopWebuiStatus;
  error?: string | undefined;
  pendingCommands?: number | undefined;
  prefs?: DesktopWebuiPrefs | undefined;
}

export interface DesktopWebuiPrefs {
  yolo?: boolean | undefined;
  nextPrediction?: boolean | undefined;
  contextAutoCompact?: boolean | undefined;
}

export interface WrongStackDesktopApi {
  getState(): Promise<DesktopStateSnapshot>;
  getConversation(runtimeId: string): Promise<DesktopConversationSnapshot>;
  getWebuiStatus(): Promise<DesktopWebuiStatusSnapshot>;
  openProject(root?: string): Promise<DesktopStateSnapshot>;
  registerProject(root?: string): Promise<DesktopStateSnapshot>;
  unregisterProject(root: string): Promise<DesktopStateSnapshot>;
  openProjectSession(runtimeId?: string | undefined): Promise<DesktopStateSnapshot>;
  activateRuntime(id: string): Promise<DesktopStateSnapshot>;
  closeRuntime(id: string): Promise<DesktopStateSnapshot>;
  navigateWebui(command: DesktopWebuiCommand): Promise<boolean>;
  reloadWebui(): Promise<boolean>;
  setShellSidebarCollapsed(collapsed: boolean): Promise<boolean>;
  openSettings(): Promise<DesktopStateSnapshot>;
  sendMessage(runtimeId: string, content: string): Promise<DesktopConversationSnapshot>;
  abortRuntime(runtimeId: string): Promise<DesktopConversationSnapshot>;
  openRuntimeInBrowser(id: string): Promise<void>;
  revealRuntimeRoot(id: string): Promise<void>;
  onStateChanged(cb: (state: DesktopStateSnapshot) => void): () => void;
  onConversationChanged(cb: (conversation: DesktopConversationSnapshot) => void): () => void;
  onWebuiStatusChanged(cb: (status: DesktopWebuiStatusSnapshot) => void): () => void;
  onShellSidebarCollapsedChanged(cb: (collapsed: boolean) => void): () => void;
  /** Push the renderer's display locale to the main process (app menu + dialogs). */
  setLocale(locale: string): void;
  /** Main → renderer: the shared config locale changed in another process. */
  onLocaleChanged(cb: (locale: string) => void): () => void;
}

export interface WrongStackDesktopHostApi {
  setReady(ready: boolean): void;
  setPrefs(prefs: DesktopWebuiPrefs): void;
  ackCommand(requestId: string, handled: boolean, message?: string | undefined): void;
  /**
   * Subscribe to locale changes pushed by the desktop shell (so the embedded
   * WebUI can swap i18n instantly when the user picks a language in the shell's
   * sidebar, without waiting for the config-file watcher → WS round-trip).
   * Returns an unsubscribe. No-op outside the desktop shell.
   */
  onLocaleChanged(cb: (locale: string) => void): () => void;
}

export interface WrongStackDesktopCommandApi {
  subscribe(cb: (command: DesktopWebuiCommand) => void): () => void;
}

export interface DesktopWebuiCommand {
  /** Internal Electron shell correlation id. Renderer-authored commands cannot set this. */
  requestId?: string | undefined;
  action?:
    | 'new-session'
    | 'clear-context'
    | 'compact-context'
    | 'repair-context'
    | 'download-chat'
    | 'focus-chat'
    | 'open-command-palette'
    | 'open-shortcuts'
    | 'search-chat'
    | 'open-model-switcher'
    | 'open-prompt-library'
    | undefined;
  view?:
    | 'chat'
    | 'settings'
    | 'goal'
    | 'sddhub'
    | 'files'
    | 'changes'
    | 'sessions'
    | 'setup'
    | 'skill'
    | 'roster'
    | 'mailbox'
    | 'debug'
    | 'design-gallery'
    | 'refresh-debug'
    | 'analytics'
    | undefined;
  activity?:
    | 'chat'
    | 'agents'
    | 'history'
    | 'files'
    | 'changes'
    | 'mailbox'
    | 'skills'
    | 'design'
    | undefined;
  overlay?: 'fleet' | 'agents-monitor' | 'processes' | 'queue' | undefined;
  dockSection?: 'goal' | 'fleet' | 'work' | 'worktrees' | 'collab' | undefined;
  workTab?: 'todos' | 'tasks' | 'plan' | undefined;
  terminal?: boolean | 'toggle' | 'new' | undefined;
  pref?:
    | {
        key: 'yolo' | 'nextPrediction' | 'contextAutoCompact';
        value?: boolean | undefined;
        toggle?: boolean | undefined;
      }
    | undefined;
}
