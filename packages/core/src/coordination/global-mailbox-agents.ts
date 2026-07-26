import type { HqPublisher } from '../hq/publisher.js';
import { withFileLock } from '../utils/atomic-write.js';
import {
  AGENT_STALE_MS,
  HEARTBEAT_THROTTLE_MS,
} from './mailbox-constants.js';
import { mapRegisteredAgentsToStatuses } from './mailbox-status-mappers.js';
import type {
  AgentHeartbeatInput,
  AgentRegistrationInput,
  MailboxAgentStatus,
  RegisteredAgent,
} from './mailbox-types.js';

export interface GlobalMailboxAgentRegistryContext {
  readonly registryPath: string;
  readonly hqMailboxId: string;
  readonly lastHeartbeat: Map<string, number>;
  ensureRegistry(): Promise<void>;
  readRegistry(opts?: { fresh?: boolean }): Promise<Map<string, RegisteredAgent>>;
  writeRegistry(registry: Map<string, RegisteredAgent>): Promise<void>;
  pruneStaleInPlace(registry: Map<string, RegisteredAgent>): void;
  pruneHeartbeatThrottleMap(
    throttleMap: Map<string, number>,
    registry: ReadonlyMap<string, unknown>,
  ): void;
  setRegistryCache(registry: Map<string, RegisteredAgent>): void;
  emitAgentEvent(event: string, payload: Record<string, unknown>): void;
  publishHqMailboxEvent(input: Parameters<HqPublisher['publishMailboxEvent']>[0]): void;
  publishHqMailboxSnapshot(): void;
}

export async function registerMailboxAgent(
  ctx: GlobalMailboxAgentRegistryContext,
  input: AgentRegistrationInput,
): Promise<void> {
  await ctx.ensureRegistry();
  const now = new Date().toISOString();
  const agent: RegisteredAgent = {
    agentId: input.agentId,
    sessionId: input.sessionId,
    name: input.name,
    role: input.role,
    status: 'idle',
    currentTool: undefined,
    currentTask: undefined,
    iterations: 0,
    toolCalls: 0,
    registeredAt: now,
    lastSeenAt: now,
    pid: input.pid ?? process.pid,
    source: input.source,
  };

  await withFileLock(ctx.registryPath, async () => {
    const registry = await ctx.readRegistry({ fresh: true });
    ctx.pruneStaleInPlace(registry);
    ctx.pruneHeartbeatThrottleMap(ctx.lastHeartbeat, registry);
    registry.set(input.agentId, agent);
    ctx.setRegistryCache(registry);
    await ctx.writeRegistry(registry);
  });

  ctx.emitAgentEvent('mailbox.agent_registered', {
    agentId: input.agentId,
    sessionId: input.sessionId,
    name: input.name,
    role: input.role,
    source: input.source,
  });
  ctx.publishHqMailboxEvent({
    mailboxId: ctx.hqMailboxId,
    action: 'agent.registered',
    agent: {
      agentId: input.agentId,
      name: input.name,
      ...(input.role !== undefined ? { role: input.role } : {}),
      sessionId: input.sessionId,
      status: 'idle',
      iterations: 0,
      toolCalls: 0,
      lastActivityAt: now,
      lastSeenAt: now,
      online: true,
      pid: input.pid ?? process.pid,
      ...(input.source !== undefined ? { source: input.source } : {}),
    },
  });
  ctx.publishHqMailboxSnapshot();
}

export async function deregisterMailboxAgent(
  ctx: GlobalMailboxAgentRegistryContext,
  agentId: string,
): Promise<void> {
  await ctx.ensureRegistry();
  let removed: RegisteredAgent | undefined;
  await withFileLock(ctx.registryPath, async () => {
    const registry = await ctx.readRegistry({ fresh: true });
    ctx.pruneStaleInPlace(registry);
    ctx.pruneHeartbeatThrottleMap(ctx.lastHeartbeat, registry);
    removed = registry.get(agentId);
    registry.delete(agentId);
    ctx.lastHeartbeat.delete(agentId);
    ctx.setRegistryCache(registry);
    await ctx.writeRegistry(registry);
  });
  ctx.emitAgentEvent('mailbox.agent_deregistered', { agentId });
  const lastSeenAt = removed?.lastSeenAt ?? new Date().toISOString();
  ctx.publishHqMailboxEvent({
    mailboxId: ctx.hqMailboxId,
    action: 'agent.deregistered',
    agent: {
      agentId,
      name: removed?.name ?? agentId,
      ...(removed?.role !== undefined ? { role: removed.role } : {}),
      sessionId: removed?.sessionId ?? '',
      status: 'offline',
      ...(removed?.currentTool !== undefined ? { currentTool: removed.currentTool } : {}),
      ...(removed?.currentTask !== undefined ? { currentTask: removed.currentTask } : {}),
      iterations: removed?.iterations ?? 0,
      toolCalls: removed?.toolCalls ?? 0,
      lastActivityAt: lastSeenAt,
      lastSeenAt,
      online: false,
      pid: removed?.pid ?? 0,
      ...(removed?.source !== undefined ? { source: removed.source } : {}),
    },
  });
  ctx.publishHqMailboxSnapshot();
}

export async function heartbeatMailboxAgent(
  ctx: GlobalMailboxAgentRegistryContext,
  input: AgentHeartbeatInput,
): Promise<void> {
  const last = ctx.lastHeartbeat.get(input.agentId) ?? 0;
  const now = Date.now();
  if (now - last < HEARTBEAT_THROTTLE_MS) return;

  ctx.lastHeartbeat.set(input.agentId, now);

  await ctx.ensureRegistry();

  await withFileLock(ctx.registryPath, async () => {
    const registry = await ctx.readRegistry({ fresh: true });
    ctx.pruneStaleInPlace(registry);
    ctx.pruneHeartbeatThrottleMap(ctx.lastHeartbeat, registry);

    const agent = registry.get(input.agentId);
    if (agent) {
      const iso = new Date().toISOString();
      agent.lastSeenAt = iso;
      if (input.status !== undefined) agent.status = input.status;
      if (input.currentTool !== undefined) agent.currentTool = input.currentTool;
      if (input.currentTask !== undefined) agent.currentTask = input.currentTask;
      if (input.iterations !== undefined) agent.iterations = input.iterations;
      if (input.toolCalls !== undefined) agent.toolCalls = input.toolCalls;
    }

    ctx.setRegistryCache(registry);
    await ctx.writeRegistry(registry);
  });

  ctx.emitAgentEvent('mailbox.agent_heartbeat', {
    agentId: input.agentId,
    status: input.status,
    currentTool: input.currentTool,
    currentTask: input.currentTask,
  });
  ctx.publishHqMailboxEvent({
    mailboxId: ctx.hqMailboxId,
    action: 'agent.heartbeat',
    summary: input.agentId,
  });
  ctx.publishHqMailboxSnapshot();
}

export async function getMailboxAgentStatuses(
  ctx: GlobalMailboxAgentRegistryContext,
): Promise<MailboxAgentStatus[]> {
  await ctx.ensureRegistry();
  let registry = await ctx.readRegistry();
  const before = registry.size;
  ctx.pruneStaleInPlace(registry);

  if (registry.size < before) {
    await withFileLock(ctx.registryPath, async () => {
      const fresh = await ctx.readRegistry({ fresh: true });
      ctx.pruneStaleInPlace(fresh);
      ctx.setRegistryCache(fresh);
      await ctx.writeRegistry(fresh);
      registry = fresh;
    });
  }

  return mapRegisteredAgentsToStatuses(registry, Date.now(), AGENT_STALE_MS);
}
