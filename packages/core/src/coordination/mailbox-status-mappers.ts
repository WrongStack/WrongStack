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
      online: now - new Date(agent.lastSeenAt).getTime() < staleMs,
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
  return Array.from(registry.values())
    .map((client) => ({
      clientId: client.clientId,
      name: client.name,
      source: client.source,
      sessionId: client.sessionId,
      lastSeenAt: client.lastSeenAt,
      online: now - new Date(client.lastSeenAt).getTime() < staleMs,
      pid: client.pid,
    }))
    .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
}
