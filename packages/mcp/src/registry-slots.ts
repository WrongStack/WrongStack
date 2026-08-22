import type { MCPServerConfig, Tool } from '@wrongstack/core/types';
import type { MCPClient } from './client.js';
import type { ConnectionState } from './contracts.js';
import type { MCPServerOperationState } from './operations.js';
import type { MCPPrompt, MCPResource, MCPResourceTemplate, MCPServerMetadata } from './protocol.js';

export interface ServerSlot {
  cfg: MCPServerConfig;
  client?: MCPClient | undefined;
  state: ConnectionState;
  /** Tools currently registered in toolRegistry (empty in lazy mode). */
  toolNames: string[];
  /** Cached tools when lazyMode is active (not registered in toolRegistry). */
  lazyTools: Tool[];
  serverMetadata?: MCPServerMetadata | undefined;
  resources?: MCPResource[] | undefined;
  resourceTemplates?: MCPResourceTemplate[] | undefined;
  prompts?: MCPPrompt[] | undefined;
  /** Serializes replacements so rapid list-change notifications cannot restore stale data. */
  manifestWrite?: Promise<void> | undefined;
  attempts: number;
  /** Set when a reconnect cycle is already running for this slot. */
  reconnectPending: boolean;
  reconnectTimer?: NodeJS.Timeout | undefined;
  reconnectCycles: number;
  onDisconnect?: (() => void) | undefined;
  lazy: boolean;
  /** Epoch ms of the last tool call — drives idle auto-sleep. */
  lastUsed: number;
  /** Single-flight guard so concurrent first-calls trigger only one connect. */
  connecting?: Promise<MCPClient | undefined> | undefined;
  /** Whether this lazy server's resolver wrappers are registered (register once). */
  registeredLazy: boolean;
  /** Bounded, payload-free operational telemetry for this server. */
  operations: MCPServerOperationState;
}
