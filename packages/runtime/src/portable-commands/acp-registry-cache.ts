import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  acpRegistryCachePath,
  fetchAcpRegistry,
  type LoadedAcpRegistry,
  parseAcpRegistryCache,
} from '@wrongstack/acp';
import { atomicWrite, type WstackPaths } from '@wrongstack/core/utils';

export type { LoadedAcpRegistry } from '@wrongstack/acp';

const REGISTRY_MAX_AGE_MS = 60 * 60 * 1000;
const discoveryRefreshes = new Map<string, Promise<void>>();

export async function loadCachedAcpRegistry(paths: WstackPaths): Promise<LoadedAcpRegistry | null> {
  if (!paths.cacheDir) return null;
  try {
    return parseAcpRegistryCache(await fs.readFile(acpRegistryCachePath(paths.cacheDir), 'utf8'));
  } catch {
    return null;
  }
}

/** Keep interactive discovery current and continue to work offline. */
export async function discoverAcpRegistry(paths: WstackPaths): Promise<LoadedAcpRegistry | null> {
  if (!paths.cacheDir) return null;
  const cached = await loadCachedAcpRegistry(paths);
  const age = Date.now() - Date.parse(cached?.fetchedAt ?? '');
  if (cached?.agents.length && age >= 0 && age < REGISTRY_MAX_AGE_MS) return cached;

  const cacheDir = paths.cacheDir;
  let refresh = discoveryRefreshes.get(cacheDir);
  if (!refresh) {
    refresh = refreshAcpRegistry(paths, { timeoutMs: 5_000 })
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => discoveryRefreshes.delete(cacheDir));
    discoveryRefreshes.set(cacheDir, refresh);
  }
  await refresh;
  return (await loadCachedAcpRegistry(paths)) ?? cached;
}

/** Fetch the live registry and persist it. Throws on network/parse failure. */
export async function refreshAcpRegistry(
  paths: WstackPaths,
  opts?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<{ count: number; location: string; fetchedAt: string }> {
  if (!paths.cacheDir) throw new Error('ACP registry cache directory is unavailable');
  const result = await fetchAcpRegistry({
    ...(opts?.signal ? { signal: opts.signal } : {}),
    ...(opts?.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    includeQuarantine: true,
  });
  if (result.agents.length === 0) throw new Error('ACP registry has no entries for this platform');
  const previous = result.quarantine ? null : await loadCachedAcpRegistry(paths);
  const agents = result.agents.map((agent) => {
    const reason = result.quarantine
      ? Object.hasOwn(result.quarantine, agent.id)
        ? result.quarantine[agent.id]
        : undefined
      : previous?.byId[agent.id]?.quarantineReason;
    return reason
      ? {
          ...agent,
          registry: {
            ...agent.registry,
            quarantineReason: reason.replace(/\p{Cc}/gu, ' ').trim(),
          },
        }
      : agent;
  });
  const location = acpRegistryCachePath(paths.cacheDir);
  await fs.mkdir(path.dirname(location), { recursive: true });
  await atomicWrite(location, JSON.stringify({ fetchedAt: result.fetchedAt, agents }));
  return { count: agents.length, location, fetchedAt: result.fetchedAt };
}
