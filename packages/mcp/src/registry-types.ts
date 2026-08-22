import type { EventBus } from '@wrongstack/core/kernel';
import type { ToolRegistry } from '@wrongstack/core/registry';
import type { Logger, MCPServerConfig } from '@wrongstack/core/types';
import type { MCPAuthorizationProvider } from './authorization.js';
import type { MCPAuthorizationManager } from './authorization-manager.js';
import type { ConnectionState } from './contracts.js';
import type { MCPPrompt, MCPResource, MCPResourceTemplate, MCPServerMetadata } from './protocol.js';

export interface MCPRegistryOptions {
  toolRegistry: ToolRegistry;
  events: EventBus;
  log: Logger;
  cacheDir?: string | undefined;
  idleTimeoutMs?: number | undefined;
  lazyMode?: boolean | undefined;
  authorizationProviderFactory?:
    | ((server: Readonly<MCPServerConfig>) => MCPAuthorizationProvider | undefined)
    | undefined;
  authorizationManager?: MCPAuthorizationManager | undefined;
}

export interface MCPRegistryCatalog {
  name: string;
  state: ConnectionState;
  serverMetadata?: MCPServerMetadata | undefined;
  resources?: MCPResource[] | undefined;
  resourceTemplates?: MCPResourceTemplate[] | undefined;
  prompts?: MCPPrompt[] | undefined;
}
