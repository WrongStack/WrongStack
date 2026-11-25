import { isAbsolute, resolve } from 'node:path';
import {
  ACPSession,
  type AcpAgentCommandOverrides,
  type AcpLiveCatalog,
  readOnlyPermissionPolicy,
  resolveAcpAgentCommand,
  type SessionInfo,
} from '@wrongstack/acp';

interface AcpSessionPage {
  sessions: Array<Pick<SessionInfo, 'sessionId' | 'cwd' | 'title' | 'updatedAt'>>;
  nextCursor?: string;
}

/** Open a read-only ACP connection and fetch one page for the current project. */
export async function listAcpSessions(input: {
  agentId: string;
  projectRoot: string;
  cursor?: string | undefined;
  overrides?: AcpAgentCommandOverrides | undefined;
  live?: AcpLiveCatalog | undefined;
}): Promise<AcpSessionPage> {
  const command = resolveAcpAgentCommand(input.agentId, input.overrides, input.live);
  if (!command) throw new Error(`ACP agent '${input.agentId}' has no available launch command.`);
  const projectRoot = resolve(input.projectRoot);
  const agent = await ACPSession.start({
    ...command,
    cwd: projectRoot,
    projectRoot,
    permissionPolicy: readOnlyPermissionPolicy,
    timeoutMs: 30_000,
  });
  try {
    const page = await agent.listSessions(input.cursor, projectRoot);
    const projectPath = platformPath(projectRoot);
    const sessions = (Array.isArray(page.sessions) ? page.sessions : [])
      .filter(
        (row) =>
          typeof row?.sessionId === 'string' &&
          row.sessionId.length > 0 &&
          typeof row.cwd === 'string' &&
          isAbsolute(row.cwd) &&
          platformPath(row.cwd) === projectPath,
      )
      .map(({ sessionId, cwd, title, updatedAt }) => ({
        sessionId,
        cwd,
        ...(typeof title === 'string' && title ? { title } : {}),
        ...(typeof updatedAt === 'string' && updatedAt ? { updatedAt } : {}),
      }));
    const nextCursor =
      typeof page.nextCursor === 'string' && page.nextCursor.length ? page.nextCursor : undefined;
    return { sessions, ...(nextCursor ? { nextCursor } : {}) };
  } finally {
    await agent.close({ graceMs: 500 }).catch(() => undefined);
  }
}

function platformPath(cwd: string): string {
  const normalized = resolve(cwd);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function formatAcpSessions(page: AcpSessionPage): string {
  const lines = page.sessions.map(({ sessionId, title, updatedAt }) =>
    [
      JSON.stringify(sessionId),
      title?.replace(/\p{Cc}/gu, ' '),
      updatedAt?.replace(/\p{Cc}/gu, ' '),
    ]
      .filter(Boolean)
      .join('  '),
  );
  if (lines.length === 0) lines.push('No ACP sessions on this page for the current project.');
  if (page.nextCursor) lines.push(`Next cursor: ${JSON.stringify(page.nextCursor)}`);
  return lines.join('\n');
}
