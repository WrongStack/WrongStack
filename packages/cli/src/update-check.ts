import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { FetchError } from '@wrongstack/core/types';
import { resolveWstackPaths } from '@wrongstack/core/utils';

export interface UpdateInfo {
  current: string;
  latest: string;
  outdated: boolean;
  checkFailed: boolean;
}

type HomeDirFn = () => string;
const defaultHomeDir: HomeDirFn = () => os.homedir();

export type UpdatePackageName = 'wrongstack' | '@wrongstack/cli';

/** npm registry endpoint used for self-update version checks. */
function npmRegistryUrl(packageName: UpdatePackageName): string {
  return `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`;
}

/** Cache file path — homeFn is injectable for testing */
export function cachePath(homeFn: HomeDirFn = defaultHomeDir): string {
  const paths =
    homeFn === defaultHomeDir
      ? resolveWstackPaths({ projectRoot: process.cwd() })
      : resolveWstackPaths({ projectRoot: process.cwd(), userHome: homeFn() });
  return paths.profileUpdateCache(paths.profileName);
}

/** 24-hour TTL */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface CacheEntry {
  timestamp: number;
  latestVersion: string;
  packageName: UpdatePackageName;
}

/** Read the current CLI version from package.json */
export function currentVersion(): string {
  const req = createRequire(import.meta.url);
  const candidates = ['../package.json', '../../package.json'];
  for (const rel of candidates) {
    try {
      const pkg = req(rel) as { version?: unknown | undefined };
      if (typeof pkg.version === 'string' && pkg.version.length > 0) return pkg.version;
    } catch {
      // try next
    }
  }
  return 'dev';
}

interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

function parseSemver(version: string): ParsedSemver | null {
  const match = version.match(
    /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
  );
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split('.') ?? [],
  };
}

function comparePrerelease(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) {
    if (a.length === b.length) return 0;
    return a.length === 0 ? 1 : -1;
  }

  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const ai = a[i];
    const bi = b[i];
    if (ai === undefined || bi === undefined) return ai === undefined ? -1 : 1;
    if (ai === bi) continue;
    const aNumeric = /^\d+$/.test(ai);
    const bNumeric = /^\d+$/.test(bi);
    if (aNumeric && bNumeric) return Number(ai) > Number(bi) ? 1 : -1;
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return ai > bi ? 1 : -1;
  }
  return 0;
}

/** SemVer comparison — returns true if a > b. Invalid versions are never considered newer. */
export function isNewer(a: string, b: string): boolean {
  const av = parseSemver(a);
  const bv = parseSemver(b);
  if (!av || !bv) return false;
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (av[key] > bv[key]) return true;
    if (av[key] < bv[key]) return false;
  }
  return comparePrerelease(av.prerelease, bv.prerelease) > 0;
}

interface CacheState {
  entry: CacheEntry;
  fresh: boolean;
}

/** Read and validate cache. Expired entries remain available as a network-failure fallback. */
async function readCache(
  homeFn: HomeDirFn = defaultHomeDir,
  packageName: UpdatePackageName = 'wrongstack',
): Promise<CacheState | null> {
  try {
    const raw = await fs.readFile(cachePath(homeFn), 'utf8');
    const value = JSON.parse(raw) as Record<string, unknown>;
    const cachedPackage = value['packageName'];
    if (
      typeof value['timestamp'] !== 'number' ||
      !Number.isFinite(value['timestamp']) ||
      typeof value['latestVersion'] !== 'string' ||
      !parseSemver(value['latestVersion']) ||
      (cachedPackage !== undefined && cachedPackage !== packageName) ||
      (cachedPackage === undefined && packageName !== 'wrongstack')
    ) {
      return null;
    }
    const entry: CacheEntry = {
      timestamp: value['timestamp'],
      latestVersion: value['latestVersion'],
      packageName,
    };
    return { entry, fresh: Date.now() - entry.timestamp <= CACHE_TTL_MS };
  } catch {
    return null;
  }
}

/** Write cache */
async function writeCache(entry: CacheEntry, homeFn: HomeDirFn = defaultHomeDir): Promise<void> {
  try {
    const dir = path.dirname(cachePath(homeFn));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(cachePath(homeFn), JSON.stringify(entry, null, 2), 'utf8');
  } catch {
    // best-effort
  }
}

/** Fetch latest version from npm registry. Exported for testability and for
 *  callers that want to do their own version checks. Throws a structured
 *  `FetchError(status, context: { op: 'checkForUpdate', registry: 'npmjs', url })`
 *  on non-2xx responses so consumers can branch on the structured shape. */
export function fetchLatestFromNpm(timeoutMs?: number): Promise<string>;
export function fetchLatestFromNpm(
  packageName: UpdatePackageName,
  timeoutMs?: number,
  signal?: AbortSignal | undefined,
): Promise<string>;
export async function fetchLatestFromNpm(
  packageOrTimeout: UpdatePackageName | number = 'wrongstack',
  timeoutMs = 3000,
  signal?: AbortSignal | undefined,
): Promise<string> {
  const packageName = typeof packageOrTimeout === 'number' ? 'wrongstack' : packageOrTimeout;
  const effectiveTimeoutMs = typeof packageOrTimeout === 'number' ? packageOrTimeout : timeoutMs;
  const url = npmRegistryUrl(packageName);
  const timeoutSignal = AbortSignal.timeout(effectiveTimeoutMs);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const res = await fetch(url, {
    signal: combinedSignal,
    headers: { Accept: 'application/json' },
  });

  if (!res.ok) {
    throw new FetchError({
      message: `npm registry responded ${res.status}`,
      status: res.status,
      context: { op: 'checkForUpdate', registry: 'npmjs', url },
    });
  }
  const data = (await res.json()) as { version?: unknown | undefined };
  if (typeof data.version === 'string' && parseSemver(data.version)) return data.version;
  throw new Error('No valid version field in npm response');
}

interface CheckForUpdateOptions {
  signal?: AbortSignal | undefined;
  homeFn?: HomeDirFn | undefined;
  packageName?: UpdatePackageName | undefined;
  /** Manual update commands require a live registry result rather than a notification cache hit. */
  forceRefresh?: boolean | undefined;
}

/** Return update info — cache-first for notices, fresh registry data for manual updates. */
export async function checkForUpdate(
  signalOrOptions?: AbortSignal | CheckForUpdateOptions | undefined,
  legacyHomeFn?: HomeDirFn | undefined,
): Promise<UpdateInfo> {
  const options: CheckForUpdateOptions =
    signalOrOptions instanceof AbortSignal
      ? { signal: signalOrOptions, homeFn: legacyHomeFn }
      : (signalOrOptions ?? { homeFn: legacyHomeFn });
  const current = currentVersion();
  const signal = options.signal;
  const packageName = options.packageName ?? 'wrongstack';
  const aborted = () => signal?.aborted ?? false;
  const hf = options.homeFn ?? defaultHomeDir;

  if (aborted()) {
    return { current, latest: current, outdated: false, checkFailed: true };
  }

  const cached = await readCache(hf, packageName);
  if (!options.forceRefresh && cached?.fresh) {
    return {
      current,
      latest: cached.entry.latestVersion,
      outdated: isNewer(cached.entry.latestVersion, current),
      checkFailed: false,
    };
  }

  try {
    const latest = await fetchLatestFromNpm(packageName, 3000, signal);
    await writeCache({ timestamp: Date.now(), latestVersion: latest, packageName }, hf);
    return {
      current,
      latest,
      outdated: isNewer(latest, current),
      checkFailed: false,
    };
  } catch {
    if (aborted()) {
      return { current, latest: current, outdated: false, checkFailed: true };
    }
    if (cached) {
      return {
        current,
        latest: cached.entry.latestVersion,
        outdated: isNewer(cached.entry.latestVersion, current),
        checkFailed: true,
      };
    }
    return { current, latest: current, outdated: false, checkFailed: true };
  }
}

/** Return update notification string if available, null otherwise */
export async function getUpdateNotification(
  signal?: AbortSignal | undefined,
  homeFn?: HomeDirFn | undefined,
): Promise<string | null> {
  const info = await checkForUpdate(signal, homeFn);
  if (info.outdated) {
    return `Update available: v${info.current} → v${info.latest}`;
  }
  return null;
}
