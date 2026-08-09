import { deriveHqProjectId } from '@wrongstack/core/hq';

export function resolveHqProjectRoot(
  globalRoot: string,
  ids: { sessionId?: string | undefined; projectId?: string | undefined },
): Promise<string | undefined> {
  // Dynamic import to avoid pulling in SessionRegistry at module level.
  const fn = async (): Promise<string | undefined> => {
    const { getSessionRegistry } = await import('@wrongstack/core/storage');
    try {
      const registry = getSessionRegistry(globalRoot);
      if (typeof ids.sessionId === 'string') {
        const entry = await registry.get(ids.sessionId).catch(() => null);
        if (entry?.projectRoot) return entry.projectRoot;
      }
      if (typeof ids.projectId === 'string') {
        const { createHash } = await import('node:crypto');
        const all = await registry.list().catch(() => []);
        const projectIds = new Map<string, string>();
        const projectIdForRoot = (projectRoot: string): string => {
          const cached = projectIds.get(projectRoot);
          if (cached !== undefined) return cached;
          const derived = deriveHqProjectId(projectRoot);
          projectIds.set(projectRoot, derived);
          return derived;
        };
        const match = all.find(
          (e: { projectSlug?: string; projectRoot: string }) =>
            e.projectSlug === ids.projectId ||
            projectIdForRoot(e.projectRoot) === ids.projectId ||
            createHash('sha256').update(e.projectRoot).digest('hex').slice(0, 12) === ids.projectId,
        );
        if (match) return match.projectRoot;
      }
    } catch {
      /* fall through */
    }
    return undefined;
  };
  return fn();
}
