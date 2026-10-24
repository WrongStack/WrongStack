import type { EventBus } from '@wrongstack/contracts/kernel';
import type { Logger, MCPServerConfig } from '@wrongstack/contracts/types';
import type { ToolRegistry } from '@wrongstack/core/registry';
import type { MCPClient } from './client.js';
import type { MCPTool } from './contracts.js';
import type { MCPFailureKind, MCPOperationKind, MCPOperationListener } from './operations.js';
import type { MCPLogMessageNotification, MCPProgressNotification } from './protocol.js';
import type { RegistryCatalogOperationsHost } from './registry-catalog-operations.js';
import type { RegistryServerLifecycleHost } from './registry-server-lifecycle.js';
import type { ServerSlot } from './registry-slots.js';
import type { MCPRegistryOptions } from './registry-types.js';
import type { MCPTaskRecovery } from './task-recovery.js';

/**
 * The private state and private members of `MCPRegistry`, as seen by the
 * free functions its method bodies were extracted into (registry-slot-events,
 * registry-contexts, registry-describe). The class hands itself to those
 * functions through this structural view; consumers still see the members
 * as private.
 */
export interface MCPRegistryInternals
  extends RegistryServerLifecycleHost,
    RegistryCatalogOperationsHost {
  readonly servers: Map<string, ServerSlot>;
  readonly disabledServers: Map<string, MCPServerConfig>;
  readonly toolRegistry: ToolRegistry;
  readonly events: EventBus;
  readonly log: Logger;
  readonly lazyMode: boolean;
  readonly cacheDir: string | undefined;
  readonly cwd: string | undefined;
  readonly idleTimeoutMs: number;
  readonly authorizationProviderFactory: MCPRegistryOptions['authorizationProviderFactory'];
  readonly elicitationHandler: MCPRegistryOptions['elicitationHandler'];
  readonly taskRecovery: MCPTaskRecovery | undefined;
  readonly operationListeners: Set<MCPOperationListener>;
  readonly onToolsChanged: (name: string, _tools: { name: string }[]) => void;
  readonly onResourcesChanged: (name: string) => void;
  readonly onResourceUpdated: (name: string, uri: string) => void;
  readonly onProgress: (name: string, progress: MCPProgressNotification) => void;
  readonly onLogMessage: (name: string, log: MCPLogMessageNotification) => void;
  readonly onPromptsChanged: (name: string) => void;
  readonly onChildExit: (name: string, code: number | null, _signal: string | null) => void;
  readonly onTransportDisconnect: (name: string) => void;
  ensureConnected(name: string): Promise<MCPClient>;
  requireSlot(name: string): ServerSlot;
  singleFlightConnect(slot: ServerSlot): Promise<MCPClient | undefined>;
  applyTools(slot: ServerSlot, tools: MCPTool[], client?: MCPClient | undefined): void;
  persistCapabilityManifest(slot: ServerSlot): Promise<void>;
  toolNamesForSlot(s: ServerSlot): string[];
  addCatalogListeners(client: MCPClient): void;
  removeCatalogListeners(client: MCPClient): void;
  ensureIdleSweep(): void;
  scheduleReconnect(slot: ServerSlot): void;
  attemptReconnect(slot: ServerSlot): Promise<void>;
  recordSuccess(slot: ServerSlot, resetFailures?: boolean): void;
  recordFailure(
    slot: ServerSlot,
    failureKind: MCPFailureKind,
    reason: string,
    durationMs?: number | undefined,
  ): void;
  recordOperation(
    slot: ServerSlot,
    kind: MCPOperationKind,
    reason?: string | undefined,
    failureKind?: MCPFailureKind | undefined,
    durationMs?: number | undefined,
    retain?: boolean,
  ): void;
}
