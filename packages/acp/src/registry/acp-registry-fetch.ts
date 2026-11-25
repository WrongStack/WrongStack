/**
 * Official ACP registry fetcher.
 *
 * The Agent Client Protocol maintains a canonical, hourly-updated registry of
 * ACP-supporting agents at https://github.com/agentclientprotocol/registry,
 * published as a single JSON document on a CDN. This module fetches that
 * document and maps each entry to our `ACPAgentDescriptor` shape so the live
 * list can supersede the bundled static `AGENTS_CATALOG` (which remains the
 * offline fallback).
 *
 * Distribution → spawn-command mapping (per the registry FORMAT.md):
 *   - npx:    { package, args }      → `npx -y <package> <args>`
 *   - uvx:    { package, args }      → `uvx <package> <args>`
 *   - binary: { "<os>-<arch>": { cmd, args, env } }
 *                                    → `<basename(cmd)> <args>` for THIS host
 *
 * Binary entries reference a downloadable archive we do NOT fetch; we map the
 * platform `cmd` to its basename so an already-installed on-PATH binary (the
 * common case for goose/opencode/cursor) still launches. Agents distributed
 * ONLY as a binary with no current-platform target are dropped (not runnable).
 *
 * Network is never required at runtime: this is invoked by an explicit
 * `wstack acp sync` / `/acp sync`, the result is cached, and resolution falls
 * back to the static catalog when no cache exists.
 */
import type { ACPAgentDescriptor } from './contracts.js';
import type { ACPAgentVendor } from './ensemble-registry.js';

/** Canonical CDN endpoint for the latest registry snapshot. */
export const ACP_REGISTRY_URL =
  'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json';

/** One raw entry from the registry JSON (only the fields we consume). */
export interface RegistryAgentEntry {
  id: string;
  name?: string;
  version?: string;
  description?: string;
  repository?: string;
  website?: string;
  authors?: string[];
  distribution?: {
    npx?: { package: string; args?: string[]; env?: Record<string, string> };
    uvx?: { package: string; args?: string[]; env?: Record<string, string> };
    binary?: Record<
      string,
      { archive?: string; cmd: string; args?: string[]; env?: Record<string, string> }
    >;
  };
}

export interface FetchAcpRegistryResult {
  /** ISO timestamp the snapshot was fetched. */
  fetchedAt: string;
  /** Mapped, runnable descriptors (entries we could not map are dropped). */
  agents: ACPAgentDescriptor[];
}

export interface FetchAcpRegistryOptions {
  /** Override the endpoint (tests / mirrors). */
  url?: string | undefined;
  /** Abort the fetch from the caller. */
  signal?: AbortSignal | undefined;
  /** Hard timeout in ms (default 15s). Layered under any caller signal. */
  timeoutMs?: number | undefined;
  /** ISO timestamp to stamp the result with (tests pass a fixed value). */
  now?: string | undefined;
  /** Platform key for binary selection (tests). Defaults to this host. */
  platformKey?: string | undefined;
}

/** Map Node's platform/arch to the registry's `<os>-<arch>` key form. */
export function currentPlatformKey(
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): string {
  const os = platform === 'win32' ? 'windows' : platform;
  const arch =
    architecture === 'arm64' ? 'aarch64' : architecture === 'x64' ? 'x86_64' : architecture;
  return `${os}-${arch}`;
}

/** `./foo/bar` → `bar`; leaves bare names untouched. */
function basename(cmd: string): string {
  const cleaned = cmd.trim().replace(/^\.\//, '').replace(/\\/g, '/').replace(/\/+$/, '');
  return cleaned.slice(cleaned.lastIndexOf('/') + 1);
}

function isValidLauncherSpec(spec: string | undefined): spec is string {
  if (typeof spec !== 'string') return false;
  const trimmed = spec.trim();
  return trimmed.length > 0 && !trimmed.startsWith('-') && !trimmed.includes('\0');
}

function isValidLauncherArgs(args: unknown): args is string[] | undefined {
  return (
    args === undefined ||
    (Array.isArray(args) && args.every((arg) => typeof arg === 'string' && !arg.includes('\0')))
  );
}

function isValidLauncherEnv(env: unknown): env is Record<string, string> | undefined {
  return (
    env === undefined ||
    (typeof env === 'object' &&
      env !== null &&
      !Array.isArray(env) &&
      Object.entries(env).every(
        ([key, value]) =>
          key.length > 0 &&
          !key.includes('\0') &&
          !key.includes('=') &&
          typeof value === 'string' &&
          !value.includes('\0'),
      ))
  );
}

/**
 * Map one registry entry to an `ACPAgentDescriptor`, or `null` if it carries
 * no distribution runnable on this host. Pure — no I/O.
 */
export function mapRegistryEntry(
  entry: RegistryAgentEntry,
  platformKey: string = currentPlatformKey(),
): ACPAgentDescriptor | null {
  if (!entry || typeof entry.id !== 'string' || entry.id.trim().length === 0) return null;
  const id = entry.id.trim();
  if (/[\u0000-\u001f\u007f]/.test(id)) return null;
  const dist = entry.distribution;
  let acp: { command: string; args?: string[]; env?: Record<string, string> } | null = null;

  if (isValidLauncherSpec(dist?.npx?.package)) {
    if (!isValidLauncherArgs(dist.npx.args) || !isValidLauncherEnv(dist.npx.env)) return null;
    acp = {
      command: 'npx',
      args: ['-y', dist.npx.package.trim(), ...(dist.npx.args ?? [])],
      ...(dist.npx.env ? { env: dist.npx.env } : {}),
    };
  } else if (isValidLauncherSpec(dist?.uvx?.package)) {
    if (!isValidLauncherArgs(dist.uvx.args) || !isValidLauncherEnv(dist.uvx.env)) return null;
    acp = {
      command: 'uvx',
      args: [dist.uvx.package.trim(), ...(dist.uvx.args ?? [])],
      ...(dist.uvx.env ? { env: dist.uvx.env } : {}),
    };
  } else if (dist?.binary && Object.hasOwn(dist.binary, platformKey)) {
    const target = dist.binary[platformKey];
    if (typeof target?.cmd === 'string' && !/[/\\]$/.test(target.cmd.trim())) {
      if (!isValidLauncherArgs(target.args) || !isValidLauncherEnv(target.env)) return null;
      const binCmd = basename(target.cmd);
      if (isValidLauncherSpec(binCmd)) {
        acp = {
          command: binCmd,
          args: [...(target.args ?? [])],
          ...(target.env ? { env: target.env } : {}),
        };
      }
    }
  }
  if (!acp) return null;

  // The probe argv detects "is something by this name on PATH". For npx/uvx
  // the launcher itself is the probe; for a binary the agent's own name is.
  const probeCmd = acp.command === 'npx' ? 'npx' : acp.command === 'uvx' ? 'uvx' : acp.command;

  return {
    id,
    displayName: (typeof entry.name === 'string' ? entry.name.trim() : '') || id,
    vendor: inferVendor(entry),
    probe: { command: probeCmd, args: ['--version'] },
    acp,
    supports: { loadSession: true, promptImages: true, terminal: true, fs: true },
    integration: 'native',
    docs:
      typeof entry.repository === 'string'
        ? entry.repository
        : typeof entry.website === 'string'
          ? entry.website
          : '',
  };
}

function inferVendor(entry: RegistryAgentEntry): ACPAgentVendor {
  const name = typeof entry.name === 'string' ? entry.name : '';
  const authors = Array.isArray(entry.authors)
    ? entry.authors.filter((author): author is string => typeof author === 'string')
    : [];
  const hay = `${entry.id} ${name} ${authors.join(' ')}`.toLowerCase();
  if (hay.includes('anthropic') || hay.includes('claude')) return 'anthropic';
  if (hay.includes('google') || hay.includes('gemini')) return 'google';
  if (hay.includes('openai') || hay.includes('codex')) return 'openai';
  if (hay.includes('github') || hay.includes('copilot')) return 'github';
  if (hay.includes('moonshot') || hay.includes('kimi')) return 'moonshot';
  return 'community';
}

/**
 * Fetch the live registry and return mapped descriptors. Throws on network /
 * parse failure so the caller (`wstack acp sync`) can surface it; callers that
 * want graceful degradation use the cached/static fallback instead.
 */
export async function fetchAcpRegistry(
  opts: FetchAcpRegistryOptions = {},
): Promise<FetchAcpRegistryResult> {
  const url = opts.url ?? ACP_REGISTRY_URL;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onParentAbort = () => controller.abort();
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener('abort', onParentAbort, { once: true });
  }
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`ACP registry fetch failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as { agents?: unknown };
    const rawAgents = Array.isArray(body) ? body : Array.isArray(body?.agents) ? body.agents : null;
    if (!rawAgents) {
      throw new Error('ACP registry response had no agents array');
    }
    const platformKey = opts.platformKey ?? currentPlatformKey();
    const agents: ACPAgentDescriptor[] = [];
    const seenIds = new Set<string>();
    for (const raw of rawAgents) {
      const mapped = mapRegistryEntry(raw as RegistryAgentEntry, platformKey);
      if (mapped && !seenIds.has(mapped.id)) {
        seenIds.add(mapped.id);
        agents.push(mapped);
      }
    }
    return { fetchedAt: opts.now ?? new Date().toISOString(), agents };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onParentAbort);
  }
}
