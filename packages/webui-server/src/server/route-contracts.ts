import type { Container, EventBus } from '@wrongstack/contracts/kernel';
import type {
  Compactor,
  Config,
  ConfigStore,
  Logger,
  MemoryPort,
  ModelsRegistry,
  PermissionPolicy,
  Provider,
  ProviderConfig,
  SecretVault,
  SessionStore,
  SkillLoader,
} from '@wrongstack/contracts/types';
import type { Agent, AgentPipelines, Context } from '@wrongstack/core/agent';
import type { AgentFactory, ObservableBrainArbiter } from '@wrongstack/core/coordination';
import type {
  AutoCompactionMiddleware,
  BrainAutoRisk,
  BrainRuntime,
} from '@wrongstack/core/execution';
import type { DefaultTokenCounter } from '@wrongstack/core/infrastructure';
import type { DefaultModeStore } from '@wrongstack/core/models';
import type { ProviderRegistry, ToolRegistry } from '@wrongstack/core/registry';
import type { SkillInstaller } from '@wrongstack/core/skills';
import type { MCPRegistry } from '@wrongstack/mcp';
import type { WebSocket, WebSocketServer } from 'ws';
import type { AutonomyRouteHandlers } from './autonomy-routes.js';
import type { BrainRouteHandlers } from './brain-routes.js';
import type { ChimeraRouteHandlers } from './chimera-routes.js';
import type { CodeAssistRouteHandlers } from './code-assist-routes.js';
import type { CollaborationWebSocketHandler } from './collaboration-ws-handler.js';
import type { CustomModeStore } from './custom-context-modes.js';
import type { GoalRouteHandlers } from './goal-routes.js';
import type { GoalWebSocketHandler } from './goal-ws-handler.js';
import type { MailboxRouteHandlers } from './mailbox-routes.js';
import type { McpRouteHandlers } from './mcp-routes.js';
import type { ModeRouteHandlers } from './mode-routes.js';
import type { PendingConfirm } from './pending-confirms.js';
import type { PrefsRouteHandlers } from './prefs-routes.js';
import type { ProjectRouteHandlers } from './project-routes.js';
import type { ProviderRouteHandlers } from './provider-routes.js';
import type { SddBoardRouteHandlers } from './sdd-board-routes.js';
import type { SddBoardWebSocketHandler } from './sdd-board-ws-handler.js';
import type { SddWizardRouteHandlers } from './sdd-wizard-routes.js';
import type { SddWizardWebSocketHandler } from './sdd-wizard-ws-handler.js';
import type { SessionRouteHandlers } from './session-routes.js';
import type { ShellGitRouteHandlers } from './shell-git-routes.js';
import type { SpecsRouteHandlers } from './specs-routes.js';
import type { SpecsWebSocketHandler } from './specs-ws-handler.js';
import type { SessionIdentityTarget } from './standalone-session-identity.js';
import type { TerminalWebSocketHandler } from './terminal-ws-handler.js';
import type { ConnectedClient } from './types.js';
import type { WorktreeWebSocketHandler } from './worktree-ws-handler.js';

type Session = Awaited<ReturnType<SessionStore['create']>>;

/**
 * Mutable session-scoped state. Handlers always read LIVE values through
 * these getters and write through setters — same closure semantics as
 * the original code captured by direct reference, but reachable through
 * an interface so the route construction can live outside `startWebUI`.
 */
export interface WebuiMutableState {
  getConfig(): Config;
  setConfig(next: Config): void;
  getProjectRoot(): string;
  setProjectRoot(next: string): void;
  getWorkingDir(): string;
  setWorkingDir(next: string): void;
  getSession(): Session;
  setSession(next: Session): void;
  getSessionStartedAt(): number;
  setSessionStartedAt(next: number): void;
  getSessionStore(): SessionStore;
  setSessionStore(next: SessionStore): void;
  getModeId(): string;
  setModeId(next: string): void;
  /** Snapshot of current model capabilities (refreshed on model switch). */
  getModelCapabilities(): unknown;
  getConfigWriteLock(): Promise<void>;
  setConfigWriteLock(next: Promise<void>): void;
  /**
   * Abort and clear any in-flight agent run. Routes shouldn't normally
   * touch runLock directly. The
   * refactor moves that into the projectHandlers setter chain so the
   * route layer just calls a single hook.
   */
  abortRunLock: (sessionId?: string) => void;
  /** True while `sessionId` (or any session, when omitted) owns a run lock. */
  isRunActive: (sessionId?: string) => boolean;
  /** Every session id with an in-flight run — one per busy WebUI tab. */
  getRunningSessionIds: () => string[];
  /**
   * Host-wide serialiser for session transitions. Shared by the session
   * handlers and the conversation ops so run setup never lands on a context
   * that a concurrent session swap is halfway through re-pointing.
   */
  withSessionTransition: <T>(operation: () => Promise<T>) => Promise<T>;
  /** Read-only reference to the live WS clients map. */
  getClients(): Map<WebSocket, ConnectedClient>;
}
/**
 * Services + WS-subsystem handlers, bootstrapped once. Immutable for
 * the duration of a session (the mutable ones live in `WebuiMutableState`).
 */
export interface WebuiDeps {
  trustBoundary: import('@wrongstack/core/security').TrustBoundary;
  agent: Agent;
  getAgent?: ((sessionId?: string) => Agent) | undefined;
  /**
   * The Agent for a session WITHOUT creating one. Read-only callers use this;
   * `getAgent` creates, so asking about a stale id materialises an agent for
   * it and can evict a live tab's.
   */
  peekAgent?: ((sessionId?: string) => Agent | undefined) | undefined;
  /**
   * Every conversation currently holding an agent.
   *
   * A project-wide provider rebuild (WrongProxy toggle, credential
   * hot-reload) used to swap `context.provider` and stop there. Session
   * contexts copy the root's provider REFERENCE when they are created, so
   * every tab opened before the toggle kept the old, unrouted provider while
   * the leader used the new one — four tabs, two different providers, no way
   * to tell from the UI. Hosts with one conversation omit this.
   */
  sessionAgentIds?: (() => string[]) | undefined;
  hasSession?: ((id: string) => boolean) | undefined;
  /** Does this host already hold an open journal writer for that session? */
  isSessionLive?: ((id: string) => boolean) | undefined;
  context: Context;
  container: Container;
  toolRegistry: ToolRegistry;
  modelsRegistry: ModelsRegistry;
  providerRegistry: ProviderRegistry;
  provider: Provider;
  mcpRegistry: MCPRegistry;
  vault: SecretVault;
  globalConfigPath: string;
  /** Active profile settings config; globalConfigPath is bootstrap metadata only. */
  profileConfigPath: string;
  /** Per-project layout — expose only the bits the route layer touches. */
  wpaths: { globalRoot: string; globalSkills: string; projectSessions: string };
  configStore: ConfigStore;
  tokenCounter: DefaultTokenCounter;
  permissionPolicy: PermissionPolicy;
  pendingConfirms: Map<string, PendingConfirm>;
  pipelines: AgentPipelines;
  logger: Logger;
  memoryStore: MemoryPort;
  modeStore: DefaultModeStore;
  skillLoader: SkillLoader | undefined;
  skillInstaller: SkillInstaller | undefined;
  customModeStore: CustomModeStore;
  compactor: Compactor;
  autoCompactor: AutoCompactionMiddleware | undefined;
  events: EventBus;
  wsHost: string;
  requireToken: boolean;
  publicUrl: string | undefined;
  publicWsUrl: string | undefined;
  wsPort: number;
  httpPort: number;
  wssPrimary: WebSocketServer;
  wssSecondary: WebSocketServer | null;
  /**
   * Shared isolated-worker factory. Consumed by the Code Assist routes so an
   * "Ask AI" run gets a throwaway agent instead of a new session.
   */
  subagentFactory: AgentFactory;
  /** Per-feature WS handlers (goal, specs, sdd-board, sdd-wizard, …). */
  goalHandler: GoalWebSocketHandler;
  specsHandler: SpecsWebSocketHandler;
  sddBoardHandler: SddBoardWebSocketHandler;
  sddWizardHandler: SddWizardWebSocketHandler;
  worktreeHandler: WorktreeWebSocketHandler;
  collabHandler: CollaborationWebSocketHandler;
  terminalHandler: TerminalWebSocketHandler;
  /** Brain monitoring + last-20 decision log. */
  brain: ObservableBrainArbiter;
  brainSettings: { maxAutoRisk: BrainAutoRisk };
  /** Live-editable Brain config owner (brain.config.get/set). */
  brainRuntime: BrainRuntime;
  brainLog: Array<{ at: number; kind: string; question: string; outcome: string }>;
}

/**
 * Closures the routes call back into `startWebUI` for. These weren't
 * worth lifting into `WebuiMutableState` because they need write access
 * to internals (config persistence, autofill, …) that only the boot
 * context has. The route layer treats them as opaque side-effects and
 * delegates without storing state of its own.
 */
export interface WebuiCallbacks {
  /**
   * Build a `session.start` payload. `overrides.sessionId` selects WHICH
   * session it describes — with four tabs live, the runtime's own "current"
   * session is not necessarily the one being reported on.
   */
  sessionStartPayload: (overrides?: Record<string, unknown>) => Promise<{
    sessionId: string;
    model: string;
    provider: string;
    maxContext: number;
    inputCost: number;
    outputCost: number;
    cacheReadCost: number;
    projectName: string;
    projectRoot: string;
    cwd: string;
    mode: string;
    contextMode: string;
  }>;
  /** Reserve an explicitly selected session before its writer is opened. */
  claimSession: (sessionId: string, target?: SessionIdentityTarget) => Promise<() => Promise<void>>;
  /** Rebind session-scoped todo persistence before a new todo snapshot is installed. */
  onBeforeSessionTodosReplaced: (sessionId: string, sessionsDir: string) => Promise<void>;
  /** Re-point registry and HQ identity after a writer swap. */
  onSessionSwapped: (sessionId: string, target?: SessionIdentityTarget) => Promise<void>;
  /** Re-build the AutoCompaction middleware denominator on model switch. */
  updateAutoCompactionMaxContext: (
    newProvider: Provider,
    providerId?: string,
    providerCfg?: ProviderConfig | undefined,
  ) => Promise<void>;
  /** Unified, serialized helper for active-profile config mutations. */
  updateGlobalConfig: (
    mutate: (config: Record<string, unknown>) => void,
    errorLabel: string,
  ) => Promise<void>;
  /** Persist the durable subset of context.meta prefs to config.json. */
  persistPrefsToConfig: (payload: Record<string, unknown>) => Promise<void>;
  /** Snapshot of every pref the standalone server exposes. */
  prefSnapshot: () => Record<string, unknown>;
}

export interface AllRoutes {
  providerRoutes: ProviderRouteHandlers;
  sessionRoutes: SessionRouteHandlers;
  projectRoutes: ProjectRouteHandlers;
  modeRoutes: ModeRouteHandlers;
  prefsRoutes: PrefsRouteHandlers;
  autonomyRoutes: AutonomyRouteHandlers;
  shellGitRoutes: ShellGitRouteHandlers;
  chimeraRoutes: ChimeraRouteHandlers;
  codeAssistRoutes: CodeAssistRouteHandlers;
  mailboxRoutes: MailboxRouteHandlers;
  mcpRoutes: McpRouteHandlers;
  brainRoutes: BrainRouteHandlers;
  goalRoutes: GoalRouteHandlers;
  specsRoutes: SpecsRouteHandlers;
  sddBoardRoutes: SddBoardRouteHandlers;
  sddWizardRoutes: SddWizardRouteHandlers;
}
