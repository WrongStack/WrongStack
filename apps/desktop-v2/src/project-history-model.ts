import { isLive, type Session } from './model';

export function historyTitle(
  row: Record<string, unknown>,
  owner?: Session,
  untitled = 'Untitled conversation',
) {
  return String(row['name'] || owner?.title || row['title'] || untitled);
}
export function historyHasContent(row: Record<string, unknown>) {
  return row['isEmpty'] !== true;
}
export function historyMatches(
  row: Record<string, unknown>,
  query: string,
  provider: string,
  outcome: string,
  open: boolean,
  displayTitle = '',
) {
  return (
    (!query.trim() ||
      [
        displayTitle,
        row['name'],
        row['title'],
        row['id'],
        row['lastUserMessage'],
        row['provider'],
        row['model'],
      ]
        .join(' ')
        .toLowerCase()
        .includes(query.trim().toLowerCase())) &&
    (!provider || row['provider'] === provider) &&
    (!outcome || (outcome === 'open' ? open : row['outcome'] === outcome))
  );
}
export async function openHistoryLinks(
  projectId: string,
  sessions: Session[],
  identity: (id: string) => Promise<{ sessionId?: unknown }>,
) {
  const candidates = sessions.filter(
    (session) => session.projectId === projectId && session.kind === 'agent' && isLive(session),
  );
  const links: Record<string, Session> = {};
  for (let offset = 0; offset < candidates.length; offset += 8) {
    const batch = await Promise.allSettled(
      candidates
        .slice(offset, offset + 8)
        .map(async (session) => ({ session, identity: await identity(session.id) })),
    );
    for (const result of batch)
      if (result.status === 'fulfilled' && typeof result.value.identity.sessionId === 'string')
        links[result.value.identity.sessionId] = result.value.session;
  }
  return links;
}
