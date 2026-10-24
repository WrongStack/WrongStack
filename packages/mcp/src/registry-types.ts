import type { EventBus } from '@wrongstack/contracts/kernel';
import type { Logger, MCPServerConfig } from '@wrongstack/contracts/types';
import type { ToolRegistry } from '@wrongstack/core/registry';
import type { MCPAuthorizationProvider } from './authorization.js';
import type { MCPAuthorizationManager } from './authorization-manager.js';
import type { ConnectionState } from './contracts.js';
import type { MCPElicitationHandler } from './elicitation.js';
import type { MCPPrompt, MCPResource, MCPResourceTemplate, MCPServerMetadata } from './protocol.js';
import type { MCPTaskContext as AgentContext } from './task-identity.js';

export interface MCPRegistryOptions {
  toolRegistry: ToolRegistry;
  events: EventBus;
  log: Logger;
  cacheDir?: string | undefined;
  /** Durable project state, separate from the disposable capability cache. */
  taskJournalDir?: string | undefined;
  /** Supplies only the currently attached session; other sessions are never recovered into it. */
  taskRecoveryContext?: (() => AgentContext | undefined) | undefined;
  /**
   * Working directory for stdio servers — the project root the host serves.
   * Omitted: children inherit the process cwd (only correct for a host that
   * runs from the project root).
   */
  cwd?: string | undefined;
  idleTimeoutMs?: number | undefined;
  lazyMode?: boolean | undefined;
  authorizationProviderFactory?:
    | ((server: Readonly<MCPServerConfig>) => MCPAuthorizationProvider | undefined)
    | undefined;
  authorizationManager?: MCPAuthorizationManager | undefined;
  /**
   * Puts a server's `elicitation/create` form in front of the user. Without
   * it the capability is not declared, so servers never send the request.
   */
  elicitationHandler?: MCPElicitationHandler | undefined;
}

export interface MCPRegistryCatalog {
  name: string;
  state: ConnectionState;
  serverMetadata?: MCPServerMetadata | undefined;
  resources?: MCPResource[] | undefined;
  resourceTemplates?: MCPResourceTemplate[] | undefined;
  prompts?: MCPPrompt[] | undefined;
}
