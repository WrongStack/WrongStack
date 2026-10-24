import type { Logger, MemoryPort } from '@wrongstack/contracts/types';
import type { Agent } from '@wrongstack/core/agent';
import type { ProviderModelStatusTracker } from '@wrongstack/core/coordination';
import type { TrustBoundary } from '@wrongstack/core/security';
import type { MCPRegistry } from '@wrongstack/mcp';
import type { WebSocket } from 'ws';
import type { BrainHandlerContext } from './brain-handlers.js';
import type { ChimeraRouteHandlers } from './chimera-routes.js';
import type { CodeAssistRouteHandlers } from './code-assist-routes.js';
import type { DesignContext } from './design-handlers.js';
import type {
  EmbeddedAgentConfigContext,
  EmbeddedConversationContext,
  EmbeddedProjectContext,
  EmbeddedProviderContext,
  EmbeddedSessionContext,
} from './embedded-host-adapters.js';
import type { GoalWebSocketHandler } from './goal-ws-handler.js';
import type { IntrospectionRouteContext } from './introspection-routes.js';
import type { KanbanTaskDispatcher } from './kanban-dispatch.js';
import type { KanbanHostRouteHandlers } from './kanban-host-routes.js';
import type { MailboxRouteHandlers } from './mailbox-routes.js';
import type { PrefsHandlerContext } from './prefs-handlers.js';
import type { PromptsContext } from './prompts-handlers.js';
import type { SddBoardWebSocketHandler } from './sdd-board-ws-handler.js';
import type { SddWizardWebSocketHandler } from './sdd-wizard-ws-handler.js';
import type { SkillsContext } from './skills-handlers.js';
import type { SpecsWebSocketHandler } from './specs-ws-handler.js';
import type { TerminalWebSocketHandler } from './terminal-ws-handler.js';
import type { WSClientMessage, WSServerMessage } from './types.js';
import type { WorktreeWebSocketHandler } from './worktree-ws-handler.js';

export interface EmbeddedMessageRouterOptions {
  agent: Agent;
  projectRoot?: string | undefined;
  profileConfigPath: string;
  mcpRegistry?: MCPRegistry | undefined;
  memoryStore?: MemoryPort | undefined;
  onKanbanDispatch?: KanbanTaskDispatcher | undefined;
}

export interface EmbeddedMessageRouterDeps {
  jevVault?: import('@wrongstack/contracts/types').SecretVault | undefined;
  trustBoundary: TrustBoundary;
  opts: EmbeddedMessageRouterOptions;
  logger: Logger;
  send: (ws: WebSocket, message: WSServerMessage) => void;
  sendResult: (ws: WebSocket, success: boolean, message: string) => void;
  sessionPayload: <T extends Record<string, unknown>>(payload: T) => T & { sessionId: string };
  currentSessionId: () => string;
  shutdown: () => void;
  /**
   * Caller-supplied register hook for long-lived disposables created inside
   * the router (the auto-heal watchdog). The router hands its disposer to the
   * caller once during construction; the caller is responsible for invoking
   * it during its own shutdown — the router itself never invokes it. Mirrors
   * `MessageDispatcherOptions.onDispose` in the standalone dispatcher.
   */
  onDispose?: ((disposer: () => void | Promise<void>) => void) | undefined;
  providerCtx: EmbeddedProviderContext;
  brainCtx: BrainHandlerContext;
  introspectionCtx: IntrospectionRouteContext;
  skillsCtx: SkillsContext;
  promptsCtx: PromptsContext;
  /**
   * Built per tab: the active design kit is pinned on the picking session's
   * own meta, so the CLI host resolves that session's context here.
   */
  designCtx: DesignContext | ((sessionId?: string | undefined) => DesignContext);
  agentConfigCtx: EmbeddedAgentConfigContext;
  prefsCtx: PrefsHandlerContext;
  projectCtx: EmbeddedProjectContext;
  sessionCtx: EmbeddedSessionContext;
  conversationCtx: EmbeddedConversationContext;
  mailboxRoutes: MailboxRouteHandlers;
  /**
   * Chimera review-report routes. Optional so an older CLI host (built before
   * this family existed) can still construct the router — the tab then just
   * never receives report-list answers instead of failing to boot.
   */
  chimeraRoutes?: ChimeraRouteHandlers | undefined;
  /**
   * Code Assist ("Ask AI") routes. Optional for the same back-compat reason as
   * `chimeraRoutes`: an older CLI host that predates this family still boots,
   * it just never answers `code.assist.run` (it falls through to `onUnknown`).
   */
  codeAssistRoutes?: CodeAssistRouteHandlers | undefined;
  goalHandler: GoalWebSocketHandler;
  specsHandler: SpecsWebSocketHandler;
  sddBoardHandler: SddBoardWebSocketHandler;
  sddWizardHandler: SddWizardWebSocketHandler | null;
  worktreeHandler: WorktreeWebSocketHandler;
  terminalHandler: TerminalWebSocketHandler;
  kanbanHostRoutes: KanbanHostRouteHandlers;
  /** Shared provider/model health tracker for the WebUI waiting-room panel.
   * Undefined when the host has not wired one (e.g. test harnesses). */
  statusTracker?: ProviderModelStatusTracker | undefined;
  /** Durable block/open audit trail (JSONL) next to the profile config.
   * Undefined when the host did not provide a profile path (test harnesses). */
  providerAuditFile?: string | undefined;
}

export type EmbeddedMessageRouter = (
  ws: WebSocket,
  client: unknown,
  message: WSClientMessage,
) => Promise<void>;
