import type { MCPServerConfig } from '@wrongstack/contracts/types';
import type {
  MCPAuthorizationLoginHandle,
  MCPAuthorizationLoginInput,
  MCPAuthorizationStartResult,
  MCPAuthorizationStatus,
} from './authorization-manager.js';
import type { MCPClient } from './client.js';
import type {
  MCPInsertionPolicy,
  MCPPromptInsertion,
  MCPResourceInsertion,
} from './content-selection.js';
import type { MCPOperationListener, MCPServerOperationalHealth } from './operations.js';
import type {
  MCPGetPromptResult,
  MCPPrompt,
  MCPReadResourceResult,
  MCPResource,
  MCPResourceTemplate,
} from './protocol.js';
import {
  beginRegistryAuthorization,
  completeRegistryAuthorization,
  loginRegistryAuthorization,
  type MCPRegistryAuthorizationBeginInput,
  requireAuthorizationManager,
  requireHttpServerConfig,
} from './registry-authorization.js';
import {
  getCatalog as getCatalogFromHost,
  getPrompt as getPromptFromHost,
  listPrompts as listPromptsFromHost,
  listResources as listResourcesFromHost,
  listResourceTemplates as listResourceTemplatesFromHost,
  readResource as readResourceFromHost,
  selectPromptForInsertion as selectPromptForInsertionFromHost,
  selectResourceForInsertion as selectResourceForInsertionFromHost,
  subscribeResource as subscribeResourceFromHost,
  unsubscribeResource as unsubscribeResourceFromHost,
} from './registry-catalog-operations.js';
import {
  describeServers,
  describeSlotTools,
  listServers,
  type MCPDescribedTool,
  serverHealth,
} from './registry-describe.js';
import { buildRegistryOperationalHealth } from './registry-health.js';
import { MCPRegistryRuntime } from './registry-runtime.js';
import {
  activateServer as activateServerFromHost,
  deactivateServer as deactivateServerFromHost,
  ensureConnected as ensureConnectedFromHost,
  restart as restartFromHost,
  sleep as sleepFromHost,
  start as startFromHost,
  stop as stopFromHost,
} from './registry-server-lifecycle.js';
import type { MCPRegistryCatalog } from './registry-types.js';
import type { MCPTaskContext as AgentContext } from './task-identity.js';

export type { MCPDescribedTool } from './registry-describe.js';
export type { MCPRegistryCatalog, MCPRegistryOptions } from './registry-types.js';

export class MCPRegistry extends MCPRegistryRuntime {
  async loginAuthorization(
    name: string,
    input: Omit<MCPAuthorizationLoginInput, 'serverName' | 'resource'>,
  ): Promise<MCPAuthorizationLoginHandle> {
    const cfg = this.requireHttpServerConfig(name);
    return loginRegistryAuthorization(this.authorizationManager, cfg, name, input);
  }

  async beginAuthorization(
    name: string,
    input: MCPRegistryAuthorizationBeginInput,
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
    return completeRegistryAuthorization(this.authorizationManager, cfg, name, callbackUrl, signal);
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
    return startFromHost(this.internals(), cfg);
  }

  /**
   * Resolves once every start already in flight has connected or failed. A
   * host that starts its servers in the background and then runs a single
   * turn waits here, so the turn's tool list includes theirs.
   */
  async whenStarted(): Promise<void> {
    while (this.startups.size > 0) await Promise.all([...this.startups]);
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
   * Ensure a lazy server is connected, spawning it on demand. Single-flight:
   * concurrent first-calls share one connect. Resolver wrappers call this.
   */
  async ensureConnected(name: string): Promise<MCPClient> {
    return ensureConnectedFromHost(this.internals(), name);
  }

  /**
   * Register all cached tools for a given server into the tool registry.
   * No-op if tools are already registered or the server is not connected.
   * The server connection stays alive — this only toggles tool visibility.
   */
  activateServer(name: string): void {
    activateServerFromHost(this.internals(), name);
  }

  /**
   * Unregister all tools for a given server from the tool registry.
   * The server connection stays alive — this only toggles tool visibility.
   * Returns the number of tools that were deactivated.
   */
  deactivateServer(name: string): number {
    return deactivateServerFromHost(this.internals(), name);
  }

  /**
   * The tools a server offers — bare names, descriptions and input schemas —
   * without activating, registering or waking it. In token-saving mode the
   * model reaches MCP only through `mcp_use`, which needs the bare tool name
   * and its input shape; before this there was no way to learn either short
   * of guessing and reading the error. Honors `allowedTools`. Returns
   * `undefined` for an unknown server, `[]` when nothing was discovered yet.
   */
  describeTools(name: string): MCPDescribedTool[] | undefined {
    const slot = this.servers.get(name);
    if (!slot) return undefined;
    return describeSlotTools(slot);
  }

  /**
   * Check whether a server's tools are currently registered.
   */
  isActivated(name: string): boolean {
    const slot = this.servers.get(name);
    return slot ? slot.toolNames.length > 0 : false;
  }

  async stop(name: string): Promise<void> {
    this.taskRecovery?.pauseServer(name);
    return stopFromHost(this.internals(), name);
  }

  /**
   * Stop and start a registered server. Pass `nextCfg` to apply an edited
   * configuration: without it the slot reconnects with the config it was
   * started with, so an update/enable routed through restart() silently kept
   * the old command, url, env, permission and lazy flag until the next boot.
   */
  /**
   * Put a running server to sleep while keeping its configuration enabled.
   *
   * A lazy server goes `dormant`: the process stops but its tools stay
   * registered and the next call wakes it. Surfaces previously used stop() for
   * this, which unregistered a lazy server's tools — "sleep" silently became
   * "unreachable until restarted". Eager servers have no dormant state, so
   * for them sleep is a stop.
   */
  async sleep(name: string): Promise<void> {
    return sleepFromHost(this.internals(), name);
  }

  async restart(name: string, nextCfg?: MCPServerConfig | undefined): Promise<void> {
    return restartFromHost(this.internals(), name, nextCfg);
  }

  list(): ReturnType<typeof listServers> {
    return listServers(this.servers);
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
    return getCatalogFromHost.call(this.internals(), name);
  }

  async listResources(name: string, opts: { refresh?: boolean } = {}): Promise<MCPResource[]> {
    return listResourcesFromHost.call(this.internals(), name, opts);
  }

  async listResourceTemplates(
    name: string,
    opts: { refresh?: boolean } = {},
  ): Promise<MCPResourceTemplate[]> {
    return listResourceTemplatesFromHost.call(this.internals(), name, opts);
  }

  async readResource(name: string, uri: string): Promise<MCPReadResourceResult> {
    return readResourceFromHost.call(this.internals(), name, uri);
  }

  async selectResourceForInsertion(
    name: string,
    uri: string,
    policy?: MCPInsertionPolicy | undefined,
  ): Promise<MCPResourceInsertion> {
    return selectResourceForInsertionFromHost.call(this.internals(), name, uri, policy);
  }

  async subscribeResource(name: string, uri: string): Promise<void> {
    return subscribeResourceFromHost.call(this.internals(), name, uri);
  }

  async unsubscribeResource(name: string, uri: string): Promise<void> {
    return unsubscribeResourceFromHost.call(this.internals(), name, uri);
  }

  async listPrompts(name: string, opts: { refresh?: boolean } = {}): Promise<MCPPrompt[]> {
    return listPromptsFromHost.call(this.internals(), name, opts);
  }

  async getPrompt(
    serverName: string,
    promptName: string,
    args?: Record<string, string> | undefined,
  ): Promise<MCPGetPromptResult> {
    return getPromptFromHost.call(this.internals(), serverName, promptName, args);
  }

  async selectPromptForInsertion(
    serverName: string,
    promptName: string,
    args?: Record<string, string> | undefined,
    policy?: MCPInsertionPolicy | undefined,
  ): Promise<MCPPromptInsertion> {
    return selectPromptForInsertionFromHost.call(
      this.internals(),
      serverName,
      promptName,
      args,
      policy,
    );
  }

  /**
   * Catalog of every server ever registered with this registry — includes
   * servers that are stopped, failed, or not yet started.
   * Useful for the `mcp_control` tool to show all known servers without
   * triggering connections.
   */
  describe(): ReturnType<typeof describeServers> {
    return describeServers(this.servers, this.disabledServers);
  }

  async stopAll(): Promise<void> {
    this.taskRecovery?.dispose();
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = undefined;
    }
    const names = Array.from(this.servers.keys());
    await Promise.all(
      names.map(async (name) => {
        try {
          await this.stop(name);
        } catch (err) {
          this.log.warn(`MCP server "${name}" failed to stop during stopAll`, err);
        }
      }),
    );
    this.disabledServers.clear();
    await this.taskRecovery?.drain();
  }

  setTaskRecoveryContext(provider: (() => AgentContext | undefined) | undefined): void {
    this.taskRecovery?.setContextProvider(provider);
  }
  async recoverTasks(context: AgentContext) {
    return this.taskRecovery?.recover(context) ?? [];
  }
  async listTasks(context: AgentContext) {
    return this.taskRecovery?.list(context) ?? [];
  }
  async subscribeTasks(
    context: AgentContext,
    changed: () => void,
    closed: () => void = () => {},
  ): Promise<() => void> {
    if (!this.taskRecovery) throw new Error('MCP task journal is not available');
    return this.taskRecovery.subscribe(context, changed, closed);
  }
  async retryTask(context: AgentContext, id: string) {
    return this.taskRecovery?.retry(context, id) ?? 'unavailable';
  }
  async cancelTask(context: AgentContext, id: string): Promise<void> {
    if (!this.taskRecovery) throw new Error('MCP task journal is not available');
    await this.taskRecovery.cancel(context, id);
  }

  /**
   * Health check — returns 'ok' for connected servers, the current state otherwise.
   * For HTTP-based transports this could also ping the server.
   */
  health(): ReturnType<typeof serverHealth> {
    return serverHealth(this.servers);
  }
}
