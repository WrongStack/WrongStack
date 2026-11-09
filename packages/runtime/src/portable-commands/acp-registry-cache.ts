/**
 * Local cache for the official ACP registry snapshot.
 *
 * `wstack acp sync` / `/acp sync` call `refreshAcpRegistry`, which fetches the
 * CDN snapshot (via `@wrongstack/acp`'s `fetchAcpRegistry`) and writes it to
 * `~/.wrongstack/cache/acp-registry.json`. `loadCachedAcpRegistry` reads it
 * back into the `AcpLiveCatalog` shape the resolver consumes. No network at
 * load time; resolution falls back to the bundled static catalog when no
 * cache exists.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { type ACPAgentDescriptor, type AcpLiveCatalog, fetchAcpRegistry } from '@wrongstack/acp';
import { atomicWrite, type WstackPaths } from '@wrongstack/core/utils';

interface CacheEnvelope {
  fetchedAt: string;
  agents: ACPAgentDescriptor[];
}

export interface LoadedAcpRegistry {
  fetchedAt: string;
  /** Resolver input: registry-id → spawn command. */
  byId: AcpLiveCatalog;
  /** Full descriptors, for listing. */
  agents: ACPAgentDescriptor[];
}

/** Where the synced registry snapshot lives. */
function acpRegistryCachePath(paths: WstackPaths): string {
  return path.join(paths.cacheDir, 'acp-registry.json');
}

/** Read the cached registry, or `null` if it's missing or unreadable. */
export async function loadCachedAcpRegistry(paths: WstackPaths): Promise<LoadedAcpRegistry | null> {
  try {
    const raw = await fs.readFile(acpRegistryCachePath(paths), 'utf8');
    const env = JSON.parse(raw) as CacheEnvelope;
    if (!Array.isArray(env.agents)) return null;
    const byId: AcpLiveCatalog = Object.create(null);
    const validAgents: ACPAgentDescriptor[] = [];
    for (const a of env.agents) {
      if (
        !a ||
        typeof a.id !== 'string' ||
        !a.id.trim() ||
        typeof a.acp?.command !== 'string' ||
        !a.acp.command.trim()
      ) {
        continue;
      }
      byId[a.id] = {
        command: a.acp.command,
        args: Array.isArray(a.acp.args) ? a.acp.args : [],
        ...(a.acp.env ? { env: a.acp.env } : {}),
      };
      validAgents.push(a);
    }
    return {
      fetchedAt: typeof env.fetchedAt === 'string' ? env.fetchedAt : '',
      byId,
      agents: validAgents,
    };
  } catch {
    return null;
  }
}

/** Fetch the live registry and persist it. Throws on network/parse failure. */
export async function refreshAcpRegistry(
  paths: WstackPaths,
  opts?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<{ count: number; location: string; fetchedAt: string }> {
  const result = await fetchAcpRegistry({
    ...(opts?.signal ? { signal: opts.signal } : {}),
    ...(opts?.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
  });
  const location = acpRegistryCachePath(paths);
  await fs.mkdir(path.dirname(location), { recursive: true });
  const env: CacheEnvelope = { fetchedAt: result.fetchedAt, agents: result.agents };
  await atomicWrite(location, JSON.stringify(env));
  return { count: result.agents.length, location, fetchedAt: result.fetchedAt };
}
