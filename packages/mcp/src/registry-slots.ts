import type { MCPServerConfig, Tool } from '@wrongstack/contracts/types';
import type { MCPClient } from './client.js';
import type { MCPUnsupportedProtocolVersionError } from './constants.js';
import type { ConnectionState, MCPTool } from './contracts.js';
import type { ElicitationRequester } from './elicitation.js';
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
  /**
   * Raw tool list last learned from the server (live `tools/list` or the
   * manifest cache). The manifest is written from THIS, never from
   * `client.listTools()`: a write queued behind an idle sleep or crash runs
   * after the client is gone, and persisting `[]` then would boot the server
   * dormant with no tools — invisible until its config changes.
   */
  discoveredTools?: MCPTool[] | undefined;
  /** Signature of the wrapped tool set, so an unchanged lazy wake does not re-register. */
  toolSignature?: string | undefined;
  serverMetadata?: MCPServerMetadata | undefined;
  resources?: MCPResource[] | undefined;
  resourceTemplates?: MCPResourceTemplate[] | undefined;
  prompts?: MCPPrompt[] | undefined;
  /** Orders refreshes and list-change invalidations independently per catalog. */
  catalogVersions?:
    | Partial<Record<'resources' | 'resourceTemplates' | 'prompts', number>>
    | undefined;
  /** Serializes replacements so rapid list-change notifications cannot restore stale data. */
  manifestWrite?: Promise<void> | undefined;
  attempts: number;
  /**
   * The protocol-version refusal that ended the last connect attempt, if any.
   *
   * `attemptConnectSlot` swallows connect failures (a bad server must not
   * reject `start()`), so without this the demand-wake path could only report
   * a generic "failed to connect" and the refused revision — the one detail the
   * operator can act on — would be lost. Cleared when an attempt begins.
   */
  protocolVersionRefusal?: MCPUnsupportedProtocolVersionError | undefined;
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
  /** Invalidates asynchronous startup work when a stop interrupts it. */
  startupGeneration?: number | undefined;
  /** Whether this lazy server's resolver wrappers are registered (register once). */
  registeredLazy: boolean;
  /**
   * Runs with a tool call to this server in flight, oldest first. A server
   * elicitation asks the newest — the spec does not tie a request to a call.
   */
  activeCallers?: ElicitationRequester[] | undefined;
  /** Bounded, payload-free operational telemetry for this server. */
  operations: MCPServerOperationState;
}
