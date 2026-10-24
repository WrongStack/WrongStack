import type { EventBus } from '@wrongstack/contracts/kernel';
import type { Logger, MCPServerConfig } from '@wrongstack/contracts/types';
import type { ToolRegistry } from '@wrongstack/core/registry';
import { expectDefined } from '@wrongstack/core/utils';
import type { MCPClient } from './client.js';
import type { MCPTool } from './contracts.js';
import { manifestConfigHash, readCapabilityManifest } from './manifest-cache.js';
import {
  createMCPServerOperationState,
  type MCPFailureKind,
  type MCPOperationKind,
} from './operations.js';
import { resetDisconnectedSlotTools } from './registry-disconnect.js';
import { type RegistryIdleContext, sleepIdleSlot } from './registry-idle.js';
import type { ServerSlot } from './registry-slots.js';
export interface RegistryServerLifecycleHost {
  servers: Map<string, ServerSlot>;
  stop(name: string): Promise<void>;
  markDisabled(cfg: MCPServerConfig): void;
  disabledServers: Map<string, MCPServerConfig>;
  cacheDir: string | undefined;
  startLazy(slot: ServerSlot): Promise<void>;
  singleFlightConnect(slot: ServerSlot): Promise<MCPClient | undefined>;
  startups: Set<Promise<void>>;
  applyTools(slot: ServerSlot, tools: MCPTool[], client?: MCPClient | undefined): void;
  ensureIdleSweep(): void;
  log: Logger;
  attemptConnect(slot: ServerSlot): Promise<void>;
  recordOperation(
    slot: ServerSlot,
    kind: MCPOperationKind,
    reason?: string | undefined,
    failureKind?: MCPFailureKind | undefined,
    durationMs?: number | undefined,
    retain?: boolean,
  ): void;
  toolRegistry: ToolRegistry;
  onChildExit: (name: string, code: number | null, _signal: string | null) => void;
  onToolsChanged: (name: string, _tools: { name: string }[]) => void;
  removeCatalogListeners(client: MCPClient): void;
  events: EventBus;
  requireSlot(name: string): ServerSlot;
  idleContext(): RegistryIdleContext;
}

export async function start(
  host: RegistryServerLifecycleHost,
  cfg: MCPServerConfig,
): Promise<void> {
  if (cfg.enabled === false) {
    if (host.servers.has(cfg.name)) {
      await host.stop(cfg.name);
    }
    host.markDisabled(cfg);
    return;
  }
  host.disabledServers.delete(cfg.name);
  // Reject duplicate registrations explicitly. Without this, calling
  // start() twice with the same name would overwrite the slot in
  // `this.servers` and orphan the previous slot's client (still
  // connected, with listeners wired into a slot that's no longer
  // reachable from the registry). Callers that want a clean re-start
  // should use `restart(name)`.
  if (host.servers.has(cfg.name)) {
    throw new Error(
      `MCP server "${cfg.name}" is already registered — use restart() to re-cycle a running server`,
    );
  }
  // Lazy-connect requires a manifest cache dir to register tools cold.
  const lazy = !!cfg.lazy && !!host.cacheDir;
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
  host.servers.set(cfg.name, slot);
  const startup = lazy ? host.startLazy(slot) : host.singleFlightConnect(slot);
  const settled = startup.then(
    () => {},
    () => {},
  );
  host.startups.add(settled);
  void settled.finally(() => host.startups.delete(settled));
  await startup;
}

export async function startLazy(
  host: RegistryServerLifecycleHost,
  slot: ServerSlot,
): Promise<void> {
  // start() only marks a slot lazy when a cache directory is configured.
  const cacheDir = expectDefined(host.cacheDir);
  const hash = manifestConfigHash(slot.cfg);
  const generation = slot.startupGeneration;
  const cached = await readCapabilityManifest(cacheDir, slot.cfg.name, hash);
  if (host.servers.get(slot.cfg.name) !== slot || slot.startupGeneration !== generation) return;
  if (cached) {
    slot.serverMetadata = cached.serverMetadata;
    slot.resources = cached.resources;
    slot.resourceTemplates = cached.resourceTemplates;
    slot.prompts = cached.prompts;
    host.applyTools(slot, cached.tools);
    slot.state = 'dormant';
    host.ensureIdleSweep();
    host.log.info(
      `MCP server "${slot.cfg.name}" registered lazily from cache (${cached.tools.length} tools, dormant)`,
    );
    return;
  }
  // No cache — must connect once to discover the tool list, then it stays
  // connected and becomes eligible for idle auto-sleep.
  await host.singleFlightConnect(slot);
}

export function singleFlightConnect(
  host: RegistryServerLifecycleHost,
  slot: ServerSlot,
): Promise<MCPClient | undefined> {
  if (slot.client && slot.state === 'connected') return Promise.resolve(slot.client);
  if (slot.connecting) return slot.connecting;

  const generation = slot.startupGeneration;
  const promise = host
    .attemptConnect(slot)
    .then(() => (slot.startupGeneration === generation ? slot.client : undefined));
  slot.connecting = promise;
  const clearFlight = () => {
    // A stop/restart can install another flight before this one settles.
    if (slot.connecting === promise) slot.connecting = undefined;
  };
  void promise.then(clearFlight, clearFlight);

  return promise;
}

export async function ensureConnected(
  host: RegistryServerLifecycleHost,
  name: string,
): Promise<MCPClient> {
  const slot = host.servers.get(name);
  if (!slot) throw new Error(`MCP server "${name}" not registered`);
  slot.lastUsed = Date.now();
  if (slot.client && slot.state === 'connected') return slot.client;
  const waking = slot.state === 'dormant' && !slot.connecting;
  if (waking) {
    slot.operations.wakeCount++;
    host.recordOperation(slot, 'wake', 'lazy-demand');
    slot.attempts = 0;
    slot.reconnectCycles = 0;
  }
  const client = await host.singleFlightConnect(slot);
  if (!client) {
    // The connect loop swallows its failure (a bad server must not reject
    // `start()`), so this wrapper is the caller's only chance to learn WHY. A
    // protocol-version refusal names the revision the server insisted on —
    // exactly the detail a generic message hides — so rethrow that error as-is
    // and keep it matchable by type downstream.
    const refusal = slot.protocolVersionRefusal;
    if (refusal) throw refusal;
    throw new Error(`MCP server "${name}" failed to connect on demand`);
  }
  slot.lastUsed = Date.now();
  host.ensureIdleSweep();
  return client;
}

export function activateServer(host: RegistryServerLifecycleHost, name: string): void {
  const slot = host.servers.get(name);
  if (!slot) return;
  // A dormant lazy server has no client yet — its resolver wrappers connect on
  // demand, so it can still be activated (registered) without a live process.
  if (!slot.client && !slot.lazy) return;
  if (slot.toolNames.length > 0) return; // already active
  const cached = slot.lazyTools;
  if (cached.length === 0) return;
  for (const tool of cached) {
    try {
      host.toolRegistry.register(tool, `mcp:${name}`);
      slot.toolNames.push(tool.name);
    } catch (err) {
      host.log.warn(`MCP tool "${tool.name}" activate failed`, err);
    }
  }
  // Visibility only — no connection changed, so no `mcp.server.connected`:
  // that event drove a "connected" toast and the connects counter on every
  // ephemeral `mcp_use` call.
  host.log.info(`MCP server "${name}" activated (${slot.toolNames.length} tools)`);
}

export function deactivateServer(host: RegistryServerLifecycleHost, name: string): number {
  const slot = host.servers.get(name);
  if (!slot) return 0;
  const count = slot.toolNames.length;
  if (count === 0) return 0;
  for (const t of slot.toolNames) {
    try {
      host.toolRegistry.unregister(t);
    } catch {
      /* ignore */
    }
  }
  slot.toolNames = [];
  // The connection stays up: emitting `mcp.server.disconnected` here flipped
  // the WebUI row to an error state with a warning toast after every call.
  host.log.info(`MCP server "${name}" deactivated (${count} tools removed)`);
  return count;
}

export async function stop(host: RegistryServerLifecycleHost, name: string): Promise<void> {
  const slot = host.servers.get(name);
  if (!slot) return;
  slot.startupGeneration = (slot.startupGeneration ?? 0) + 1;
  slot.reconnectPending = false;
  // Cancel the pending backoff timer. Without this, a disconnect scheduled
  // for reconnection would fire its `attemptReconnect` callback after the
  // slot has been torn down and respawn the server we just told to stop.
  if (slot.reconnectTimer) {
    clearTimeout(slot.reconnectTimer);
    slot.reconnectTimer = undefined;
  }
  slot.state = 'disconnected';
  // Drain until the slot is EMPTY, because a demand-wake can install a FRESH
  // client while every `close()` below is pending — lazy tool calls resolve
  // their client through `ensureConnected` (registry-connect-loop.ts:77), and
  // while this await runs both single-flight guards are inert (`state` is not
  // 'connected' and this method never sets `connecting`). A bounded pass
  // count only relocates the window: a wake landing in the LAST pass's close
  // survives `stop()` with `slot.client` set and its client never closed —
  // the single-flight and final-window suites pin exactly that postcondition.
  // So the loop keeps closing whatever a wake installs — `stop()` is the
  // later intent — until nothing is left to close. Detaching `client`/
  // `onDisconnect` BEFORE awaiting — the ordering `sleepIdleSlot` already
  // uses — keeps a wake from reusing the closing client; clearing those
  // fields only after the await instead would drop the replacement's only
  // reference: a live client and its child process that no later stop(),
  // idle sweep or disconnect can reach, with a disconnect listener nothing
  // can detach.
  while (slot.client) {
    const client = slot.client;
    slot.client = undefined;
    const handler = slot.onDisconnect;
    slot.onDisconnect = undefined;
    client.removeExitListener?.(host.onChildExit);
    if (handler) client.removeDisconnectListener?.(handler);
    client.removeToolsChangedListener?.(host.onToolsChanged);
    host.removeCatalogListeners(client);
    try {
      await client.close?.();
    } catch (err) {
      host.log.warn(`MCP server "${name}" error during stop close`, err);
    }
    slot.state = 'disconnected';
  }
  slot.connecting = undefined;
  resetDisconnectedSlotTools(slot, host.toolRegistry);
  // Full teardown — a future start()/restart() re-registers lazy wrappers.
  slot.registeredLazy = false;
  host.recordOperation(slot, 'stop', 'manual');
  host.events.emit('mcp.server.disconnected', { name, reason: 'stop' });
}

export async function sleep(host: RegistryServerLifecycleHost, name: string): Promise<void> {
  const slot = host.requireSlot(name);
  if (!slot.lazy) {
    await host.stop(name);
    return;
  }
  if (slot.state === 'dormant') return;
  if (slot.operations.inFlightCalls > 0) {
    throw new Error(`MCP server "${name}" has requests in flight — try again when they finish`);
  }
  await sleepIdleSlot(host.idleContext(), slot);
}

export async function restart(
  host: RegistryServerLifecycleHost,
  name: string,
  nextCfg?: MCPServerConfig | undefined,
): Promise<void> {
  const slot = host.servers.get(name);
  if (!slot) throw new Error(`MCP server "${name}" not registered`);
  if (nextCfg && nextCfg.name !== name) {
    throw new Error(`MCP restart config names "${nextCfg.name}", expected "${name}"`);
  }
  if (nextCfg?.enabled === false) {
    await host.stop(name);
    host.markDisabled(nextCfg);
    return;
  }
  slot.operations.restartCount++;
  host.recordOperation(slot, 'restart', 'manual');
  await host.stop(name);
  if (nextCfg) {
    slot.cfg = nextCfg;
    slot.lazy = !!nextCfg.lazy && !!host.cacheDir;
    slot.discoveredTools = undefined;
  }
  slot.attempts = 0;
  slot.reconnectCycles = 0; // user intent: start fresh
  if (slot.lazy) {
    await host.startLazy(slot);
  } else {
    await host.singleFlightConnect(slot);
  }
}
