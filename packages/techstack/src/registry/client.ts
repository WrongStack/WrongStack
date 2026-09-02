/**
 * TechStack — Registry metadata HTTP client.
 *
 * Per-ecosystem registry API clients built on Node's built-in https module.
 * Features: in-memory cache with ETag/TTL, per-host concurrency limit (max 3),
 * exponential backoff on 429/5xx responses.
 *
 * @see docs/specs/techstack-sdd.md §5, §6
 */

import { parseJsonResponse, requestWithRetry } from './http-fetch.js';

// ── Types ─────────────────────────────────────────────────────────────────

export interface RegistryEntry {
  readonly latestStable?: string | undefined;
  readonly license?: string | undefined;
  readonly deprecated?: boolean | undefined;
  readonly yanked?: boolean | undefined;
  readonly retrievedAt: string;
  readonly source: string;
}

export interface CacheEntry {
  readonly data: RegistryEntry;
  readonly etag?: string | undefined;
  readonly expiresAt: number;
}

export interface HostConcurrency {
  active: number;
  readonly queue: Array<() => void>;
}

// ── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_CONCURRENCY_PER_HOST = 3;
const REGISTRY_BATCH_CONCURRENCY = 12;

// ── In-memory cache ────────────────────────────────────────────────────────

const registryCache = new Map<string, CacheEntry>();
const hostConcurrency = new Map<string, HostConcurrency>();

function getCacheKey(host: string, path: string): string {
  return `${host}${path}`;
}

function getCached(key: string): RegistryEntry | undefined {
  const entry = registryCache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    registryCache.delete(key);
    return undefined;
  }
  return entry.data;
}

/**
 * Cap on distinct (host, path) entries kept in memory. The TTL alone did not
 * bound this map: expiry was only checked when the SAME key was requested
 * again, so a scan of a large monorepo inserted one entry per dependency and
 * every one of them survived for the life of the process.
 */
const MAX_CACHE_ENTRIES = 512;

/** Drop expired entries, then oldest-first, until back within the cap. */
function trimCache(now: number): void {
  if (registryCache.size <= MAX_CACHE_ENTRIES) return;
  for (const [key, entry] of registryCache) {
    if (now > entry.expiresAt) registryCache.delete(key);
  }
  // Map iterates in insertion order, so the front is the oldest.
  while (registryCache.size > MAX_CACHE_ENTRIES) {
    const oldest = registryCache.keys().next().value;
    if (oldest === undefined) break;
    registryCache.delete(oldest);
  }
}

function setCache(key: string, data: RegistryEntry, etag?: string, ttlMs = DEFAULT_TTL_MS): void {
  const now = Date.now();
  registryCache.set(key, {
    data,
    etag,
    expiresAt: now + ttlMs,
  });
  trimCache(now);
}

// ── Concurrency limiter ────────────────────────────────────────────────────

function acquireHostSlot(host: string): Promise<void> {
  let concurrency = hostConcurrency.get(host);
  if (!concurrency) {
    concurrency = { active: 0, queue: [] };
    hostConcurrency.set(host, concurrency);
  }

  if (concurrency.active < MAX_CONCURRENCY_PER_HOST) {
    concurrency.active++;
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    concurrency!.queue.push(resolve);
  });
}

function releaseHostSlot(host: string): void {
  const concurrency = hostConcurrency.get(host);
  if (!concurrency) return;

  concurrency.active--;

  if (concurrency.queue.length > 0) {
    const next = concurrency.queue.shift();
    if (next) {
      concurrency.active++;
      next();
    }
  } else if (concurrency.active <= 0) {
    hostConcurrency.delete(host);
  }
}

// ── Registry metadata response parser ──────────────────────────────────────

interface EcosystemFetcher {
  readonly host: string;
  readonly path: (name: string) => string;
  readonly parser: (
    json: Record<string, unknown>,
    name: string,
    ecosystem: string,
  ) => RegistryEntry | undefined;
}

// ── Per-ecosystem parsers ──────────────────────────────────────────────────

/**
 * Parse an npm packument into a {@link RegistryEntry}.
 *
 * Exported so the deprecation rule is unit-testable without a network round
 * trip — it was untested, and drifted into flagging most of the ecosystem dead.
 */
export function parseNpmPackument(json: Record<string, unknown>, name: string): RegistryEntry {
  const latestVersion = (json['dist-tags'] as Record<string, string> | undefined)?.['latest'];

  // A package counts as deprecated only when its *latest* version is marked so
  // — that's what `npm deprecate` leaves behind for a dead package, and it's
  // the signal other tooling reads.
  //
  // Deliberately NOT "any version in history is deprecated": every long-lived
  // package eventually deprecates an old beta or a bad patch, so that rule
  // flags essentially the entire mature ecosystem. It marked vitest, biome and
  // cross-env dead in this very repo.
  let deprecated: boolean | undefined;
  if (latestVersion && json.versions && typeof json.versions === 'object') {
    const versions = json.versions as Record<string, Record<string, unknown>>;
    deprecated = versions[latestVersion]?.deprecated ? true : undefined;
  }

  // npm has no standard "yanked" field in registry metadata.
  return {
    latestStable: latestVersion,
    license: (json.license as string) ?? undefined,
    deprecated: deprecated ?? undefined,
    yanked: undefined,
    retrievedAt: new Date().toISOString(),
    source: `https://registry.npmjs.org/${name}`,
  };
}

// ── Per-ecosystem fetcher definitions ──────────────────────────────────────

const ECOSYSTEM_FETCHERS: Readonly<Record<string, EcosystemFetcher>> = {
  npm: {
    host: 'registry.npmjs.org',
    path: (name: string) => {
      // Scoped packages: /@scope%2Fname
      const encoded = name.startsWith('@') ? name.replace('/', '%2F') : name;
      return `/${encoded}`;
    },
    parser: parseNpmPackument,
  },

  python: {
    host: 'pypi.org',
    path: (name: string) => `/pypi/${name}/json`,
    parser: (json: Record<string, unknown>): RegistryEntry => {
      const info = json.info as Record<string, unknown> | undefined;
      return {
        latestStable: (info?.version as string) ?? undefined,
        license: (info?.license as string) ?? undefined,
        deprecated: (info?.deprecated as boolean) ?? undefined,
        yanked: undefined,
        retrievedAt: new Date().toISOString(),
        source: `https://pypi.org/pypi/${info?.name ?? ''}/json`,
      };
    },
  },

  cargo: {
    host: 'crates.io',
    path: (name: string) => `/api/v1/crates/${name}`,
    parser: (json: Record<string, unknown>): RegistryEntry => {
      const crate = json.crate as Record<string, unknown> | undefined;
      return {
        latestStable:
          (crate?.max_stable_version as string) ?? (crate?.max_version as string) ?? undefined,
        license: (crate?.license as string) ?? undefined,
        deprecated: undefined, // crates.io doesn't have deprecation
        yanked: undefined,
        retrievedAt: new Date().toISOString(),
        source: `https://crates.io/api/v1/crates/${crate?.name ?? ''}`,
      };
    },
  },

  golang: {
    host: 'proxy.golang.org',
    path: (module: string) => `/${module}/@latest`,
    parser: (json: Record<string, unknown>, module: string): RegistryEntry => {
      return {
        latestStable: (json.Version as string) ?? undefined,
        license: undefined, // Go proxy doesn't provide license
        deprecated: undefined,
        yanked: undefined,
        retrievedAt: new Date().toISOString(),
        source: `https://proxy.golang.org/${module}/@latest`,
      };
    },
  },

  nuget: {
    host: 'api.nuget.org',
    path: (name: string) => {
      const lower = name.toLowerCase();
      return `/v3/registration5-semver1/${lower}/index.json`;
    },
    parser: (json: Record<string, unknown>, name: string): RegistryEntry => {
      // NuGet V3 registration index has items with catalog entries
      const items = json.items as Array<Record<string, unknown>> | undefined;
      let latestStable: string | undefined;

      if (items && items.length > 0) {
        // Items are ordered; look through all items for the latest stable version
        for (const item of items) {
          const itemItems = item.items as Array<Record<string, unknown>> | undefined;
          if (itemItems && Array.isArray(itemItems)) {
            for (const entry of itemItems) {
              const catalogEntry = entry.catalogEntry as Record<string, unknown> | undefined;
              if (catalogEntry?.version) {
                const ver = catalogEntry.version as string;
                // Prefer non-prerelease
                if (!latestStable || (!ver.includes('-') && latestStable.includes('-'))) {
                  latestStable = ver;
                } else if (!ver.includes('-') && !latestStable.includes('-')) {
                  // Both stable — take greater
                  if (ver > latestStable) latestStable = ver;
                }
              }
            }
          }
        }
      }

      return {
        latestStable,
        license: undefined, // License requires per-version catalog entry
        deprecated: undefined,
        yanked: undefined,
        retrievedAt: new Date().toISOString(),
        source: `https://api.nuget.org/v3/registration5-semver1/${name.toLowerCase()}/index.json`,
      };
    },
  },

  composer: {
    host: 'repo.packagist.org',
    path: (name: string) => `/p2/${name}.json`,
    parser: (json: Record<string, unknown>, name: string): RegistryEntry => {
      const packages = json.packages as Record<string, Array<Record<string, unknown>>> | undefined;
      const versions = packages?.[name];
      if (!versions || versions.length === 0) {
        return { retrievedAt: new Date().toISOString(), source: 'packagist' };
      }

      // Find the latest stable version
      let latestStable: string | undefined;
      for (const ver of versions) {
        const version = ver.version as string;
        if (
          version &&
          !version.includes('dev') &&
          !version.includes('alpha') &&
          !version.includes('beta') &&
          !version.includes('RC') &&
          !version.includes('rc')
        ) {
          if (!latestStable || version > latestStable) {
            latestStable = version;
          }
        }
      }

      // Use the latest version entry for license info
      const latest = versions[0]!;

      return {
        latestStable,
        license: (latest.license as string) ?? undefined,
        deprecated: (latest.deprecated as boolean) ?? undefined,
        yanked: (latest.abandoned as boolean) ?? undefined,
        retrievedAt: new Date().toISOString(),
        source: `https://repo.packagist.org/p2/${name}.json`,
      };
    },
  },

  pub: {
    host: 'pub.dev',
    path: (name: string) => `/api/packages/${name}`,
    parser: (json: Record<string, unknown>): RegistryEntry => {
      const latest = json.latest as Record<string, unknown> | undefined;
      return {
        latestStable:
          (json.latestVersion as string) ??
          (latest?.version as string) ??
          (json.version as string) ??
          undefined,
        license: (latest?.license as string) ?? undefined,
        deprecated: (json.isDiscontinued as boolean) ?? undefined,
        yanked: (json.isRetracted as boolean) ?? undefined,
        retrievedAt: new Date().toISOString(),
        source: `https://pub.dev/api/packages/${(json.name as string) ?? ''}`,
      };
    },
  },
};

// ── Public API ─────────────────────────────────────────────────────────────

export class RegistryNotFoundError extends Error {
  constructor(
    readonly statusCode: number,
    readonly packageName: string,
  ) {
    super(`Registry package not found or inaccessible (${statusCode}): ${packageName}`);
    this.name = 'RegistryNotFoundError';
  }
}

export class RegistryAuthError extends Error {
  constructor(
    readonly statusCode: number,
    readonly packageName: string,
  ) {
    super(`Registry authorization failed (${statusCode}): ${packageName}`);
    this.name = 'RegistryAuthError';
  }
}

export class RegistryRateLimitError extends Error {
  constructor(
    readonly statusCode: number,
    readonly host: string,
  ) {
    super(`Registry ${host} returned ${statusCode} after 3 attempts`);
    this.name = 'RegistryRateLimitError';
  }
}

export class RegistryNetworkError extends Error {
  constructor(
    message: string,
    override readonly cause?: Error | undefined,
  ) {
    super(message);
    this.name = 'RegistryNetworkError';
  }
}

export interface RegistryLookupOptions {
  /** Abort signal for cancellation. */
  readonly signal?: AbortSignal | undefined;
  /** Bypass cache and force a fresh lookup. */
  readonly force?: boolean | undefined;
  /** Throw classified 401/403/404 errors instead of the compatibility `undefined`. */
  readonly strictErrors?: boolean | undefined;
}

/**
 * Look up registry metadata for a package in a given ecosystem.
 *
 * Returns `undefined` on 404/401 (private/unresolved package).
 * Throws on network errors (timeout, DNS failure).
 */
export async function lookupRegistry(
  ecosystem: string,
  name: string,
  options: RegistryLookupOptions = {},
): Promise<RegistryEntry | undefined> {
  const fetcher = ECOSYSTEM_FETCHERS[ecosystem];
  if (!fetcher) {
    throw new Error(`Unsupported ecosystem for registry lookup: ${ecosystem}`);
  }

  const path = fetcher.path(name);
  const cacheKey = getCacheKey(fetcher.host, path);

  // Check cache (unless force refresh)
  if (!options.force) {
    const cached = getCached(cacheKey);
    if (cached) return cached;
  }

  // Acquire concurrency slot
  await acquireHostSlot(fetcher.host);
  try {
    // Get cached ETag
    const existingEntry = registryCache.get(cacheKey);
    const etag = existingEntry?.etag;

    let response;
    try {
      response = await requestWithRetry({
        hostname: fetcher.host,
        path,
        headers: {
          Accept: 'application/json',
          'User-Agent': 'WrongStack-TechStack/1.0',
          ...(etag ? { 'If-None-Match': etag } : {}),
        },
        signal: options.signal,
        timeoutMs: 15_000,
        maxAttempts: 3,
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      const cause = error instanceof Error ? error : new Error(String(error));
      throw new RegistryNetworkError(cause.message, cause);
    }

    if (response.statusCode === 304 && existingEntry) {
      setCache(cacheKey, existingEntry.data, existingEntry.etag, DEFAULT_TTL_MS);
      return existingEntry.data;
    }
    if (response.statusCode === 401 || response.statusCode === 404) {
      if (options.strictErrors) throw new RegistryNotFoundError(response.statusCode, name);
      return undefined;
    }
    if (response.statusCode === 403) {
      if (options.strictErrors) throw new RegistryAuthError(response.statusCode, name);
      return undefined;
    }
    if (response.statusCode === 429) {
      throw new RegistryRateLimitError(response.statusCode, fetcher.host);
    }
    if (response.statusCode >= 500) {
      throw new RegistryNetworkError(
        `Registry ${fetcher.host} returned ${response.statusCode} after 3 attempts`,
      );
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new RegistryNetworkError(
        `Unexpected registry response ${response.statusCode} from ${fetcher.host}`,
      );
    }

    const json = parseJsonResponse<Record<string, unknown>>(response, `${fetcher.host}${path}`);
    const parsed = fetcher.parser(json, name, ecosystem);
    if (!parsed) return undefined;
    const responseEtag = Array.isArray(response.headers.etag)
      ? response.headers.etag[0]
      : response.headers.etag;
    setCache(cacheKey, parsed, responseEtag, DEFAULT_TTL_MS);
    return parsed;
  } finally {
    releaseHostSlot(fetcher.host);
  }
}

/**
 * Look up registry metadata for multiple packages in the same ecosystem.
 * Uses the same per-host concurrency limit for the batch.
 */
export async function lookupRegistryBatch(
  ecosystem: string,
  names: readonly string[],
  options: RegistryLookupOptions = {},
): Promise<Map<string, RegistryEntry | undefined>> {
  const results = new Map<string, RegistryEntry | undefined>();

  // Do not allocate one Promise and one semaphore waiter for every dependency
  // in a large monorepo. Work in bounded chunks; the per-host limiter still
  // enforces its stricter network concurrency within each chunk.
  const uniqueNames = [...new Set(names)];
  for (let offset = 0; offset < uniqueNames.length; offset += REGISTRY_BATCH_CONCURRENCY) {
    const chunk = uniqueNames.slice(offset, offset + REGISTRY_BATCH_CONCURRENCY);
    const entries = await Promise.all(
      chunk.map(async (name) => {
        try {
          const entry = await lookupRegistry(ecosystem, name, options);
          return { name, entry } as const;
        } catch {
          return { name, entry: undefined } as const;
        }
      }),
    );
    for (const { name, entry } of entries) results.set(name, entry);
  }

  return results;
}

/**
 * Get the list of supported ecosystem IDs for registry lookups.
 */
export function supportedRegistryEcosystems(): string[] {
  return Object.keys(ECOSYSTEM_FETCHERS);
}

/**
 * Clear the in-memory registry cache.
 * Useful for testing and when force-refreshing.
 */
export function clearRegistryCache(): void {
  registryCache.clear();
  hostConcurrency.clear();
}

/** Invalidate one ecosystem batch without evicting unrelated registry data. */
export function invalidateRegistryCache(ecosystem: string, names?: readonly string[]): number {
  const fetcher = ECOSYSTEM_FETCHERS[ecosystem];
  if (!fetcher) return 0;
  const keys = names
    ? names.map((name) => getCacheKey(fetcher.host, fetcher.path(name)))
    : [...registryCache.keys()].filter((key) => key.startsWith(fetcher.host));
  let removed = 0;
  for (const key of keys) {
    if (registryCache.delete(key)) removed++;
  }
  return removed;
}
