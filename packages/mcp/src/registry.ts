import type { EventBus } from '@wrongstack/core/kernel';
import type { ToolRegistry } from '@wrongstack/core/registry';
import type { Logger } from '@wrongstack/core/types';
import type { MCPServerConfig } from '@wrongstack/core/types';
import { expectDefined } from '@wrongstack/core/utils';
import type {
  MCPAuthorizationManager,
  MCPAuthorizationStartResult,
  MCPAuthorizationStatus,
} from './authorization-manager.js';
import { type ConnectionState, MCPClient, type MCPTool } from './client.js';
import { MCP_CONSTANTS } from './constants.js';
import {
  type MCPInsertionPolicy,
  type MCPPromptInsertion,
  type MCPResourceInsertion,
  preparePromptInsertion,
  prepareResourceInsertion,
} from './content-selection.js';
import {
  manifestConfigHash,
  readCapabilityManifest,
  writeCapabilityManifest,
} from './manifest-cache.js';
import {
  createMCPServerOperationState,
  MCP_OPERATION_LIMITS,
  type MCPFailureKind,
  type MCPOperationKind,
  type MCPOperationListener,
  type MCPServerOperationalHealth,
  pushBounded,
} from './operations.js';
import {
  cloneCatalogRecords,
  collectCatalogPages,
  registryCatalogSnapshot,
} from './registry-catalog.js';
import { buildRegistryOperationalHealth } from './registry-health.js';
import {
  beginRegistryAuthorization,
  completeRegistryAuthorization,
  requireAuthorizationManager,
  requireHttpServerConfig,
} from './registry-authorization.js';
import type { ServerSlot } from './registry-slots.js';
import type { MCPRegistryCatalog, MCPRegistryOptions } from './registry-types.js';
import {
  recordRegistryFailure,
  recordRegistryOperation,
  recordRegistrySuccess,
} from './registry-operations.js';
import { markLazySlotDormant, resetDisconnectedSlotTools } from './registry-disconnect.js';
import { scheduleRegistryReconnect } from './registry-reconnect.js';
import type {
  MCPGetPromptResult,
  MCPPrompt,
  MCPReadResourceResult,
  MCPResource,
  MCPResourceTemplate,
} from './protocol.js';
import { wrapMCPTool } from './wrap-tool.js';
export type { MCPRegistryCatalog, MCPRegistryOptions } from './registry-types.js';

export class MCPRegistry {
  private readonly servers = new Map<string, ServerSlot>();
  /** Configured-off servers are tracked without creating a transport/client. */
  private readonly disabledServers = new Map<string, MCPServerConfig>();
  private readonly toolRegistry: ToolRegistry;
  private readonly events: EventBus;
  private readonly log: Logger;
  private readonly lazyMode: boolean;
  private readonly cacheDir?: string | undefined;
  private readonly idleTimeoutMs: number;
  private readonly authorizationProviderFactory?: MCPRegistryOptions['authorizationProviderFactory'];
  private readonly authorizationManager?: MCPAuthorizationManager | undefined;
  private readonly operationListeners = new Set<MCPOperationListener>();
  /** Single shared idle sweep timer (started lazily; unref'd; cleared on stopAll). */
  private idleTimer?: ReturnType<typeof setInterval> | undefined;

  constructor(opts: MCPRegistryOptions) {
    this.toolRegistry = opts.toolRegistry;
    this.events = opts.events;
    this.log = opts.log;
    this.lazyMode = opts.lazyMode ?? false;
    this.cacheDir = opts.cacheDir;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? MCP_CONSTANTS.IDLE.DEFAULT_TIMEOUT_MS;
    this.authorizationProviderFactory = opts.authorizationProviderFactory;
    this.authorizationManager = opts.authorizationManager;
  }

  private requireSlot(name: string): ServerSlot {
    const slot = this.servers.get(name);
    if (!slot) throw new Error(`MCP server "${name}" not registered`);
    return slot;
  }

  async beginAuthorization(
    name: string,
    input: {
      clientId: string;
      redirectUri: string;
      scopes?: readonly string[] | undefined;
      challengeHeader?: string | null | undefined;
      signal?: AbortSignal | undefined;
    },
  ): Promise<MCPAuthorizationStartResult> {
    const cfg = this.requireHttpServerConfig(name);
    return beginRegistryAuthorization(this.authorizationManager, cfg, name, input);
  }

  async completeAuthorization(
    name: string,
    callbackUrl: string,
    signal?: AbortSignal | undefined,
  ): Promise<MCPAuthorizationStatus> {
    const cfg = this.requireHttpServerConfig(name);
    return completeRegistryAuthorization(
      this.authorizationManager,
      cfg,
      name,
      callbackUrl,
      signal,
    );
  }

  async authorizationStatus(name: string): Promise<MCPAuthorizationStatus> {
    const manager = requireAuthorizationManager(this.authorizationManager);
    const cfg = this.requireHttpServerConfig(name);
    return manager.status(name, cfg.url!);
  }

  async disconnectAuthorization(name: string): Promise<boolean> {
    const manager = requireAuthorizationManager(this.authorizationManager);
    const cfg = this.requireHttpServerConfig(name);
    return manager.disconnect(name, cfg.url!);
  }

  private requireHttpServerConfig(name: string): MCPServerConfig {
    return requireHttpServerConfig(this.servers, this.disabledServers, name);
  }

  async start(cfg: MCPServerConfig): Promise<void> {
    if (cfg.enabled === false) {
      if (this.servers.has(cfg.name)) {
        await this.stop(cfg.name);
      }
      this.markDisabled(cfg);
      return;
    }
    this.disabledServers.delete(cfg.name);
    // Reject duplicate registrations explicitly. Without this, calling
    // start() twice with the same name would overwrite the slot in
    // `this.servers` and orphan the previous slot's client (still
    // connected, with listeners wired into a slot that's no longer
    // reachable from the registry). Callers that want a clean re-start
    // should use `restart(name)`.
    if (this.servers.has(cfg.name)) {
      throw new Error(
        `MCP server "${cfg.name}" is already registered — use restart() to re-cycle a running server`,
      );
    }
    // Lazy-connect requires a manifest cache dir to register tools cold.
    const lazy = !!cfg.lazy && !!this.cacheDir;
    const slot: ServerSlot = {
      cfg,
      state: 'idle',
      toolNames: [],
      lazyTools: [],
      attempts: 0,
      reconnectPending: false,
      reconnectCycles: 0,
      lazy,
      lastUsed: Date.now(),
      registeredLazy: false,
      operations: createMCPServerOperationState(),
    };
    this.servers.set(cfg.name, slot);
    if (lazy) {
      await this.startLazy(slot);
    } else {
      await this.singleFlightConnect(slot);
    }
  }

  /** Record an intentionally disabled configuration without opening a transport. */
  markDisabled(cfg: MCPServerConfig): void {
    this.servers.delete(cfg.name);
    this.disabledServers.set(cfg.name, { ...cfg, enabled: false });
  }

  /** Remove residual operational/configuration state after a management delete. */
  forget(name: string): void {
    this.servers.delete(name);
    this.disabledServers.delete(name);
  }

  /**
   * Boot a lazy server WITHOUT spawning it. If a tool manifest is cached (from a
   * prior connect with matching config), register resolver-backed wrappers and
   * go `dormant` — the process spawns on the first tool call. If there is no
   * cache yet, do a one-time cold discovery connect to learn + cache the tools.
   */
  private async startLazy(slot: ServerSlot): Promise<void> {
    // start() only marks a slot lazy when a cache directory is configured.
    const cacheDir = expectDefined(this.cacheDir);
    const hash = manifestConfigHash(slot.cfg);
    const cached = await readCapabilityManifest(cacheDir, slot.cfg.name, hash);
    if (cached) {
      slot.serverMetadata = cached.serverMetadata;
      slot.resources = cached.resources;
      slot.resourceTemplates = cached.resourceTemplates;
      slot.prompts = cached.prompts;
      this.applyTools(slot, cached.tools);
      slot.state = 'dormant';
      this.ensureIdleSweep();
      this.log.info(
        `MCP server "${slot.cfg.name}" registered lazily from cache (${cached.tools.length} tools, dormant)`,
      );
      return;
    }
    // No cache — must connect once to discover the tool list, then it stays
    // connected and becomes eligible for idle auto-sleep.
    await this.singleFlightConnect(slot);
  }

  private singleFlightConnect(slot: ServerSlot): Promise<MCPClient | undefined> {
    if (slot.client && slot.state === 'connected') return Promise.resolve(slot.client);
    if (slot.connecting) return slot.connecting;

    const promise = (async () => {
      try {
        await this.attemptConnect(slot);
        return slot.client;
      } finally {
        slot.connecting = undefined;
      }
    })();
    slot.connecting = promise;

    return promise;
  }

  /**
   * Ensure a lazy server is connected, spawning it on demand. Single-flight:
   * concurrent first-calls share one connect. Resolver wrappers call this.
   */
  async ensureConnected(name: string): Promise<MCPClient> {
    const slot = this.servers.get(name);
    if (!slot) throw new Error(`MCP server "${name}" not registered`);
    slot.lastUsed = Date.now();
    if (slot.client && slot.state === 'connected') return slot.client;
    const waking = slot.state === 'dormant';
    if (waking) {
      slot.operations.wakeCount++;
      this.recordOperation(slot, 'wake', 'lazy-demand');
      slot.attempts = 0;
      slot.reconnectCycles = 0;
    }
    const client = await this.singleFlightConnect(slot);
    if (!client) {
      throw new Error(`MCP server "${name}" failed to connect on demand`);
    }
    slot.lastUsed = Date.now();
    this.ensureIdleSweep();
    return client;
  }

  /**
   * Register all cached tools for a given server into the tool registry.
   * No-op if tools are already registered or the server is not connected.
   * The server connection stays alive — this only toggles tool visibility.
   */
  activateServer(name: string): void {
    const slot = this.servers.get(name);
    if (!slot) return;
    // A dormant lazy server has no client yet — its resolver wrappers connect on
    // demand, so it can still be activated (registered) without a live process.
    if (!slot.client && !slot.lazy) return;
    if (slot.toolNames.length > 0) return; // already active
    const cached = slot.lazyTools;
    if (cached.length === 0) return;
    for (const tool of cached) {
      try {
        this.toolRegistry.register(tool, `mcp:${name}`);
        slot.toolNames.push(tool.name);
      } catch (err) {
        this.log.warn(`MCP tool "${tool.name}" activate failed`, err);
      }
    }
    this.log.info(`MCP server "${name}" activated (${slot.toolNames.length} tools)`);
    this.events.emit('mcp.server.connected', { name, toolCount: slot.toolNames.length });
  }

  /**
   * Unregister all tools for a given server from the tool registry.
   * The server connection stays alive — this only toggles tool visibility.
   * Returns the number of tools that were deactivated.
   */
  deactivateServer(name: string): number {
    const slot = this.servers.get(name);
    if (!slot) return 0;
    const count = slot.toolNames.length;
    if (count === 0) return 0;
    for (const t of slot.toolNames) {
      try {
        this.toolRegistry.unregister(t);
      } catch {
        /* ignore */
      }
    }
    slot.toolNames = [];
    this.log.info(`MCP server "${name}" deactivated (${count} tools removed)`);
    this.events.emit('mcp.server.disconnected', { name, reason: 'deactivate' });
    return count;
  }

  /**
   * Check whether a server's tools are currently registered.
   */
  isActivated(name: string): boolean {
    const slot = this.servers.get(name);
    return slot ? slot.toolNames.length > 0 : false;
  }

  async stop(name: string): Promise<void> {
    const slot = this.servers.get(name);
    if (!slot) return;
    slot.reconnectPending = false;
    // Cancel the pending backoff timer. Without this, a disconnect scheduled
    // for reconnection would fire its `attemptReconnect` callback after the
    // slot has been torn down and respawn the server we just told to stop.
    if (slot.reconnectTimer) {
      clearTimeout(slot.reconnectTimer);
      slot.reconnectTimer = undefined;
    }
    slot.state = 'disconnected';
    if (slot.client) {
      slot.client.removeExitListener(this.onChildExit);
      if (slot.onDisconnect) slot.client.removeDisconnectListener(slot.onDisconnect);
      slot.client.removeToolsChangedListener(this.onToolsChanged);
      this.removeCatalogListeners(slot.client);
      await slot.client.close();
      slot.client = undefined;
    }
    slot.onDisconnect = undefined;
    slot.connecting = undefined;
    for (const t of slot.toolNames) this.toolRegistry.unregister(t);
    slot.toolNames = [];
    slot.lazyTools = [];
    slot.serverMetadata = undefined;
    slot.resources = undefined;
    slot.resourceTemplates = undefined;
    slot.prompts = undefined;
    // Full teardown — a future start()/restart() re-registers lazy wrappers.
    slot.registeredLazy = false;
    this.recordOperation(slot, 'stop', 'manual');
    this.events.emit('mcp.server.disconnected', { name, reason: 'stop' });
  }

  async restart(name: string): Promise<void> {
    const slot = this.servers.get(name);
    if (!slot) throw new Error(`MCP server "${name}" not registered`);
    slot.operations.restartCount++;
    this.recordOperation(slot, 'restart', 'manual');
    await this.stop(name);
    slot.attempts = 0;
    slot.reconnectCycles = 0; // user intent: start fresh
    if (slot.lazy) {
      await this.startLazy(slot);
    } else {
      await this.singleFlightConnect(slot);
    }
  }

  list(): { name: string; state: ConnectionState; toolCount: number; tools: string[] }[] {
    return Array.from(this.servers.values()).map((s) => {
      const tools = this.toolNamesForSlot(s);
      return {
        name: s.cfg.name,
        state: s.state,
        toolCount: tools.length,
        tools,
      };
    });
  }

  /**
   * Subscribe to payload-free operational signals. Callers must still avoid
   * using `serverName` as an unbounded metric label.
   */
  onOperation(listener: MCPOperationListener): () => void {
    this.operationListeners.add(listener);
    return () => this.operationListeners.delete(listener);
  }

  /** Detailed, defensively-copied operational snapshots for CLI/WebUI/HQ. */
  operationalHealth(): MCPServerOperationalHealth[] {
    return buildRegistryOperationalHealth(this.servers.values(), this.disabledServers.values());
  }

  getCatalog(name: string): MCPRegistryCatalog | undefined {
    const slot = this.servers.get(name);
    if (!slot) return undefined;
    return registryCatalogSnapshot(slot);
  }

  async listResources(name: string, opts: { refresh?: boolean } = {}): Promise<MCPResource[]> {
    const slot = this.requireSlot(name);
    if (!opts.refresh && slot.resources) return cloneCatalogRecords(slot.resources);
    const client = await this.ensureConnected(name);
    if (!client.getServerMetadata()?.capabilities.resources) return [];
    slot.resources = await collectCatalogPages(
      (cursor) => client.listResources(cursor ? { cursor } : {}),
      (page) => page.resources,
    );
    await this.persistCapabilityManifest(slot);
    return cloneCatalogRecords(slot.resources);
  }

  async listResourceTemplates(
    name: string,
    opts: { refresh?: boolean } = {},
  ): Promise<MCPResourceTemplate[]> {
    const slot = this.requireSlot(name);
    if (!opts.refresh && slot.resourceTemplates) return cloneCatalogRecords(slot.resourceTemplates);
    const client = await this.ensureConnected(name);
    if (!client.getServerMetadata()?.capabilities.resources) return [];
    slot.resourceTemplates = await collectCatalogPages(
      (cursor) => client.listResourceTemplates(cursor ? { cursor } : {}),
      (page) => page.resourceTemplates,
    );
    await this.persistCapabilityManifest(slot);
    return cloneCatalogRecords(slot.resourceTemplates);
  }

  async readResource(name: string, uri: string): Promise<MCPReadResourceResult> {
    return (await this.ensureConnected(name)).readResource(uri);
  }

  async selectResourceForInsertion(
    name: string,
    uri: string,
    policy?: MCPInsertionPolicy | undefined,
  ): Promise<MCPResourceInsertion> {
    return prepareResourceInsertion(name, uri, await this.readResource(name, uri), policy);
  }

  async subscribeResource(name: string, uri: string): Promise<void> {
    await (await this.ensureConnected(name)).subscribeResource(uri);
  }

  async unsubscribeResource(name: string, uri: string): Promise<void> {
    await (await this.ensureConnected(name)).unsubscribeResource(uri);
  }

  async listPrompts(name: string, opts: { refresh?: boolean } = {}): Promise<MCPPrompt[]> {
    const slot = this.requireSlot(name);
    if (!opts.refresh && slot.prompts) return cloneCatalogRecords(slot.prompts);
    const client = await this.ensureConnected(name);
    if (!client.getServerMetadata()?.capabilities.prompts) return [];
    slot.prompts = await collectCatalogPages(
      (cursor) => client.listPrompts(cursor ? { cursor } : {}),
      (page) => page.prompts,
    );
    await this.persistCapabilityManifest(slot);
    return cloneCatalogRecords(slot.prompts);
  }

  async getPrompt(
    serverName: string,
    promptName: string,
    args?: Record<string, string> | undefined,
  ): Promise<MCPGetPromptResult> {
    return (await this.ensureConnected(serverName)).getPrompt(promptName, args);
  }

  async selectPromptForInsertion(
    serverName: string,
    promptName: string,
    args?: Record<string, string> | undefined,
    policy?: MCPInsertionPolicy | undefined,
  ): Promise<MCPPromptInsertion> {
    return preparePromptInsertion(
      serverName,
      promptName,
      args,
      await this.getPrompt(serverName, promptName, args),
      policy,
    );
  }

  /**
   * Resolve the live tool names for a slot — the registered names in normal
   * mode, or the cached lazy-tool names when running in lazy mode (where
   * tools are connected but intentionally not registered).
   */
  private toolNamesForSlot(s: ServerSlot): string[] {
    return s.toolNames.length > 0 ? s.toolNames.slice() : (s.lazyTools ?? []).map((t) => t.name);
  }

  /**
   * Wrap + register (or cache) a server's tools. Lazy servers get resolver-backed
   * wrappers that spawn the process on first use; eager servers bind the live
   * client directly. Honours token-saving `lazyMode` (cache, don't register) and
   * a register-once guard for lazy resolver wrappers (so a wake/reconnect reuses
   * the existing registrations rather than churning the tool list).
   */
  private applyTools(slot: ServerSlot, tools: MCPTool[], client?: MCPClient | undefined): void {
    // Resolver wrappers survive sleep/wake — only register them once.
    if (slot.lazy && slot.registeredLazy && !this.lazyMode) return;
    const allowed = slot.cfg.allowedTools;
    const filtered = tools.filter((t) => !allowed || allowed.includes(t.name));
    const clientArg = slot.lazy ? () => this.ensureConnected(slot.cfg.name) : expectDefined(client);
    const wrapped = filtered.map((t) =>
      wrapMCPTool(slot.cfg.name, t, clientArg, slot.cfg.permission ?? 'confirm', {
        onStart: () => {
          slot.operations.inFlightCalls++;
          slot.operations.peakInFlightCalls = Math.max(
            slot.operations.peakInFlightCalls,
            slot.operations.inFlightCalls,
          );
          this.recordOperation(slot, 'call', 'started', undefined, undefined, false);
        },
        onFinish: ({ durationMs, ok }) => {
          slot.operations.inFlightCalls = Math.max(0, slot.operations.inFlightCalls - 1);
          pushBounded(
            slot.operations.callSamples,
            durationMs,
            MCP_OPERATION_LIMITS.LATENCY_SAMPLES,
          );
          if (ok) {
            this.recordSuccess(slot);
            this.recordOperation(slot, 'call', 'ok', undefined, durationMs, false);
          } else {
            this.recordFailure(slot, 'tool', 'tool-call-failed', durationMs);
          }
        },
      }),
    );
    if (this.lazyMode) {
      // Token-saving mode: cache without registering (mcp_use activates on demand).
      slot.lazyTools = wrapped;
      return;
    }
    for (const tool of wrapped) {
      try {
        this.toolRegistry.register(tool, `mcp:${slot.cfg.name}`);
        slot.toolNames.push(tool.name);
      } catch (err) {
        this.log.warn(`MCP tool "${tool.name}" not registered`, err);
      }
    }
    if (slot.lazy && wrapped.length > 0) slot.registeredLazy = true;
  }

  private async discoverCapabilities(slot: ServerSlot, client: MCPClient): Promise<void> {
    const startedAt = Date.now();
    slot.serverMetadata = client.getServerMetadata();
    const capabilities = slot.serverMetadata?.capabilities;
    if (capabilities?.resources) {
      try {
        slot.resources = await collectCatalogPages(
          (cursor) => client.listResources(cursor ? { cursor } : {}),
          (page) => page.resources,
        );
      } catch (err) {
        slot.resources = undefined;
        this.recordFailure(slot, 'protocol', 'resource-discovery-failed');
        this.log.warn(`MCP server "${slot.cfg.name}" resource discovery failed`, err);
      }
      try {
        slot.resourceTemplates = await collectCatalogPages(
          (cursor) => client.listResourceTemplates(cursor ? { cursor } : {}),
          (page) => page.resourceTemplates,
        );
      } catch (err) {
        slot.resourceTemplates = undefined;
        this.recordFailure(slot, 'protocol', 'resource-template-discovery-failed');
        this.log.warn(`MCP server "${slot.cfg.name}" resource template discovery failed`, err);
      }
    } else {
      slot.resources = undefined;
      slot.resourceTemplates = undefined;
    }
    if (capabilities?.prompts) {
      try {
        slot.prompts = await collectCatalogPages(
          (cursor) => client.listPrompts(cursor ? { cursor } : {}),
          (page) => page.prompts,
        );
      } catch (err) {
        slot.prompts = undefined;
        this.recordFailure(slot, 'protocol', 'prompt-discovery-failed');
        this.log.warn(`MCP server "${slot.cfg.name}" prompt discovery failed`, err);
      }
    } else {
      slot.prompts = undefined;
    }
    const durationMs = Date.now() - startedAt;
    pushBounded(slot.operations.discoverySamples, durationMs, MCP_OPERATION_LIMITS.LATENCY_SAMPLES);
    this.recordOperation(slot, 'discover', 'complete', undefined, durationMs, false);
  }

  private async persistCapabilityManifest(slot: ServerSlot): Promise<void> {
    if (!slot.lazy || !this.cacheDir) return;
    const cacheDir = this.cacheDir;
    const previous = slot.manifestWrite ?? Promise.resolve();
    const pending = previous.then(() =>
      writeCapabilityManifest(cacheDir, slot.cfg.name, manifestConfigHash(slot.cfg), {
        tools: slot.client?.listTools() ?? [],
        serverMetadata: slot.serverMetadata,
        resources: slot.resources,
        resourceTemplates: slot.resourceTemplates,
        prompts: slot.prompts,
      }),
    );
    slot.manifestWrite = pending;
    await pending;
    if (slot.manifestWrite === pending) slot.manifestWrite = undefined;
  }

  /** Start the shared idle sweep timer once (unref'd so it never holds the process). */
  private ensureIdleSweep(): void {
    if (this.idleTimer || this.idleTimeoutMs <= 0) return;
    this.idleTimer = setInterval(() => {
      void this.sweepIdle();
    }, MCP_CONSTANTS.IDLE.SWEEP_INTERVAL_MS);
    // Node-only: don't keep the event loop alive just for the sweep.
    this.idleTimer.unref?.();
  }

  /** Auto-sleep connected lazy servers that have been idle past the timeout. */
  private async sweepIdle(): Promise<void> {
    if (this.idleTimeoutMs <= 0) return;
    const now = Date.now();
    for (const slot of this.servers.values()) {
      if (
        slot.lazy &&
        slot.state === 'connected' &&
        slot.client &&
        now - slot.lastUsed > this.idleTimeoutMs
      ) {
        await this.sleepIdle(slot);
      }
    }
    // The sweep only has work while a lazy server is connected. Once the last
    // one sleeps, stop the otherwise permanent unref'd wake-up; start() and
    // lazy wake-up paths call ensureIdleSweep() when it is needed again.
    const hasConnectedLazyServer = [...this.servers.values()].some(
      (slot) => slot.lazy && slot.state === 'connected' && slot.client,
    );
    if (!hasConnectedLazyServer && this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  /**
   * Soft stop: close the server process but KEEP its resolver wrappers and
   * cached manifest registered, so the next tool call transparently re-wakes it.
   * Distinct from {@link stop} (full teardown for disable/remove).
   */
  private async sleepIdle(slot: ServerSlot): Promise<void> {
    slot.reconnectPending = false;
    // Defense-in-depth: a connect-failure retry timer from an earlier
    // failed cycle shouldn't outlive a fresh sleep.
    if (slot.reconnectTimer) {
      clearTimeout(slot.reconnectTimer);
      slot.reconnectTimer = undefined;
    }
    if (slot.client) {
      // Remove the exit listener BEFORE close so the teardown isn't seen as a crash.
      slot.client.removeExitListener(this.onChildExit);
      if (slot.onDisconnect) slot.client.removeDisconnectListener(slot.onDisconnect);
      slot.client.removeToolsChangedListener(this.onToolsChanged);
      this.removeCatalogListeners(slot.client);
      await slot.client.close();
      slot.client = undefined;
    }
    slot.onDisconnect = undefined;
    slot.state = 'dormant';
    slot.operations.sleepCount++;
    this.recordOperation(slot, 'sleep', 'idle-timeout');
    this.log.info(`MCP server "${slot.cfg.name}" idle — sleeping (tools stay registered)`);
    this.events.emit('mcp.server.disconnected', { name: slot.cfg.name, reason: 'idle-sleep' });
  }

  /**
   * Catalog of every server ever registered with this registry — includes
   * servers that are stopped, failed, or not yet started.
   * Useful for the `mcp_control` tool to show all known servers without
   * triggering connections.
   */
  describe(): {
    name: string;
    state: ConnectionState;
    toolCount: number;
    enabled: boolean;
    tools: string[];
  }[] {
    const active = Array.from(this.servers.values()).map((s) => {
      const tools = this.toolNamesForSlot(s);
      return {
        name: s.cfg.name,
        state: s.state,
        toolCount: tools.length,
        enabled: s.cfg.enabled !== false,
        tools,
      };
    });
    const disabled = Array.from(this.disabledServers.values()).map((cfg) => ({
      name: cfg.name,
      state: 'idle' as const,
      toolCount: 0,
      enabled: false,
      tools: [],
    }));
    return [...active, ...disabled];
  }

  async stopAll(): Promise<void> {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = undefined;
    }
    for (const name of Array.from(this.servers.keys())) {
      await this.stop(name);
    }
    this.disabledServers.clear();
  }

  /**
   * Health check — returns 'ok' for connected servers, the current state otherwise.
   * For HTTP-based transports this could also ping the server.
   */
  health(): { name: string; alive: boolean; latencyMs?: number | undefined }[] {
    return Array.from(this.servers.values()).map((s) => ({
      name: s.cfg.name,
      alive: s.state === 'connected',
    }));
  }

  /**
   * L2-C: handle `notifications/tools/list_changed` from the server.
   * Unregister the previous wrapper set, then re-register the fresh
   * tool list. The client has already refreshed its cache before
   * dispatching — we just need to re-wrap and re-register.
   * In lazy mode, only update the internal cache without registering.
   */
  private readonly onToolsChanged = (name: string, _tools: { name: string }[]): void => {
    const slot = this.servers.get(name);
    if (!slot?.client) return;
    // Unregister any previously registered tools, then re-apply the fresh set.
    for (const t of slot.toolNames) {
      try {
        this.toolRegistry.unregister(t);
      } catch {
        /* ignore */
      }
    }
    slot.toolNames = [];
    slot.registeredLazy = false;
    const discovered = slot.client.listTools();
    // Refresh the lazy manifest so a future cold boot sees the new tool set.
    this.applyTools(slot, discovered, slot.client);
    void this.persistCapabilityManifest(slot);
    this.events.emit('mcp.server.connected', {
      name: slot.cfg.name,
      toolCount: slot.toolNames.length,
    });
    this.log.info(
      `MCP server "${slot.cfg.name}" tools refreshed (${this.toolNamesForSlot(slot).length} active)`,
    );
  };

  private readonly onResourcesChanged = (name: string): void => {
    const slot = this.servers.get(name);
    if (!slot) return;
    slot.resources = undefined;
    slot.resourceTemplates = undefined;
    void this.persistCapabilityManifest(slot);
    this.log.info(`MCP server "${name}" resource catalog invalidated`);
  };

  private readonly onPromptsChanged = (name: string): void => {
    const slot = this.servers.get(name);
    if (!slot) return;
    slot.prompts = undefined;
    void this.persistCapabilityManifest(slot);
    this.log.info(`MCP server "${name}" prompt catalog invalidated`);
  };

  private addCatalogListeners(client: MCPClient): void {
    client.addResourcesChangedListener(this.onResourcesChanged);
    client.addPromptsChangedListener(this.onPromptsChanged);
  }

  private removeCatalogListeners(client: MCPClient): void {
    client.removeResourcesChangedListener(this.onResourcesChanged);
    client.removePromptsChangedListener(this.onPromptsChanged);
  }

  private readonly onChildExit = (
    name: string,
    code: number | null,
    _signal: string | null,
  ): void => {
    const slot = this.servers.get(name);
    if (!slot) return;
    if (slot.lazy) {
      this.recordFailure(slot, 'transport', 'process-exit-lazy');
      markLazySlotDormant(slot, this.events, `exit:${code ?? 'unknown'}`);
      return;
    }
    resetDisconnectedSlotTools(slot, this.toolRegistry);
    slot.state = 'disconnected';
    this.recordFailure(slot, 'transport', 'process-exit');
    this.events.emit('mcp.server.disconnected', { name, reason: `exit:${code ?? 'unknown'}` });
    this.scheduleReconnect(slot);
  };

  /** Handles SSE / streamable-http disconnect — same recovery as stdio child exit. */
  private readonly onTransportDisconnect = (name: string): void => {
    const slot = this.servers.get(name);
    if (!slot) return;
    if (slot.lazy) {
      this.recordFailure(slot, 'transport', 'http-disconnect-lazy');
      markLazySlotDormant(slot, this.events, 'http-disconnect');
      return;
    }
    resetDisconnectedSlotTools(slot, this.toolRegistry);
    slot.state = 'disconnected';
    this.recordFailure(slot, 'transport', 'http-disconnect');
    this.events.emit('mcp.server.disconnected', { name, reason: 'http-disconnect' });
    this.scheduleReconnect(slot);
  };

  private static readonly MAX_RECONNECT_CYCLES = MCP_CONSTANTS.RECONNECT.MAX_CYCLES;
  private static readonly BASE_RECONNECT_DELAY_MS = MCP_CONSTANTS.RECONNECT.BASE_DELAY_MS;
  private static readonly MAX_RECONNECT_DELAY_MS = 30_000;

  private scheduleReconnect(slot: ServerSlot): void {
    scheduleRegistryReconnect({
      slot,
      events: this.events,
      log: this.log,
      maxReconnectCycles: MCPRegistry.MAX_RECONNECT_CYCLES,
      baseReconnectDelayMs: MCPRegistry.BASE_RECONNECT_DELAY_MS,
      maxReconnectDelayMs: MCPRegistry.MAX_RECONNECT_DELAY_MS,
      recordReconnectExhausted: (target) => this.recordFailure(target, 'transport', 'reconnect-exhausted'),
      attemptReconnect: (target) => this.attemptReconnect(target),
    });
  }

  private async attemptReconnect(slot: ServerSlot): Promise<void> {
    slot.reconnectPending = false;
    slot.reconnectCycles++;
    slot.operations.reconnectCount++;
    this.recordOperation(slot, 'reconnect', 'automatic');
    await this.attemptConnect(slot);
  }

  private recordSuccess(slot: ServerSlot, resetFailures = true): void {
    recordRegistrySuccess(slot, resetFailures);
  }

  private recordFailure(
    slot: ServerSlot,
    failureKind: MCPFailureKind,
    reason: string,
    durationMs?: number | undefined,
  ): void {
    recordRegistryFailure(slot, this.operationListeners, failureKind, reason, durationMs);
  }

  private recordOperation(
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

  private async attemptConnect(slot: ServerSlot): Promise<void> {
    const MAX_ATTEMPTS = MCP_CONSTANTS.RECONNECT.MAX_ATTEMPTS;
    let attempt = 0;
    while (attempt < MAX_ATTEMPTS) {
      if (this.servers.has(slot.cfg.name) && this.servers.get(slot.cfg.name) !== slot) {
        return;
      }
      attempt++;
      const startedAt = Date.now();
      slot.state = attempt === 1 ? 'connecting' : 'reconnecting';
      slot.attempts = attempt;
      let client: MCPClient | undefined;
      let boundDisconnect: (() => void) | undefined;
      try {
        client = new MCPClient({
          name: slot.cfg.name,
          transport: slot.cfg.transport,
          command: slot.cfg.command,
          args: slot.cfg.args,
          env: slot.cfg.env,
          url: slot.cfg.url,
          headers: slot.cfg.headers,
          startupTimeoutMs: slot.cfg.startupTimeoutMs,
          requestTimeoutMs: slot.cfg.requestTimeoutMs,
          passthroughEnv: slot.cfg.passthroughEnv,
          authorizationProvider: this.authorizationProviderFactory?.(slot.cfg),
        });
        if (slot.cfg.transport === 'stdio') {
          client.addExitListener(this.onChildExit);
        } else {
          // SSE / streamable-http — wire transport disconnect to registry reconnect.
          // Capture the bound function so we can hand the same reference to
          // removeDisconnectListener on cleanup paths.
          boundDisconnect = () => this.onTransportDisconnect(slot.cfg.name);
          client.addDisconnectListener(boundDisconnect);
        }
        // L2-C: react to server-side tool changes by re-registering wrappers.
        client.addToolsChangedListener(this.onToolsChanged);
        this.addCatalogListeners(client);
        await client.connect();
        if (
          (slot.state as ConnectionState) === 'disconnected' ||
          (this.servers.has(slot.cfg.name) && this.servers.get(slot.cfg.name) !== slot)
        ) {
          client.removeExitListener(this.onChildExit);
          if (boundDisconnect) client.removeDisconnectListener(boundDisconnect);
          client.removeToolsChangedListener(this.onToolsChanged);
          this.removeCatalogListeners(client);
          await client.close().catch(() => {});
          return;
        }
        // Close any prior client before swapping refs so the old transport
        // can release its abort controller, child process, and listeners
        // instead of being held until GC.
        if (slot.client && slot.client !== client) {
          const prior = slot.client;
          const priorDisconnect = slot.onDisconnect;
          slot.client.removeExitListener(this.onChildExit);
          if (priorDisconnect) prior.removeDisconnectListener(priorDisconnect);
          prior.removeToolsChangedListener(this.onToolsChanged);
          this.removeCatalogListeners(prior);
          prior.close().catch(() => {
            /* best-effort */
          });
        }
        slot.client = client;
        slot.onDisconnect = boundDisconnect;
        const isReconnect = slot.reconnectCycles > 0 || attempt > 1;
        slot.state = 'connected';
        // L2-B: a healthy connect resets the cycle counter so future
        // crashes get the full reconnect budget again.
        slot.reconnectCycles = 0;
        const mc = client as MCPClient;
        const discovered = mc.listTools();
        await this.discoverCapabilities(slot, mc);
        // Lazy servers persist their manifest so later boots can register cold.
        await this.persistCapabilityManifest(slot);
        this.applyTools(slot, discovered, mc);
        const durationMs = Date.now() - startedAt;
        pushBounded(
          slot.operations.connectionSamples,
          durationMs,
          MCP_OPERATION_LIMITS.LATENCY_SAMPLES,
        );
        this.recordSuccess(slot, (slot.operations.lastFailureAt ?? 0) < startedAt);
        this.recordOperation(
          slot,
          isReconnect ? 'reconnect' : 'connect',
          'connected',
          undefined,
          durationMs,
        );
        slot.lastUsed = Date.now();
        if (slot.lazy) this.ensureIdleSweep();
        this.events.emit(isReconnect ? 'mcp.server.reconnected' : 'mcp.server.connected', {
          name: slot.cfg.name,
          toolCount: slot.toolNames.length,
        });
        return; // success
      } catch (err) {
        this.recordFailure(slot, 'transport', 'connect-attempt-failed', Date.now() - startedAt);
        this.log.warn(`MCP server "${slot.cfg.name}" connect attempt ${attempt} failed`, err);
        if (client) {
          client.removeExitListener(this.onChildExit);
          if (boundDisconnect) client.removeDisconnectListener(boundDisconnect);
          client.removeToolsChangedListener(this.onToolsChanged);
          this.removeCatalogListeners(client);
          await client.close().catch(() => {
            /* ignore */
          });
        }
        if (attempt >= MAX_ATTEMPTS) {
          this.log.error(
            `MCP server "${slot.cfg.name}" connect exhausted after ${MAX_ATTEMPTS} attempts`,
            err,
          );
          slot.state = 'failed';
          slot.client = undefined;
          // The connect() loop itself doesn't schedule a backoff timer (it
          // only awaits inline setTimeouts within the `while`), but a
          // prior `scheduleReconnect` cycle may have left one outstanding.
          // Drop it so the user can `restart()` without waiting on a stale
          // fire that would race the fresh `attemptConnect`.
          if (slot.reconnectTimer) {
            clearTimeout(slot.reconnectTimer);
            slot.reconnectTimer = undefined;
          }
          slot.reconnectPending = false;
          this.events.emit('mcp.server.disconnected', {
            name: slot.cfg.name,
            reason: err instanceof Error ? err.message : 'unknown',
          });
          return;
        }
        const delay = 500 * 2 ** attempt;
        await new Promise((r) => setTimeout(r, delay));
        if (
          (slot.state as ConnectionState) === 'disconnected' ||
          (this.servers.has(slot.cfg.name) && this.servers.get(slot.cfg.name) !== slot)
        ) {
          return;
        }
      }
    }
  }
}
