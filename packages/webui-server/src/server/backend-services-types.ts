import type { Container, EventBus } from '@wrongstack/contracts/kernel';
import type {
  Compactor,
  Config,
  Logger,
  MemoryPort,
  ModelsRegistry,
  PermissionPolicy,
  Provider,
  ProviderConfig,
  SessionStore,
  SkillLoader,
  Tracer,
} from '@wrongstack/contracts/types';
import type {
  AgentFactory,
  BrainDecisionLedger,
  BrainMonitor,
  CollaborationBus,
  ObservableBrainArbiter,
} from '@wrongstack/coordination';
import type { Agent, AgentPipelines, Context } from '@wrongstack/core/agent';
import type {
  AutoCompactionMiddleware,
  BrainAutoRisk,
  BrainRuntime,
  ToolExecutor,
} from '@wrongstack/core/execution';
import type { DefaultTokenCounter } from '@wrongstack/core/infrastructure';
import type { DefaultModeStore } from '@wrongstack/core/models';
import type { ProviderRegistry, ToolRegistry } from '@wrongstack/core/registry';
import type { TrustBoundary } from '@wrongstack/core/security';
import type { SkillInstaller } from '@wrongstack/core/skills';
import type { AnnotationsStore, SessionReader } from '@wrongstack/core/storage';
import type { WstackPaths } from '@wrongstack/core/utils';
import type { MCPRegistry } from '@wrongstack/mcp';
import type { CollaborationWebSocketHandler } from './collaboration-ws-handler.js';
import type { GoalWebSocketHandler } from './goal-ws-handler.js';
import type { KanbanRunMirrorDeps } from './kanban-run-mirror.js';
import type { SddBoardWebSocketHandler } from './sdd-board-ws-handler.js';
import type { SddWizardWebSocketHandler } from './sdd-wizard-ws-handler.js';
import type { SpecsWebSocketHandler } from './specs-ws-handler.js';
import type { TerminalWebSocketHandler } from './terminal-ws-handler.js';
import type { WorktreeWebSocketHandler } from './worktree-ws-handler.js';

/** Session shape returned by `SessionStore.create()`. */
type Session = Awaited<ReturnType<SessionStore['create']>>;

export interface AgentServicesInput {
  trustBoundary: TrustBoundary;
  config: Config;
  /** The LIVE config (`config` is the boot snapshot); new session agents seed from it. */
  getConfig?: (() => Config) | undefined;
  wpaths: WstackPaths;
  logger: Logger;
  projectRoot: string;
  workingDir: string;
  /**
   * Sends a frame to every connected client. With it, Goal and SDD runs are mirrored into
   * project Kanban boards, as in the CLI-hosted WebUI.
   */
  broadcastToClients?: KanbanRunMirrorDeps['broadcast'] | undefined;
  /** Pre-context services (built in startWebUI with opts.services injection). */
  context: Context;
  provider: Provider;
  container: Container;
  toolRegistry: ToolRegistry;
  providerRegistry: ProviderRegistry;
  modelsRegistry: ModelsRegistry;
  events: EventBus;
  mcpRegistry: MCPRegistry;
  memoryStore: MemoryPort;
  modeStore: DefaultModeStore;
  customModeStore: import('./custom-context-modes.js').CustomModeStore;
  skillLoader: SkillLoader | undefined;
  skillInstaller: SkillInstaller | undefined;
  tokenCounter: DefaultTokenCounter;
  pipelines: AgentPipelines;
  /** Trusted host-only hook shared by the leader and light-subagent pipelines. */
  installToolBoundary?: ((pipelines: AgentPipelines) => void) | undefined;
  /** OTLP tracer (`observability.otlp`); every tab's agent shares it. */
  tracer?: Tracer | undefined;
  /** Mutable capabilities ref — the factory populates `.current`. */
  modelCapabilitiesRef: { current: unknown };
  /** Returns the LIVE session (swapped on /new + resume) — read at send time. */
  sessionGetter: () => Session;
  /** Read-only session reader (collab replay-on-join). */
  sessionReader: SessionReader;
  /**
   * True while `sessionId` has an in-flight run. Consulted before evicting a
   * session agent: the registry is capped at the tab limit, so without this a
   * fifth lookup would drop a tab that is mid-turn and strand its transcript.
   */
  isRunActive?: ((sessionId: string) => boolean) | undefined;
  /**
   * Is any connected surface still showing `sessionId`?
   *
   * Also consulted before eviction, and it decides WHICH agent goes. Insertion
   * order alone picks the oldest, which is routinely a tab the user still has
   * open, while the agent of a tab they closed minutes ago survives because it
   * was created later.
   */
  isDisplayed?: ((sessionId: string) => boolean) | undefined;
  /** Annotations store (collab notes). */
  annotationsStore: AnnotationsStore;
  /**
   * Persist the canonical `config.brain` to the GLOBAL config (serialized
   * behind startWebUI's config write lock). Absent = Brain edits are
   * live-only.
   */
  persistBrainConfig?:
    | ((config: import('@wrongstack/contracts/types').BrainConfig) => Promise<void>)
    | undefined;
}

export interface AgentServices {
  collabBus: CollaborationBus;
  compactor: Compactor;
  autoCompactor: AutoCompactionMiddleware | undefined;
  toolExecutor: ToolExecutor;
  agent: Agent;
  getAgent?: (sessionId?: string) => Agent;
  /**
   * The Agent for a session WITHOUT creating one. Read-only callers (status
   * logging, introspection, "can this host serve that id") must use this:
   * `getAgent` creates, so asking about a stale id materialised an agent and
   * could evict a live tab's.
   */
  peekAgent?: (sessionId?: string) => Agent | undefined;
  /** Conversations holding a live agent — see `WebuiDeps.sessionAgentIds`. */
  sessionAgentIds?: () => string[];
  /** Does this host already hold an open journal writer for that session? */
  isSessionLive?: (sessionId: string) => boolean;
  /** Drain every open tab's journal synchronously — fatal-exit salvage. */
  flushSessionJournalsSync?: () => void;
  /** End + close the journals of every tab that is not the leader's. */
  closeSessionJournals?: () => Promise<void>;
  permissionPolicy: PermissionPolicy;
  pipelines: AgentPipelines;
  brain: ObservableBrainArbiter;
  brainSettings: { maxAutoRisk: BrainAutoRisk };
  /** Live-editable Brain config owner (brain.config.get/set routes). */
  brainRuntime: BrainRuntime;
  brainLog: Array<{
    at: number;
    kind: string;
    question: string;
    outcome: string;
    sessionId?: string | undefined;
  }>;
  brainMonitor: BrainMonitor;
  /** LIVE persistent decision ledger (undefined when disabled). Read via the
   *  services object at shutdown — ledger toggles swap the instance. */
  brainLedger: BrainDecisionLedger | undefined;
  codebaseIndexing: { onFileWritten(filePath: string): void; dispose(): void };
  /**
   * Shared isolated-worker factory. Code Assist's `code.assist.*` routes build a
   * throwaway agent from it so an "Ask AI" run never creates or swaps a session.
   */
  subagentFactory: AgentFactory;
  goalHandler: GoalWebSocketHandler;
  specsHandler: SpecsWebSocketHandler;
  sddBoardHandler: SddBoardWebSocketHandler;
  sddWizardHandler: SddWizardWebSocketHandler;
  worktreeHandler: WorktreeWebSocketHandler;
  terminalHandler: TerminalWebSocketHandler;
  collabHandler: CollaborationWebSocketHandler;
  /** Release event subscriptions, timers, subprocesses and socket references
   * owned by the per-feature handlers. Idempotent handler disposers make this
   * safe during both signal shutdown and programmatic server restarts. */
  disposeRealtimeHandlers(): void;
  /**
   * Shared SAGE teardown: flush counters + throttled session-end hygiene
   * (full config surface). Same contract as CLI `setupSage` teardown.
   */
  runSageSessionHygiene(): Promise<void>;
  /** Refresh auto-compaction denominator on model switch. */
  updateAutoCompactionMaxContext: (
    newProvider: Provider,
    providerId?: string,
    providerCfg?: ProviderConfig | undefined,
  ) => Promise<void>;
}
