import type {
  ClientStatus,
  MailboxAgentStatus,
  RegisteredAgent,
  RegisteredClient,
} from './mailbox-types.js';

export function mapRegisteredAgentsToStatuses(
  registry: ReadonlyMap<string, RegisteredAgent>,
  now: number,
  staleMs: number,
): MailboxAgentStatus[] {
  const safeNow = Number.isFinite(now) ? now : Date.now();
  const safeStaleMs = Number.isFinite(staleMs) && staleMs > 0 ? staleMs : 60_000;
  return Array.from(registry.values())
    .map((agent) => ({
      agentId: agent.agentId,
      name: agent.name,
      role: agent.role,
      sessionId: agent.sessionId,
      status: agent.status,
      currentTool: agent.currentTool,
      currentTask: agent.currentTask,
      iterations: agent.iterations,
      toolCalls: agent.toolCalls,
      lastActivityAt: agent.lastSeenAt,
      lastSeenAt: agent.lastSeenAt,
      online: safeNow - new Date(agent.lastSeenAt).getTime() < safeStaleMs,
      pid: agent.pid,
      source: agent.source,
    }))
    .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
}

export function mapRegisteredClientsToStatuses(
  registry: ReadonlyMap<string, RegisteredClient>,
  now: number,
  staleMs: number,
): ClientStatus[] {
  const safeNow = Number.isFinite(now) ? now : Date.now();
  const safeStaleMs = Number.isFinite(staleMs) && staleMs > 0 ? staleMs : 60_000;
  return Array.from(registry.values())
    .map((client) => ({
      clientId: client.clientId,
      name: client.name,
      source: client.source,
      sessionId: client.sessionId,
      lastSeenAt: client.lastSeenAt,
      online: safeNow - new Date(client.lastSeenAt).getTime() < safeStaleMs,
      pid: client.pid,
    }))
    .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
}
