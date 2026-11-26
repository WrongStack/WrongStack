import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { wstackGlobalRoot } from '@wrongstack/core/utils';
import type { AcpLiveCatalog } from '../integration/acp-agent-probe.js';
import type { ACPAgentDescriptor } from './contracts.js';

export interface LoadedAcpRegistry {
  fetchedAt: string;
  /** Resolver input: registry-id → spawn command. */
  byId: AcpLiveCatalog;
  /** Full descriptors, for listing. */
  agents: ACPAgentDescriptor[];
}

/** Where the synced registry snapshot lives. */
export function acpRegistryCachePath(cacheDir = join(wstackGlobalRoot(), 'cache')): string {
  return join(cacheDir, 'acp-registry.json');
}

function validArgs(value: unknown): value is string[] | undefined {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.every((argument) => typeof argument === 'string' && !argument.includes('\0')))
  );
}

function validEnv(value: unknown): value is Record<string, string> | undefined {
  return (
    value === undefined ||
    (typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      Object.entries(value).every(
        ([key, item]) =>
          key.length > 0 &&
          !key.includes('\0') &&
          !key.includes('=') &&
          typeof item === 'string' &&
          !item.includes('\0'),
      ))
  );
}

/** Read the cached registry, or `null` if it's missing or unreadable. */
export function parseAcpRegistryCache(raw: string): LoadedAcpRegistry | null {
  try {
    const env = JSON.parse(raw.replace(/^\uFEFF/, '')) as LoadedAcpRegistry | null;
    if (!env || typeof env !== 'object' || !Array.isArray(env.agents)) return null;
    const byId: AcpLiveCatalog = Object.create(null);
    const validAgents: ACPAgentDescriptor[] = [];
    const seenIds = new Set<string>();
    for (const a of env.agents) {
      const id = typeof a?.id === 'string' ? a.id.trim() : '';
      const command = typeof a?.acp?.command === 'string' ? a.acp.command.trim() : '';
      if (
        !a ||
        !id ||
        /[\u0000-\u001f\u007f]/.test(id) ||
        !command ||
        command.includes('\0') ||
        !validArgs(a.acp.args) ||
        !validEnv(a.acp.env) ||
        seenIds.has(id)
      ) {
        continue;
      }
      seenIds.add(id);
      byId[id] = {
        command,
        args: Array.isArray(a.acp.args) ? a.acp.args : [],
        ...(a.acp.env ? { env: a.acp.env } : {}),
        ...(typeof a.registry?.quarantineReason === 'string'
          ? { quarantineReason: a.registry.quarantineReason }
          : {}),
      };
      const displayName = typeof a.displayName === 'string' ? a.displayName.trim() : '';
      validAgents.push({ ...a, id, displayName: displayName || id, acp: { ...a.acp, command } });
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

/** Local-only registry snapshot for synchronous provider and fleet discovery. */
export function readCachedAcpRegistry(cacheDir?: string): LoadedAcpRegistry | null {
  try {
    return parseAcpRegistryCache(readFileSync(acpRegistryCachePath(cacheDir), 'utf8'));
  } catch {
    return null;
  }
}
