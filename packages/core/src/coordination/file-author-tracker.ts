/**
 * file-author-tracker — JSON-based tracking of which agent created/edited files.
 *
 * Stores a per-project JSON log in the global project directory:
 *   ~/.wrongstack/projects/<slug-hash>/file-authors.json
 *
 * Each entry records: file path, action (create|edit), agent id/name,
 * timestamp, and optional session id.
 *
 * Used by the tech-stack agent and other coordination tools to know
 * who touched what, so warnings can be routed to the right agent.
 *
 * @module file-author-tracker
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { atomicWrite } from '../utils/atomic-write.js';

export interface FileAuthorEntry {
  /** Absolute or relative file path. */
  filePath: string;
  /** What happened to the file. */
  action: 'create' | 'edit' | 'delete';
  /** Agent id (e.g. 'leader', 'tech-stack', 'executor'). */
  agentId: string;
  /** Human-readable agent name. */
  agentName?: string | undefined;
  /** Session that performed the action. */
  sessionId?: string | undefined;
  /** ISO8601 timestamp. */
  timestamp: string;
  /** Optional commit hash if known. */
  commitHash?: string | undefined;
}

export interface FileAuthorLog {
  /** Project root this log belongs to. */
  projectRoot: string;
  /** All entries, newest last. */
  entries: FileAuthorEntry[];
  /** Last time the log was compacted (old entries archived). */
  lastCompactedAt?: string | undefined;
}

export interface FileAuthorTrackerOptions {
  /** Directory where the JSON log is stored. Usually the global project dir. */
  storageDir: string;
  /** Project root for reference. */
  projectRoot: string;
  /** Max entries before auto-compaction. Default: 5000. */
  maxEntries?: number | undefined;
}

const DEFAULT_MAX_ENTRIES = 5000;
const LOG_FILENAME = 'file-authors.json';

function logPath(storageDir: string): string {
  return path.join(storageDir, LOG_FILENAME);
}

async function loadLog(storageDir: string, projectRoot: string): Promise<FileAuthorLog> {
  try {
    const raw = await fs.readFile(logPath(storageDir), 'utf-8');
    const parsed = JSON.parse(raw) as FileAuthorLog;
    // Validate basic shape
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

async function saveLog(storageDir: string, log: FileAuthorLog): Promise<void> {
  // atomicWrite retries transient Windows rename failures (EPERM/EBUSY from
  // antivirus or watcher handles) and uses a collision-safe tmp suffix.
  await atomicWrite(logPath(storageDir), `${JSON.stringify(log, null, 2)}\n`);
}

/**
 * Record that an agent created, edited, or deleted a file.
 */
export async function recordFileAction(
  opts: FileAuthorTrackerOptions,
  entry: Omit<FileAuthorEntry, 'timestamp'>,
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
 * Get the most recent author entry for a given file path.
 * Returns undefined if no entry exists.
 */
export async function getLastAuthor(
  opts: Pick<FileAuthorTrackerOptions, 'storageDir' | 'projectRoot'>,
  filePath: string,
): Promise<FileAuthorEntry | undefined> {
  const log = await loadLog(opts.storageDir, opts.projectRoot);
  // Normalize path separators for comparison
  const normalizedTarget = filePath.replace(/\\/g, '/');
  for (let i = log.entries.length - 1; i >= 0; i--) {
    const entry = log.entries[i];
    if (entry && entry.filePath.replace(/\\/g, '/') === normalizedTarget) {
      return entry;
    }
  }
  return undefined;
}

/**
 * Get all entries for a file, newest last.
 */
export async function getFileHistory(
  opts: Pick<FileAuthorTrackerOptions, 'storageDir' | 'projectRoot'>,
  filePath: string,
): Promise<FileAuthorEntry[]> {
  const log = await loadLog(opts.storageDir, opts.projectRoot);
  const normalizedTarget = filePath.replace(/\\/g, '/');
  return log.entries.filter((e) => e.filePath.replace(/\\/g, '/') === normalizedTarget);
}

/**
 * Get all files last touched by a specific agent.
 */
export async function getFilesByAgent(
  opts: Pick<FileAuthorTrackerOptions, 'storageDir' | 'projectRoot'>,
  agentId: string,
): Promise<Map<string, FileAuthorEntry>> {
  const log = await loadLog(opts.storageDir, opts.projectRoot);
  const map = new Map<string, FileAuthorEntry>();
  for (const e of log.entries) {
    if (e.agentId === agentId) {
      const normalized = e.filePath.replace(/\\/g, '/');
      // Overwrite — we want the most recent
      map.set(normalized, e);
    }
  }
  return map;
}

/**
 * Return the full log (for debugging/auditing).
 */
export async function getFullLog(
  opts: Pick<FileAuthorTrackerOptions, 'storageDir' | 'projectRoot'>,
): Promise<FileAuthorLog> {
  return loadLog(opts.storageDir, opts.projectRoot);
}

/**
 * Compact the log by archiving old entries to a separate file.
 * Keeps the most recent `keepCount` entries in the active log.
 */
export async function compactLog(
  opts: Pick<FileAuthorTrackerOptions, 'storageDir' | 'projectRoot'>,
  keepCount = 2000,
): Promise<{ archived: number; kept: number }> {
  const log = await loadLog(opts.storageDir, opts.projectRoot);
  if (log.entries.length <= keepCount) {
    return { archived: 0, kept: log.entries.length };
  }

  const archived = log.entries.slice(0, log.entries.length - keepCount);
  const kept = log.entries.slice(-keepCount);

  const archivePath = path.join(opts.storageDir, `file-authors-archive-${Date.now()}.json`);
  await atomicWrite(
    archivePath,
    `${JSON.stringify({ projectRoot: opts.projectRoot, entries: archived }, null, 2)}\n`,
  );

  log.entries = kept;
  log.lastCompactedAt = new Date().toISOString();
  await saveLog(opts.storageDir, log);

  return { archived: archived.length, kept: kept.length };
}
