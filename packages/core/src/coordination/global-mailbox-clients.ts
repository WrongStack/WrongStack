import { withFileLock } from '../utils/atomic-write.js';
import {
  CLIENT_STALE_MS,
  HEARTBEAT_THROTTLE_MS,
} from './mailbox-constants.js';
import { mapRegisteredClientsToStatuses } from './mailbox-status-mappers.js';
import type {
  ClientHeartbeatInput,
  ClientRegistrationInput,
  ClientStatus,
  RegisteredClient,
} from './mailbox-types.js';

export interface GlobalMailboxClientRegistryContext {
  readonly clientRegistryPath: string;
  readonly lastClientHeartbeat: Map<string, number>;
  ensureClientRegistry(): Promise<void>;
  readClientRegistry(opts?: { fresh?: boolean }): Promise<Map<string, RegisteredClient>>;
  writeClientRegistry(registry: Map<string, RegisteredClient>): Promise<void>;
  pruneStaleClientsInPlace(registry: Map<string, RegisteredClient>): void;
  pruneHeartbeatThrottleMap(
    throttleMap: Map<string, number>,
    registry: ReadonlyMap<string, unknown>,
  ): void;
  setClientRegistryCache(registry: Map<string, RegisteredClient>): void;
  emitClientEvent(event: string, payload: Record<string, unknown>): void;
  publishHqMailboxSnapshot(): void;
}

export async function registerMailboxClient(
  ctx: GlobalMailboxClientRegistryContext,
  input: ClientRegistrationInput,
): Promise<void> {
  await ctx.ensureClientRegistry();
  const now = new Date().toISOString();
  const client: RegisteredClient = {
    clientId: input.clientId,
    sessionId: input.sessionId,
    name: input.name,
    source: input.source,
    registeredAt: now,
    lastSeenAt: now,
    pid: input.pid ?? process.pid,
  };

  await withFileLock(ctx.clientRegistryPath, async () => {
    const registry = await ctx.readClientRegistry({ fresh: true });
    ctx.pruneStaleClientsInPlace(registry);
    ctx.pruneHeartbeatThrottleMap(ctx.lastClientHeartbeat, registry);
    registry.set(input.clientId, client);
    ctx.setClientRegistryCache(registry);
    await ctx.writeClientRegistry(registry);
  });

  ctx.emitClientEvent('mailbox.client_registered', {
    clientId: input.clientId,
    sessionId: input.sessionId,
    name: input.name,
    source: input.source,
  });
  ctx.publishHqMailboxSnapshot();
}

export async function deregisterMailboxClient(
  ctx: GlobalMailboxClientRegistryContext,
  clientId: string,
): Promise<void> {
  await ctx.ensureClientRegistry();
  await withFileLock(ctx.clientRegistryPath, async () => {
    const registry = await ctx.readClientRegistry({ fresh: true });
    ctx.pruneStaleClientsInPlace(registry);
    ctx.pruneHeartbeatThrottleMap(ctx.lastClientHeartbeat, registry);
    registry.delete(clientId);
    ctx.setClientRegistryCache(registry);
    await ctx.writeClientRegistry(registry);
  });
  ctx.lastClientHeartbeat.delete(clientId);
  ctx.emitClientEvent('mailbox.client_deregistered', { clientId });
  ctx.publishHqMailboxSnapshot();
}

export async function heartbeatMailboxClient(
  ctx: GlobalMailboxClientRegistryContext,
  input: ClientHeartbeatInput,
): Promise<void> {
  const last = ctx.lastClientHeartbeat.get(input.clientId) ?? 0;
  const now = Date.now();
  if (now - last < HEARTBEAT_THROTTLE_MS) return;

  ctx.lastClientHeartbeat.set(input.clientId, now);

  await ctx.ensureClientRegistry();

  await withFileLock(ctx.clientRegistryPath, async () => {
    const registry = await ctx.readClientRegistry({ fresh: true });
    ctx.pruneStaleClientsInPlace(registry);
    ctx.pruneHeartbeatThrottleMap(ctx.lastClientHeartbeat, registry);

    const client = registry.get(input.clientId);
    if (client) {
      client.lastSeenAt = new Date().toISOString();
      if (typeof input.sessionId === 'string' && input.sessionId.length > 0) {
        client.sessionId = input.sessionId;
      }
    }

    ctx.setClientRegistryCache(registry);
    await ctx.writeClientRegistry(registry);
  });

  ctx.emitClientEvent('mailbox.client_heartbeat', {
    clientId: input.clientId,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
  });
  ctx.publishHqMailboxSnapshot();
}

export async function getMailboxClientStatuses(
  ctx: GlobalMailboxClientRegistryContext,
): Promise<ClientStatus[]> {
  await ctx.ensureClientRegistry();
  let registry = await ctx.readClientRegistry();
  const before = registry.size;
  ctx.pruneStaleClientsInPlace(registry);

  if (registry.size < before) {
    await withFileLock(ctx.clientRegistryPath, async () => {
      registry = await ctx.readClientRegistry({ fresh: true });
      const postLockBefore = registry.size;
      ctx.pruneStaleClientsInPlace(registry);
      if (registry.size < postLockBefore) {
        await ctx.writeClientRegistry(registry);
      }
    });
  }

  return mapRegisteredClientsToStatuses(registry, Date.now(), CLIENT_STALE_MS);
}

export async function purgeMailboxClients(
  ctx: GlobalMailboxClientRegistryContext,
): Promise<number> {
  await ctx.ensureClientRegistry();
  let purged = 0;
  await withFileLock(ctx.clientRegistryPath, async () => {
    const registry = await ctx.readClientRegistry({ fresh: true });
    const before = registry.size;
    ctx.pruneStaleClientsInPlace(registry);
    purged = before - registry.size;
    if (purged > 0) {
      ctx.setClientRegistryCache(registry);
      await ctx.writeClientRegistry(registry);
    }
  });
  return purged;
}
