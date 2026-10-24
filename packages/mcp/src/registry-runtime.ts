import type { EventBus } from '@wrongstack/contracts/kernel';
import type { Logger, MCPServerConfig } from '@wrongstack/contracts/types';
import type { ToolRegistry } from '@wrongstack/core/registry';
import type { MCPAuthorizationManager } from './authorization-manager.js';
import type { MCPClient } from './client.js';
import { MCP_CONSTANTS } from './constants.js';
import type { MCPTool } from './contracts.js';
import type { MCPFailureKind, MCPOperationKind, MCPOperationListener } from './operations.js';
import type { MCPLogMessageNotification, MCPProgressNotification } from './protocol.js';
import { runWithConnectedClient } from './registry-catalog-operations.js';
import {
  applySlotTools,
  attemptConnectSlot,
  persistSlotCapabilityManifest,
} from './registry-connect-loop.js';
import { buildRegistryConnectContext, buildRegistryIdleContext } from './registry-contexts.js';
import { toolNamesForSlot } from './registry-describe.js';
import { type RegistryIdleContext, sweepIdleSlots } from './registry-idle.js';
import type { MCPRegistryInternals } from './registry-internals.js';
import {
  recordRegistryFailure,
  recordRegistryOperation,
  recordRegistrySuccess,
} from './registry-operations.js';
import {
  singleFlightConnect as singleFlightConnectFromHost,
  startLazy as startLazyFromHost,
} from './registry-server-lifecycle.js';
import {
  attachCatalogListeners,
  attemptSlotReconnect,
  detachCatalogListeners,
  handleChildExit,
  handleLogMessage,
  handleProgress,
  handlePromptsChanged,
  handleResourcesChanged,
  handleResourceUpdated,
  handleToolsChanged,
  handleTransportDisconnect,
  scheduleSlotReconnect,
} from './registry-slot-events.js';
import type { ServerSlot } from './registry-slots.js';
import type { MCPRegistryOptions } from './registry-types.js';
import { MCPTaskRecovery } from './task-recovery.js';

/**
 * State and connection machinery behind `MCPRegistry`: the slot table,
 * single-flight connects, idle sweep, the listeners a connected client
 * notifies (catalog changes, exit/disconnect + reconnect) and operational
 * bookkeeping. `MCPRegistry` (registry.ts) extends this with the public
 * lifecycle, catalog and authorization API. The members it needs from that
 * subclass are declared abstract here.
 */
export abstract class MCPRegistryRuntime {
  protected readonly servers = new Map<string, ServerSlot>();
  /** Configured-off servers are tracked without creating a transport/client. */
  protected readonly disabledServers = new Map<string, MCPServerConfig>();
  protected readonly toolRegistry: ToolRegistry;
  protected readonly events: EventBus;
  protected readonly log: Logger;
  protected readonly lazyMode: boolean;
  protected readonly cacheDir?: string | undefined;
  protected readonly cwd?: string | undefined;
  protected readonly idleTimeoutMs: number;
  protected readonly authorizationProviderFactory?: MCPRegistryOptions['authorizationProviderFactory'];
  protected readonly authorizationManager?: MCPAuthorizationManager | undefined;
  protected readonly elicitationHandler?: MCPRegistryOptions['elicitationHandler'];
  protected readonly taskRecovery?: MCPTaskRecovery | undefined;
  protected readonly operationListeners = new Set<MCPOperationListener>();
  /** Starts still in flight, for {@link whenStarted}. */
  protected readonly startups = new Set<Promise<void>>();
  /** Single shared idle sweep timer (started lazily; unref'd; cleared on stopAll). */
  protected idleTimer?: ReturnType<typeof setInterval> | undefined;

  constructor(opts: MCPRegistryOptions) {
    this.toolRegistry = opts.toolRegistry;
    this.events = opts.events;
    this.log = opts.log;
    this.lazyMode = opts.lazyMode ?? false;
    this.cacheDir = opts.cacheDir;
    this.cwd = opts.cwd;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? MCP_CONSTANTS.IDLE.DEFAULT_TIMEOUT_MS;
    this.authorizationProviderFactory = opts.authorizationProviderFactory;
    this.authorizationManager = opts.authorizationManager;
    this.elicitationHandler = opts.elicitationHandler;
    if (opts.taskJournalDir) {
      this.taskRecovery = new MCPTaskRecovery(opts.taskJournalDir, {
        log: this.log,
        withClient: (receipt, run) => {
          const slot = this.requireSlot(receipt.server);
          const check = () => {
            if (
              slot.cfg.permission === 'deny' ||
              (slot.cfg.allowedTools && !slot.cfg.allowedTools.includes(receipt.tool))
            )
              throw new Error('MCP task recovery denied by current server policy');
          };
          check();
          return this.withConnectedClient(receipt.server, (client, assertCurrent) =>
            run(client, slot.cfg.sandboxTrust === true, () => {
              assertCurrent();
              check();
            }),
          );
        },
      });
      this.taskRecovery.setContextProvider(opts.taskRecoveryContext);
    }
  }

  protected requireSlot(name: string): ServerSlot {
    const slot = this.servers.get(name);
    if (!slot) throw new Error(`MCP server "${name}" not registered`);
    return slot;
  }

  /**
   * Boot a lazy server WITHOUT spawning it. If a tool manifest is cached (from a
   * prior connect with matching config), register resolver-backed wrappers and
   * go `dormant` — the process spawns on the first tool call. If there is no
   * cache yet, do a one-time cold discovery connect to learn + cache the tools.
   */
  protected async startLazy(slot: ServerSlot): Promise<void> {
    return startLazyFromHost(this.internals(), slot);
  }

  protected singleFlightConnect(slot: ServerSlot): Promise<MCPClient | undefined> {
    return singleFlightConnectFromHost(this.internals(), slot);
  }

  /** Keep all remote requests awake and reject results from superseded clients. */
  protected async withConnectedClient<T>(
    name: string,
    run: (client: MCPClient, assertCurrent: () => void) => Promise<T>,
  ): Promise<T> {
    return runWithConnectedClient(this.internals(), name, run);
  }

  /**
   * Resolve the live tool names for a slot — the registered names in normal
   * mode, or the cached lazy-tool names when running in lazy mode (where
   * tools are connected but intentionally not registered).
   */
  protected toolNamesForSlot(s: ServerSlot): string[] {
    return toolNamesForSlot(s);
  }

  /**
   * This registry as the structural view its extracted method bodies take
   * (see registry-internals.ts); the abstract members are supplied by
   * `MCPRegistry`.
   */
  protected internals(): MCPRegistryInternals {
    return this as unknown as MCPRegistryInternals;
  }

  protected connectContext() {
    return buildRegistryConnectContext(this.internals());
  }

  protected idleContext(): RegistryIdleContext {
    return buildRegistryIdleContext(this.internals());
  }

  protected applyTools(slot: ServerSlot, tools: MCPTool[], client?: MCPClient | undefined): void {
    applySlotTools(this.connectContext(), slot, tools, client);
  }

  protected async persistCapabilityManifest(slot: ServerSlot): Promise<void> {
    return persistSlotCapabilityManifest(this.cacheDir, slot);
  }

  /** Start the shared idle sweep timer once (unref'd so it never holds the process). */
  protected ensureIdleSweep(): void {
    if (this.idleTimer || this.idleTimeoutMs <= 0) return;
    this.idleTimer = setInterval(() => {
      void this.sweepIdle();
    }, MCP_CONSTANTS.IDLE.SWEEP_INTERVAL_MS);
    this.idleTimer.unref?.();
  }

  protected async sweepIdle(): Promise<void> {
    if (this.idleTimeoutMs <= 0) return;
    const hasConnectedLazy = await sweepIdleSlots(this.idleContext());
    if (!hasConnectedLazy && this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  /**
   * L2-C: handle `notifications/tools/list_changed` from the server.
   * Unregister the previous wrapper set, then re-register the fresh
   * tool list. The client has already refreshed its cache before
   * dispatching — we just need to re-wrap and re-register.
   * In lazy mode, only update the internal cache without registering.
   */
  protected readonly onToolsChanged = (name: string, _tools: { name: string }[]): void =>
    handleToolsChanged(this.internals(), name);

  protected readonly onResourcesChanged = (name: string): void =>
    handleResourcesChanged(this.internals(), name);

  protected readonly onResourceUpdated = (name: string, uri: string): void =>
    handleResourceUpdated(this.internals(), name, uri);

  protected readonly onProgress = (name: string, progress: MCPProgressNotification): void =>
    handleProgress(this.internals(), name, progress);

  protected readonly onLogMessage = (name: string, log: MCPLogMessageNotification): void =>
    handleLogMessage(this.internals(), name, log);

  protected readonly onPromptsChanged = (name: string): void =>
    handlePromptsChanged(this.internals(), name);

  protected addCatalogListeners(client: MCPClient): void {
    attachCatalogListeners(this.internals(), client);
  }

  protected removeCatalogListeners(client: MCPClient): void {
    detachCatalogListeners(this.internals(), client);
  }

  protected readonly onChildExit = (
    name: string,
    code: number | null,
    _signal: string | null,
  ): void => handleChildExit(this.internals(), name, code);

  /** Handles SSE / streamable-http disconnect — same recovery as stdio child exit. */
  protected readonly onTransportDisconnect = (name: string): void =>
    handleTransportDisconnect(this.internals(), name);

  protected scheduleReconnect(slot: ServerSlot): void {
    scheduleSlotReconnect(this.internals(), slot);
  }

  protected async attemptReconnect(slot: ServerSlot): Promise<void> {
    return attemptSlotReconnect(this.internals(), slot);
  }

  protected recordSuccess(slot: ServerSlot, resetFailures = true): void {
    recordRegistrySuccess(slot, resetFailures);
  }

  protected recordFailure(
    slot: ServerSlot,
    failureKind: MCPFailureKind,
    reason: string,
    durationMs?: number | undefined,
  ): void {
    recordRegistryFailure(slot, this.operationListeners, failureKind, reason, durationMs);
  }

  protected recordOperation(
    slot: ServerSlot,
    kind: MCPOperationKind,
    reason?: string | undefined,
    failureKind?: MCPFailureKind | undefined,
    durationMs?: number | undefined,
    retain = true,
  ): void {
    recordRegistryOperation(
      slot,
      this.operationListeners,
      kind,
      reason,
      failureKind,
      durationMs,
      retain,
    );
  }

  protected async attemptConnect(slot: ServerSlot): Promise<void> {
    return attemptConnectSlot(this.connectContext(), slot);
  }
  abstract ensureConnected(name: string): Promise<MCPClient>;
  abstract stop(name: string): Promise<void>;
  abstract markDisabled(cfg: MCPServerConfig): void;
}
