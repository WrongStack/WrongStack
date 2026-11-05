import { isLive, type Session } from './model';

/**
 * The sessions the sidebar lists under a project: the running and open ones, then the most
 * recently used stopped ones, which open where they left off. Older ones stay in the history.
 */
export function sidebarSessions(
  sessions: readonly Session[],
  projectId: string,
  open: readonly string[],
  recent = 5,
): Session[] {
  const mine = sessions.filter((session) => session.projectId === projectId);
  const shown = mine.filter((session) => isLive(session) || open.includes(session.id));
  const idle = mine
    .filter((session) => !shown.includes(session))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, recent);
  return [...shown, ...idle];
}

export function restoreSessionTabs(saved: Record<string, unknown>, sessions: Session[]): string[] {
  const known = new Set(sessions.map((s) => s.id));
  const candidates = Array.isArray(saved['openSessionIds']) ? saved['openSessionIds'] : [];
  const ids = candidates.filter((id): id is string => typeof id === 'string' && known.has(id));
  if (typeof saved['selected'] === 'string' && known.has(saved['selected']))
    ids.push(saved['selected']);
  return [...new Set(ids)];
}
export function nextSessionAfterDetach(
  open: string[],
  selected: string | null,
  closed: string,
): string | null {
  if (selected !== closed) return selected;
  const index = open.indexOf(closed);
  const remaining = open.filter((id) => id !== closed);
  return remaining[Math.min(Math.max(index, 0), remaining.length - 1)] ?? null;
}
