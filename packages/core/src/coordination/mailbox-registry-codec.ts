import type { RegisteredAgent, RegisteredClient } from './mailbox-types.js';

/**
 * Minimal shape-check for a deserialized agent registry entry.
 *
 * Identity fields are the only hard requirement. Everything else is coerced
 * to a safe default so an unrecognised entry from another/newer process
 * survives a shared read-modify-write instead of being permanently evicted.
 */
export function parseAgentRegistryEntry(value: unknown): RegisteredAgent | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.agentId !== 'string') return null;
  if (typeof v.sessionId !== 'string') return null;
  const statuses = ['idle', 'busy', 'running', 'streaming', 'waiting_user', 'error'] as const;
  const status =
    typeof v.status === 'string' && (statuses as readonly string[]).includes(v.status)
      ? v.status
      : 'idle';
  return {
    ...v,
    agentId: v.agentId,
    sessionId: v.sessionId,
    name: typeof v.name === 'string' ? v.name : v.agentId,
    registeredAt: typeof v.registeredAt === 'string' ? v.registeredAt : new Date(0).toISOString(),
    lastSeenAt: typeof v.lastSeenAt === 'string' ? v.lastSeenAt : new Date(0).toISOString(),
    iterations:
      typeof v.iterations === 'number' && Number.isFinite(v.iterations) ? v.iterations : 0,
    toolCalls: typeof v.toolCalls === 'number' && Number.isFinite(v.toolCalls) ? v.toolCalls : 0,
    pid: typeof v.pid === 'number' && Number.isFinite(v.pid) ? v.pid : 0,
    status,
  } as unknown as RegisteredAgent;
}

/** Minimal shape-check for a deserialized client registry entry. */
export function parseClientRegistryEntry(value: unknown): RegisteredClient | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.clientId !== 'string') return null;
  if (typeof v.sessionId !== 'string') return null;
  const sources = ['repl', 'tui', 'webui', 'http'] as const;
  const source =
    typeof v.source === 'string' && (sources as readonly string[]).includes(v.source)
      ? v.source
      : 'http';
  return {
    ...v,
    clientId: v.clientId,
    sessionId: v.sessionId,
    name: typeof v.name === 'string' ? v.name : v.clientId,
    registeredAt: typeof v.registeredAt === 'string' ? v.registeredAt : new Date(0).toISOString(),
    lastSeenAt: typeof v.lastSeenAt === 'string' ? v.lastSeenAt : new Date(0).toISOString(),
    pid: typeof v.pid === 'number' && Number.isFinite(v.pid) ? v.pid : 0,
    source,
  } as unknown as RegisteredClient;
}
