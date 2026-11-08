import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

/**
 * Whether a newer WrongStack release exists than the one this server runs, for a host that is a
 * released executable (the desktop engine). The CLI checks before it starts its WebUI and hands
 * the answer over; a standalone host has no CLI in front of it, so it asks GitHub itself.
 *
 * It reads and writes the profile's update cache in the CLI's format for the standalone
 * executable (`packageName: 'standalone-binary'`), so the CLI and the engine share one answer
 * and GitHub is asked at most once a day between them.
 */

export const RELEASES_LATEST_URL =
  'https://api.github.com/repos/WrongStack/WrongStack/releases/latest';
const CACHE_PACKAGE = 'standalone-binary';
const DAY_MS = 24 * 60 * 60 * 1000;

/** The `session.start` fields the WebUI's update banner and the desktop's notice read. */
export interface AppUpdateInfo {
  appVersion: string;
  latestVersion?: string | undefined;
  updateAvailable: boolean;
  updateCheckFailed: boolean;
}

export interface AppUpdateCheckOptions {
  currentVersion: string;
  /** The profile's update cache file (`wpaths.profileUpdateCache(profileName)`). */
  cacheFile: string;
  fetchImpl?: typeof fetch | undefined;
  now?: (() => number) | undefined;
  timeoutMs?: number | undefined;
  /** How often a long-running host looks again; the cache still limits it to once a day. */
  intervalMs?: number | undefined;
}

export interface AppUpdateCheck {
  info(): AppUpdateInfo;
  /** Asks GitHub unless the cached answer is less than a day old. Never throws. */
  refresh(): Promise<void>;
  /** Refreshes now and then periodically; returns the stop function. */
  start(): () => void;
  /** `/tuneup`'s version line: refreshes (cache-first) and reports the CLI's update shape. */
  tuneupInfo(): Promise<{
    current: string;
    latest: string;
    outdated: boolean;
    checkFailed: boolean;
  }>;
}

type Semver = { core: [number, number, number]; pre: string };

function parseSemver(raw: string): Semver | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(raw.trim());
  if (!match) return null;
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ?? '' };
}

/** True when `a` is a later version than `b`; an unreadable version is never later. */
export function isNewerVersion(a: string, b: string): boolean {
  const av = parseSemver(a);
  const bv = parseSemver(b);
  if (!av || !bv) return false;
  for (let i = 0; i < 3; i++) {
    if (av.core[i] !== bv.core[i]) return (av.core[i] ?? 0) > (bv.core[i] ?? 0);
  }
  if (av.pre === bv.pre) return false;
  // A release outranks any prerelease of the same version.
  if (!av.pre) return true;
  if (!bv.pre) return false;
  return av.pre.localeCompare(bv.pre, 'en', { numeric: true }) > 0;
}

function readCache(file: string): { latestVersion: string; timestamp: number } | null {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const latestVersion = value['latestVersion'];
    const timestamp = value['timestamp'];
    if (value['packageName'] !== CACHE_PACKAGE) return null;
    if (typeof latestVersion !== 'string' || !parseSemver(latestVersion)) return null;
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return null;
    return { latestVersion, timestamp };
  } catch {
    return null;
  }
}

function writeCache(file: string, latestVersion: string, timestamp: number): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(
      temp,
      JSON.stringify({ timestamp, latestVersion, packageName: CACHE_PACKAGE }, null, 2),
    );
    renameSync(temp, file);
  } catch {
    // Best effort: the next start asks again.
  }
}

async function fetchLatest(fetchImpl: typeof fetch, timeoutMs: number): Promise<string> {
  const res = await fetchImpl(RELEASES_LATEST_URL, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'wrongstack-desktop' },
  });
  if (!res.ok) throw new Error(`GitHub releases responded ${res.status}`);
  const data = (await res.json()) as { tag_name?: unknown };
  const tag = typeof data.tag_name === 'string' ? data.tag_name.replace(/^v/, '') : '';
  if (!parseSemver(tag)) throw new Error('Latest release has no version tag');
  return tag;
}

export function createAppUpdateCheck(options: AppUpdateCheckOptions): AppUpdateCheck {
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetchImpl ?? fetch;
  const cached = readCache(options.cacheFile);
  let latest = cached?.latestVersion;
  let checkedAt = cached?.timestamp ?? 0;
  let failed = false;
  let inflight: Promise<void> | undefined;

  const refresh = (): Promise<void> => {
    if (latest && now() - checkedAt < DAY_MS) return Promise.resolve();
    inflight ??= (async () => {
      try {
        const found = await fetchLatest(fetchImpl, options.timeoutMs ?? 5000);
        latest = found;
        checkedAt = now();
        failed = false;
        writeCache(options.cacheFile, found, checkedAt);
      } catch {
        failed = true;
      } finally {
        inflight = undefined;
      }
    })();
    return inflight;
  };

  return {
    info: () => ({
      appVersion: options.currentVersion,
      ...(latest ? { latestVersion: latest } : {}),
      updateAvailable: latest !== undefined && isNewerVersion(latest, options.currentVersion),
      updateCheckFailed: failed,
    }),
    refresh,
    tuneupInfo: async () => {
      await refresh();
      return {
        current: options.currentVersion,
        latest: latest ?? options.currentVersion,
        outdated: latest !== undefined && isNewerVersion(latest, options.currentVersion),
        checkFailed: failed,
      };
    },
    start: () => {
      void refresh();
      const timer = setInterval(() => void refresh(), options.intervalMs ?? 6 * 60 * 60 * 1000);
      timer.unref?.();
      return () => clearInterval(timer);
    },
  };
}
