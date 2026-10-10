import type { EventBus } from '@wrongstack/core/kernel';
import type { ToolRegistry } from '@wrongstack/core/registry';
import type { Logger } from '@wrongstack/core/types';
import { expectDefined } from '@wrongstack/core/utils';
import { MCPClient } from './client.js';
import { expandMcpEnvPlaceholders } from './config-env.js';
import { MCP_CONSTANTS, MCPUnsupportedProtocolVersionError } from './constants.js';
import type { ConnectionState, MCPTool } from './contracts.js';
import type { MCPClientElicitationHandler } from './elicitation.js';
import { manifestConfigHash, writeCapabilityManifest } from './manifest-cache.js';
import {
  MCP_OPERATION_LIMITS,
  type MCPFailureKind,
  type MCPOperationKind,
  type MCPOperationListener,
  pushBounded,
} from './operations.js';
import { collectCatalogPages } from './registry-catalog.js';
import type { ServerSlot } from './registry-slots.js';
import type { MCPRegistryOptions } from './registry-types.js';
import { wrapMCPTool } from './wrap-tool.js';

export interface RegistryConnectContext {
  servers: Map<string, ServerSlot>;
  toolRegistry: ToolRegistry;
  events: EventBus;
  log: Logger;
  lazyMode: boolean;
  cacheDir?: string | undefined;
  cwd?: string | undefined;
  authorizationProviderFactory?: MCPRegistryOptions['authorizationProviderFactory'] | undefined;
  elicitationHandler?: MCPRegistryOptions['elicitationHandler'] | undefined;
  operationListeners: Set<MCPOperationListener>;
  ensureConnected: (name: string) => Promise<MCPClient>;
  recordOperation: (
    slot: ServerSlot,
    kind: MCPOperationKind,
    reason?: string,
    failureKind?: MCPFailureKind,
    durationMs?: number,
    retain?: boolean,
  ) => void;
  recordSuccess: (slot: ServerSlot, resetFailures?: boolean) => void;
  recordFailure: (
    slot: ServerSlot,
    failureKind: MCPFailureKind,
    reason: string,
    durationMs?: number,
  ) => void;
  onChildExit: (name: string, code: number | null, signal: string | null) => void;
  onTransportDisconnect: (name: string) => void;
  onToolsChanged: (name: string, tools: { name: string }[]) => void;
  addCatalogListeners: (client: MCPClient) => void;
  removeCatalogListeners: (client: MCPClient) => void;
  ensureIdleSweep: () => void;
}

export function applySlotTools(
  ctx: RegistryConnectContext,
  slot: ServerSlot,
  tools: MCPTool[],
  client?: MCPClient | undefined,
): void {
  slot.discoveredTools = tools;
  const allowed = slot.cfg.allowedTools;
  const filtered = tools.filter((t) => !allowed || allowed.includes(t.name));
  const signature = JSON.stringify(
    filtered.map((t) => [
      t.name,
      t.description ?? null,
      t.inputSchema ?? null,
      t.outputSchema ?? null,
    ]),
  );
  // Lazy wrappers resolve the live client on every call, so an unchanged tool
  // set needs no rebinding on wake. A CHANGED set must be re-registered — the
  // old early-return kept the manifest's stale schemas registered forever once
  // the server's real tool list moved on.
  const lazyWrappersCurrent =
    slot.lazy &&
    slot.toolSignature === signature &&
    slot.lazyTools.length === filtered.length &&
    (slot.registeredLazy || ctx.lazyMode);
  if (lazyWrappersCurrent) return;
  const clientArg = slot.lazy ? () => ctx.ensureConnected(slot.cfg.name) : expectDefined(client);
  const wrapped = filtered.map((t) =>
    wrapMCPTool(
      slot.cfg.name,
      t,
      clientArg,
      slot.cfg.permission ?? 'confirm',
      slot.cfg.sandboxTrust === true,
      {
        onStart: (caller) => {
          if (caller) slot.activeCallers = [...(slot.activeCallers ?? []), caller];
          slot.operations.inFlightCalls++;
          slot.operations.peakInFlightCalls = Math.max(
            slot.operations.peakInFlightCalls,
            slot.operations.inFlightCalls,
          );
          ctx.recordOperation(slot, 'call', 'started', undefined, undefined, false);
        },
        onFinish: ({ durationMs, ok }, caller) => {
          const at = caller ? (slot.activeCallers?.lastIndexOf(caller) ?? -1) : -1;
          if (at >= 0) slot.activeCallers?.splice(at, 1);
          slot.operations.inFlightCalls = Math.max(0, slot.operations.inFlightCalls - 1);
          slot.lastUsed = Date.now();
          pushBounded(
            slot.operations.callSamples,
            durationMs,
            MCP_OPERATION_LIMITS.LATENCY_SAMPLES,
          );
          if (ok) {
            ctx.recordSuccess(slot);
            ctx.recordOperation(slot, 'call', 'ok', undefined, durationMs, false);
          } else {
            ctx.recordFailure(slot, 'tool', 'tool-call-failed', durationMs);
          }
        },
      },
    ),
  );
  slot.lazyTools = wrapped;
  slot.toolSignature = signature;
  // In lazyMode tools stay unregistered until activated — but a server that IS
  // activated right now must get the fresh set, not silently lose its tools.
  const wasActive = slot.toolNames.length > 0;
  if (ctx.lazyMode && !wasActive) return;
  for (const name of slot.toolNames) {
    try {
      ctx.toolRegistry.unregister(name);
    } catch {
      /* ignore */
    }
  }
  slot.toolNames = [];
  for (const tool of wrapped) {
    try {
      ctx.toolRegistry.register(tool, `mcp:${slot.cfg.name}`);
      slot.toolNames.push(tool.name);
    } catch (err) {
      ctx.log.warn(`MCP tool "${tool.name}" not registered`, err);
    }
  }
  if (slot.lazy && !ctx.lazyMode && wrapped.length > 0) slot.registeredLazy = true;
}

export async function discoverSlotCapabilities(
  ctx: RegistryConnectContext,
  slot: ServerSlot,
  client: MCPClient,
): Promise<void> {
  const startedAt = Date.now();
  const versions = { ...slot.catalogVersions };
  const serverMetadata = client.getServerMetadata();
  const capabilities = serverMetadata?.capabilities;
  let resources: ServerSlot['resources'];
  let resourceTemplates: ServerSlot['resourceTemplates'];
  let prompts: ServerSlot['prompts'];
  if (capabilities?.resources) {
    try {
      resources = await collectCatalogPages(
        (cursor) => client.listResources(cursor ? { cursor } : {}),
        (page) => page.resources,
      );
    } catch (err) {
      if (!ownsConnectedSlot(ctx, slot, client)) return;
      ctx.recordFailure(slot, 'protocol', 'resource-discovery-failed');
      ctx.log.warn(`MCP server "${slot.cfg.name}" resource discovery failed`, err);
    }
    if (!ownsConnectedSlot(ctx, slot, client)) return;
    try {
      resourceTemplates = await collectCatalogPages(
        (cursor) => client.listResourceTemplates(cursor ? { cursor } : {}),
        (page) => page.resourceTemplates,
      );
    } catch (err) {
      if (!ownsConnectedSlot(ctx, slot, client)) return;
      ctx.recordFailure(slot, 'protocol', 'resource-template-discovery-failed');
      ctx.log.warn(`MCP server "${slot.cfg.name}" resource template discovery failed`, err);
    }
  }
  if (!ownsConnectedSlot(ctx, slot, client)) return;
  if (capabilities?.prompts) {
    try {
      prompts = await collectCatalogPages(
        (cursor) => client.listPrompts(cursor ? { cursor } : {}),
        (page) => page.prompts,
      );
    } catch (err) {
      if (!ownsConnectedSlot(ctx, slot, client)) return;
      ctx.recordFailure(slot, 'protocol', 'prompt-discovery-failed');
      ctx.log.warn(`MCP server "${slot.cfg.name}" prompt discovery failed`, err);
    }
  }
  // Discovery can settle after stop, idle sleep, or replacement. Publish only
  // while this client still owns the connected slot.
  if (!ownsConnectedSlot(ctx, slot, client)) return;
  slot.serverMetadata = serverMetadata;
  if (slot.catalogVersions?.resources === versions.resources) slot.resources = resources;
  if (slot.catalogVersions?.resourceTemplates === versions.resourceTemplates) {
    slot.resourceTemplates = resourceTemplates;
  }
  if (slot.catalogVersions?.prompts === versions.prompts) slot.prompts = prompts;
  const durationMs = Date.now() - startedAt;
  pushBounded(slot.operations.discoverySamples, durationMs, MCP_OPERATION_LIMITS.LATENCY_SAMPLES);
  ctx.recordOperation(slot, 'discover', 'complete', undefined, durationMs, false);
}

function ownsConnectedSlot(
  ctx: RegistryConnectContext,
  slot: ServerSlot,
  client: MCPClient,
): boolean {
  return (
    ctx.servers.get(slot.cfg.name) === slot && slot.client === client && slot.state === 'connected'
  );
}

export async function persistSlotCapabilityManifest(
  cacheDir: string | undefined,
  slot: ServerSlot,
): Promise<void> {
  if (!slot.lazy || !cacheDir) return;
  const previous = slot.manifestWrite ?? Promise.resolve();
  const pending = previous.then(() => {
    const tools = slot.discoveredTools ?? slot.client?.listTools();
    // Nothing learned yet (no discovery, no live client): writing would
    // replace a good manifest with an empty tool list.
    if (!tools) return;
    return writeCapabilityManifest(cacheDir, slot.cfg.name, manifestConfigHash(slot.cfg), {
      tools,
      serverMetadata: slot.serverMetadata,
      resources: slot.resources,
      resourceTemplates: slot.resourceTemplates,
      prompts: slot.prompts,
    });
  });
  slot.manifestWrite = pending;
  await pending;
  if (slot.manifestWrite === pending) slot.manifestWrite = undefined;
}

/**
 * Base delay for the *within-cycle* connect retry loop (`500 * multiplier^attempt`).
 *
 * Deliberately separate from `RECONNECT.BASE_DELAY_MS`, which is the
 * *across-cycle* backoff base the registry scheduler uses — the two run on
 * different clocks (a failing spawn retries fast; a dropped server retries
 * less often as cycles accumulate).
 */
const CONNECT_ATTEMPT_BASE_MS = 500;

export async function attemptConnectSlot(
  ctx: RegistryConnectContext,
  slot: ServerSlot,
): Promise<void> {
  const MAX_ATTEMPTS = MCP_CONSTANTS.RECONNECT.MAX_ATTEMPTS;
  const BACKOFF_MULTIPLIER = MCP_CONSTANTS.RECONNECT.BACKOFF_MULTIPLIER;
  const generation = slot.startupGeneration;
  const isCurrent = () =>
    ctx.servers.get(slot.cfg.name) === slot && slot.startupGeneration === generation;
  // A refusal from an earlier cycle must not be blamed for this attempt's
  // failure, so start clean; the terminal branch below records a fresh one.
  slot.protocolVersionRefusal = undefined;
  let attempt = 0;
  while (attempt < MAX_ATTEMPTS) {
    // A slot removed (forget/markDisabled) or replaced must not keep spawning.
    if (!isCurrent()) {
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
        // `${VAR}` placeholders resolve here, per connect — never into the
        // stored config (see config-env.ts).
        ...expandMcpEnvPlaceholders(slot.cfg),
        bearerTokenEnv: slot.cfg.bearerTokenEnv,
        startupTimeoutMs: slot.cfg.startupTimeoutMs,
        requestTimeoutMs: slot.cfg.requestTimeoutMs,
        cwd: ctx.cwd,
        allowPrivateNetworks: slot.cfg.allowPrivateNetworks,
        passthroughEnv: slot.cfg.passthroughEnv,
        authorizationProvider: ctx.authorizationProviderFactory?.(slot.cfg),
        elicitation: slotElicitation(ctx, slot),
      });
      if (slot.cfg.transport === 'stdio') {
        client.addExitListener(ctx.onChildExit);
      } else {
        boundDisconnect = () => ctx.onTransportDisconnect(slot.cfg.name);
        client.addDisconnectListener(boundDisconnect);
      }
      client.addToolsChangedListener(ctx.onToolsChanged);
      ctx.addCatalogListeners(client);
      await client.connect();
      if ((slot.state as ConnectionState) === 'disconnected' || !isCurrent()) {
        client.removeExitListener(ctx.onChildExit);
        if (boundDisconnect) client.removeDisconnectListener(boundDisconnect);
        client.removeToolsChangedListener(ctx.onToolsChanged);
        ctx.removeCatalogListeners(client);
        await client.close().catch(() => {});
        return;
      }
      if (slot.client && slot.client !== client) {
        const prior = slot.client;
        const priorDisconnect = slot.onDisconnect;
        slot.client.removeExitListener(ctx.onChildExit);
        if (priorDisconnect) prior.removeDisconnectListener(priorDisconnect);
        prior.removeToolsChangedListener(ctx.onToolsChanged);
        ctx.removeCatalogListeners(prior);
        prior.close().catch(() => {});
      }
      slot.client = client;
      slot.onDisconnect = boundDisconnect;
      const isReconnect = slot.reconnectCycles > 0 || attempt > 1;
      slot.state = 'connected';
      slot.reconnectCycles = 0;
      const mc = client as MCPClient;
      const discovered = mc.listTools();
      // Record before persisting: the manifest must carry THIS connect's tool
      // list, not the one a dormant boot loaded from the previous cache.
      slot.discoveredTools = discovered;
      await discoverSlotCapabilities(ctx, slot, mc);
      if (!ownsConnectedSlot(ctx, slot, mc)) return;
      await persistSlotCapabilityManifest(ctx.cacheDir, slot);
      if (!ownsConnectedSlot(ctx, slot, mc)) return;
      // Notifications may refresh the catalog while discovery/cache I/O awaits.
      applySlotTools(ctx, slot, mc.listTools(), mc);
      const durationMs = Date.now() - startedAt;
      pushBounded(
        slot.operations.connectionSamples,
        durationMs,
        MCP_OPERATION_LIMITS.LATENCY_SAMPLES,
      );
      ctx.recordSuccess(slot, (slot.operations.lastFailureAt ?? 0) < startedAt);
      ctx.recordOperation(
        slot,
        isReconnect ? 'reconnect' : 'connect',
        'connected',
        undefined,
        durationMs,
      );
      slot.lastUsed = Date.now();
      if (slot.lazy) ctx.ensureIdleSweep();
      ctx.events.emit(isReconnect ? 'mcp.server.reconnected' : 'mcp.server.connected', {
        name: slot.cfg.name,
        toolCount: slot.toolNames.length,
      });
      return;
    } catch (err) {
      if (client) {
        client.removeExitListener(ctx.onChildExit);
        if (boundDisconnect) client.removeDisconnectListener(boundDisconnect);
        client.removeToolsChangedListener(ctx.onToolsChanged);
        ctx.removeCatalogListeners(client);
        await client.close().catch(() => {});
      }
      // Superseded work must not retry or mutate the replacement's health.
      if (!isCurrent() || (slot.state as ConnectionState) === 'disconnected') return;
      // A protocol-version refusal is deterministic: the same server answers the
      // same way on every retry, so the remaining attempts — and a fresh child
      // process per attempt on stdio — buy nothing. Fold it into the single
      // terminal path below rather than duplicating that cleanup.
      // Keep the typed error, not just "it failed": the demand-wake wrapper has
      // nothing else to report the refused revision with.
      const refusal = err instanceof MCPUnsupportedProtocolVersionError ? err : undefined;
      const terminal = refusal !== undefined;
      slot.protocolVersionRefusal = refusal;
      ctx.recordFailure(
        slot,
        terminal ? 'protocol' : 'transport',
        terminal ? 'unsupported-protocol-version' : 'connect-attempt-failed',
        Date.now() - startedAt,
      );
      if (!terminal) {
        ctx.log.warn(`MCP server "${slot.cfg.name}" connect attempt ${attempt} failed`, err);
      }
      if (terminal || attempt >= MAX_ATTEMPTS) {
        // Only say "exhausted N attempts" when N attempts actually ran; a
        // refusal stops at one and must not claim otherwise.
        ctx.log.error(
          terminal
            ? `MCP server "${slot.cfg.name}" will not speak a protocol revision we implement — not retrying`
            : `MCP server "${slot.cfg.name}" connect exhausted after ${MAX_ATTEMPTS} attempts`,
          err,
        );
        slot.state = 'failed';
        slot.client = undefined;
        if (slot.reconnectTimer) {
          clearTimeout(slot.reconnectTimer);
          slot.reconnectTimer = undefined;
        }
        slot.reconnectPending = false;
        ctx.events.emit('mcp.server.disconnected', {
          name: slot.cfg.name,
          reason: err instanceof Error ? err.message : 'unknown',
          terminal: true,
        });
        return;
      }
      const delay = CONNECT_ATTEMPT_BASE_MS * BACKOFF_MULTIPLIER ** attempt;
      await new Promise((r) => setTimeout(r, delay));
      if ((slot.state as ConnectionState) === 'disconnected' || !isCurrent()) {
        return;
      }
    }
  }
}

/** The registry's elicitation handler, bound to one server and its newest caller. */
function slotElicitation(
  ctx: RegistryConnectContext,
  slot: ServerSlot,
): MCPClientElicitationHandler | undefined {
  const handler = ctx.elicitationHandler;
  if (!handler) return undefined;
  return (form) =>
    handler({ ...form, server: slot.cfg.name, requester: slot.activeCallers?.at(-1) });
}
