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

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { atomicWrite, withFileLock } from '@wrongstack/core/utils';

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
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) {
      throw new SyntaxError('Invalid file-author log: expected an object with an entries array');
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
 * Load → mutate → save under the log's file lock. Records are fired
 * fire-and-forget per tool call (parallel calls overlap) and from the daemon's
 * techstack consumer, so an unlocked read-modify-write dropped entries.
 */
async function mutateLog(
  storageDir: string,
  projectRoot: string,
  mutate: (log: FileAuthorLog) => void,
): Promise<void> {
  await withFileLock(logPath(storageDir), async () => {
    let log: FileAuthorLog;
    try {
      log = await loadLog(storageDir, projectRoot);
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      // Keep the exact damaged bytes for recovery. Only reset under the write
      // lock, and only after the backup succeeds; I/O failures must still surface.
      const source = logPath(storageDir);
      await fs.copyFile(source, `${source}.corrupt-${randomUUID()}`, fs.constants.COPYFILE_EXCL);
      log = { projectRoot, entries: [] };
    }
    mutate(log);
    await saveLog(storageDir, log);
  });
}

/**
 * Record that an agent created, edited, or deleted a file.
 */
export async function recordFileAction(
  opts: FileAuthorTrackerOptions,
  entry: Omit<FileAuthorEntry, 'timestamp'>,
): Promise<void> {
  const { storageDir, projectRoot, maxEntries = DEFAULT_MAX_ENTRIES } = opts;
  await mutateLog(storageDir, projectRoot, (log) => {
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
  });
}

/** The file-writing tools whose successful calls are recorded as the leader's edits. */
const AUTHORED_TOOLS: Readonly<Record<string, FileAuthorEntry['action']>> = {
  write: 'create',
  edit: 'edit',
  replace: 'edit',
  patch: 'edit',
};

/**
 * Records a finished `tool.executed` call in the file-author log when it wrote a file, as every
 * host does for its leader (the CLI, and the standalone engine behind the desktop), so commit
 * safety can tell which agent touched which file. Best effort: a failed write is ignored.
 */
export function recordToolFileAuthor(
  opts: FileAuthorTrackerOptions,
  event: {
    name: string;
    ok?: boolean | undefined;
    input?: unknown;
    sessionId?: string | undefined;
  },
  sessionId: string,
  record: typeof recordFileAction = recordFileAction,
): Promise<void> | undefined {
  const action = AUTHORED_TOOLS[event.name];
  if (!event.ok || !action) return undefined;
  const filePath = (event.input as Record<string, unknown> | undefined)?.['path'];
  if (typeof filePath !== 'string' || !filePath) return undefined;
  return record(opts, {
    filePath,
    action,
    agentId: 'leader',
    agentName: 'Leader',
    sessionId,
  }).catch(() => {
    /* best-effort */
  });
}

/** The project's file-author log directory (`~/.wrongstack/projects/<slug>`). */
export function fileAuthorStorageDir(paths: { globalRoot: string; projectSlug: string }): string {
  return `${paths.globalRoot}/projects/${paths.projectSlug}`;
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
  return withFileLock(logPath(opts.storageDir), async () => {
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
  });
}
