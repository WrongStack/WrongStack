import type { ApiSession, ApiSessionAgent } from '@wrongstack/webui-protocol';
import { entries } from './engine-values';

function projectPath(value: string): string {
  return value
    .replace(/^\\\\\?\\/, '')
    .replaceAll('\\', '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}
const englishFleetErrors = {
  catalog: 'The engine returned no live session catalog.',
  records: 'The engine returned malformed session records.',
  session: 'A live session record has invalid identity or timing.',
  agent: 'A live agent record has invalid identity or counters.',
};
export function projectFleet(
  value: unknown,
  root: string,
  carrierId: string,
  words = englishFleetErrors,
): ApiSession[] {
  if (!Array.isArray(value)) throw Error(words.catalog);
  const records = entries(value),
    seenSessions = new Set<string>();
  if (records.some((row) => typeof row['projectRoot'] !== 'string' || !row['projectRoot']))
    throw Error(words.records);
  return records
    .filter(
      (row) =>
        typeof row['projectRoot'] === 'string' &&
        projectPath(row['projectRoot']) === projectPath(root) &&
        row['sessionId'] !== carrierId,
    )
    .map((row) => {
      if (
        typeof row['sessionId'] !== 'string' ||
        !row['sessionId'] ||
        seenSessions.has(row['sessionId']) ||
        typeof row['status'] !== 'string' ||
        !Number.isSafeInteger(row['pid']) ||
        Number(row['pid']) < 1 ||
        typeof row['lastHeartbeatAt'] !== 'string' ||
        !Number.isFinite(Date.parse(String(row['lastHeartbeatAt']))) ||
        typeof row['startedAt'] !== 'string' ||
        !Number.isFinite(Date.parse(row['startedAt'])) ||
        !Array.isArray(row['agents'])
      )
        throw Error(words.session);
      seenSessions.add(row['sessionId']);
      const agentRows = entries(row['agents']),
        seenAgents = new Set<string>();
      const agents: ApiSessionAgent[] = agentRows.map((agent) => {
        if (
          typeof agent['id'] !== 'string' ||
          !agent['id'] ||
          seenAgents.has(agent['id']) ||
          typeof agent['name'] !== 'string' ||
          typeof agent['status'] !== 'string' ||
          !Number.isSafeInteger(agent['iterations']) ||
          Number(agent['iterations']) < 0 ||
          !Number.isSafeInteger(agent['toolCalls']) ||
          Number(agent['toolCalls']) < 0
        )
          throw Error(words.agent);
        seenAgents.add(agent['id']);
        return {
          id: agent['id'],
          name: agent['name'],
          status: agent['status'] as ApiSessionAgent['status'],
          iterations: Number(agent['iterations']),
          toolCalls: Number(agent['toolCalls']),
          lastActivityAt: String(agent['lastActivityAt'] ?? ''),
          ...(typeof agent['currentTool'] === 'string'
            ? { currentTool: agent['currentTool'] }
            : {}),
        };
      });
      return {
        sessionId: row['sessionId'],
        projectRoot: String(row['projectRoot']),
        projectSlug: String(row['projectSlug'] ?? ''),
        projectName: String(row['projectName'] ?? ''),
        workingDir: String(row['workingDir'] ?? ''),
        pid: Number(row['pid']),
        status: row['status'] as ApiSession['status'],
        startedAt: row['startedAt'],
        lastHeartbeatAt: row['lastHeartbeatAt'],
        agentCount: agents.length,
        agents,
      };
    });
}
export function fleetNodeId(sessionId: string, agentId?: string): string {
  return JSON.stringify(agentId === undefined ? [sessionId] : [sessionId, agentId]);
}

export async function fleetMailboxAddress(sessionId: string): Promise<string> {
  const hash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sessionId)),
  );
  return `leader@${[...hash]
    .slice(0, 4)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')}`;
}
