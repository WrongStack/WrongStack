/**
 * package-author-tracker — Tracks which agent added which package to which manifest.
 *
 * Stores a per-project JSON log in the global project directory:
 *   ~/.wrongstack/projects/<slug-hash>/package-authors.json
 *
 * Each entry records: manifest path, package name, version range at time of add,
 * agent id/name, timestamp, and session id.
 *
 * Used by the tech-stack agent and outdated-watcher to route outdated-package
 * notifications back to the agent that originally added the package.
 *
 * @module package-author-tracker
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { atomicWrite } from '../utils/atomic-write.js';

export interface PackageAuthorEntry {
  /** Absolute or relative path to the manifest (package.json, go.mod, etc.). */
  manifestPath: string;
  /** Exact package name as it appears in the manifest. */
  packageName: string;
  /** Version specifier at time of install (e.g. "^1.2.0", "latest", "file:..."). */
  versionSpec: string;
  /** Ecosystem: 'npm', 'cargo', 'go', 'pip', 'gem', 'composer', 'nuget', etc. */
  ecosystem: string;
  /** Agent id that performed the install (e.g. 'leader', 'executor', 'tech-stack'). */
  agentId: string;
  /** Human-readable agent name. */
  agentName?: string | undefined;
  /** Session that performed the install. */
  sessionId?: string | undefined;
  /** ISO8601 timestamp. */
  timestamp: string;
  /** Whether this package is currently flagged as outdated. */
  outdated?: boolean | undefined;
  /** Latest version available (set by outdated checker). */
  latestVersion?: string | undefined;
}

export interface PackageAuthorLog {
  /** Project root this log belongs to. */
  projectRoot: string;
  /** All entries, newest last. */
  entries: PackageAuthorEntry[];
  /** Last time the log was compacted. */
  lastCompactedAt?: string | undefined;
}

export interface PackageAuthorTrackerOptions {
  /** Directory where the JSON log is stored. Usually the global project dir. */
  storageDir: string;
  /** Project root for reference. */
  projectRoot: string;
  /** Max entries before auto-compaction. Default: 10000. */
  maxEntries?: number | undefined;
}

const DEFAULT_MAX_ENTRIES = 10_000;
const LOG_FILENAME = 'package-authors.json';

function logPath(storageDir: string): string {
  return path.join(storageDir, LOG_FILENAME);
}

async function loadLog(storageDir: string, projectRoot: string): Promise<PackageAuthorLog> {
  try {
    const raw = await fs.readFile(logPath(storageDir), 'utf-8');
    const parsed = JSON.parse(raw) as PackageAuthorLog;
    if (!parsed.entries || !Array.isArray(parsed.entries)) {
      return { projectRoot, entries: [] };
    }
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { projectRoot, entries: [] };
    }
    throw err;
  }
}

async function saveLog(storageDir: string, log: PackageAuthorLog): Promise<void> {
  // atomicWrite retries transient Windows rename failures (EPERM/EBUSY from
  // antivirus or indexer handles on the destination) that a bare fs.rename
  // surfaces as a hard error.
  await atomicWrite(logPath(storageDir), `${JSON.stringify(log, null, 2)}\n`);
}

/**
 * Detect the ecosystem from a manifest filename.
 */
export function detectEcosystem(manifestPath: string): string {
  // win32.basename handles BOTH separators — manifest paths recorded on a
  // Windows agent must still classify on a POSIX host (and vice versa).
  const name = path.win32.basename(manifestPath).toLowerCase();
  if (name === 'package.json') return 'npm';
  if (name === 'go.mod') return 'go';
  if (name === 'cargo.toml') return 'cargo';
  if (
    name === 'pyproject.toml' ||
    name === 'requirements.txt' ||
    name === 'pipfile' ||
    name === 'pipfile.lock'
  )
    return 'pip';
  if (name === 'gemfile' || name === 'gemfile.lock') return 'gem';
  if (name === 'composer.json' || name === 'composer.lock') return 'composer';
  if (name.endsWith('.csproj') || name === 'packages.config') return 'nuget';
  if (name === 'mix.exs' || name === 'mix.lock') return 'elixir';
  if (name === 'pom.xml' || name.startsWith('build.gradle')) return 'maven';
  if (name === 'pubspec.yaml' || name === 'pubspec.lock') return 'dart';
  if (name === 'vcpkg.json') return 'vcpkg';
  if (name === 'conanfile.txt' || name === 'conanfile.py') return 'conan';
  if (name === 'cmakelists.txt') return 'cmake';
  return 'unknown';
}

/**
 * Record that an agent added (or updated) a package to a manifest file.
 *
 * If the same (manifestPath, packageName) entry already exists, the previous
 * entry is kept (for audit trail) and a new entry is appended.
 */
export async function recordPackageAction(
  opts: PackageAuthorTrackerOptions,
  entry: Omit<PackageAuthorEntry, 'timestamp'>,
): Promise<void> {
  const { storageDir, projectRoot, maxEntries = DEFAULT_MAX_ENTRIES } = opts;
  const log = await loadLog(storageDir, projectRoot);

  log.entries.push({
    ...entry,
    timestamp: new Date().toISOString(),
  });

  // Auto-compact: if over max, keep the newest 80%
  if (log.entries.length > maxEntries) {
    const keep = Math.floor(maxEntries * 0.8);
    log.entries = log.entries.slice(-keep);
    log.lastCompactedAt = new Date().toISOString();
  }

  await saveLog(storageDir, log);
}

/**
 * Get the most recent author entry for a given (manifest, package) pair.
 * Returns undefined if no entry exists.
 */
export async function getPackageAuthor(
  opts: Pick<PackageAuthorTrackerOptions, 'storageDir' | 'projectRoot'>,
  manifestPath: string,
  packageName: string,
): Promise<PackageAuthorEntry | undefined> {
  const log = await loadLog(opts.storageDir, opts.projectRoot);
  const normalizedManifest = manifestPath.replace(/\\/g, '/');
  for (let i = log.entries.length - 1; i >= 0; i--) {
    const e = log.entries[i];
    if (
      e &&
      e.manifestPath.replace(/\\/g, '/') === normalizedManifest &&
      e.packageName === packageName
    ) {
      return e;
    }
  }
  return undefined;
}

/**
 * Get all packages in a manifest that have an author on record.
 */
export async function getManifestPackages(
  opts: Pick<PackageAuthorTrackerOptions, 'storageDir' | 'projectRoot'>,
  manifestPath: string,
): Promise<PackageAuthorEntry[]> {
  const log = await loadLog(opts.storageDir, opts.projectRoot);
  const normalizedManifest = manifestPath.replace(/\\/g, '/');
  return log.entries.filter((e) => e.manifestPath.replace(/\\/g, '/') === normalizedManifest);
}

/**
 * Get all packages last tracked by a specific agent.
 * Returns a Map from (manifestPath, packageName) → entry.
 */
export async function getPackagesByAgent(
  opts: Pick<PackageAuthorTrackerOptions, 'storageDir' | 'projectRoot'>,
  agentId: string,
): Promise<Map<string, PackageAuthorEntry>> {
  const log = await loadLog(opts.storageDir, opts.projectRoot);
  const map = new Map<string, PackageAuthorEntry>();
  for (const e of log.entries) {
    if (e.agentId === agentId) {
      const normPath = e.manifestPath.replace(/\\/g, '/');
      const key = `${normPath}|${e.packageName}`;
      map.set(key, e);
    }
  }
  return map;
}

/**
 * Update the outdated status of a package entry (adds or replaces the entry
 * for the given manifest+package, appending to the log for audit).
 */
export async function updatePackageOutdatedStatus(
  opts: PackageAuthorTrackerOptions,
  manifestPath: string,
  packageName: string,
  outdated: boolean,
  latestVersion?: string | undefined,
): Promise<void> {
  const { storageDir, projectRoot } = opts;
  const log = await loadLog(storageDir, projectRoot);

  // Append a status-update entry (never mutate existing entries — audit trail)
  log.entries.push({
    manifestPath,
    packageName,
    versionSpec: '',
    ecosystem: detectEcosystem(manifestPath),
    agentId: 'outdated-checker',
    timestamp: new Date().toISOString(),
    outdated,
    latestVersion,
  });

  await saveLog(storageDir, log);
}

/**
 * Return the full log (for debugging/auditing).
 */
export async function getFullPackageLog(
  opts: Pick<PackageAuthorTrackerOptions, 'storageDir' | 'projectRoot'>,
): Promise<PackageAuthorLog> {
  return loadLog(opts.storageDir, opts.projectRoot);
}
