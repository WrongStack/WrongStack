import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ERROR_CODES, FsError } from '@wrongstack/contracts/types';
import { isSecretField } from '@wrongstack/core/security';
import { atomicWrite, toErrorMessage, withFileLock, writeErr } from '@wrongstack/core/utils';
import type { HomeDirFn } from './config-history-support.js';
import {
  assertSafeToDelete,
  checkConfigOwnership,
  configPath,
  defaultHomeDir,
  defaultUidFn,
  maskConfigSecrets,
  reviveSecrets,
} from './config-history-support.js';

const MAX_CONFIG_BACKUPS = 10;
export const MAX_CONFIG_HISTORY_ENTRIES = 50;

/**
 * Safely delete a file only if it passes safety checks.
 * Never throws — errors are swallowed (best-effort).
 */
async function safeDelete(filePath: string): Promise<void> {
  const dir = path.dirname(filePath);
  const filename = path.basename(filePath);
  try {
    assertSafeToDelete(filename, dir);
    await fs.unlink(filePath);
  } catch (err) {
    // Log but don't crash — safety check violations are logged for debugging
    if (err instanceof Error && err.message.startsWith('Refusing')) {
      writeErr(`[config-history] SAFETY: ${err.message}\n`);
    }
    // Best-effort — ignore other errors (file doesn't exist, etc.)
  }
}

export interface HistoryEntry {
  id: string;
  timestamp: string;
  description: string;
  snapshotMasked: Record<string, unknown>;
  diffSummary: string;
}

interface HistoryIndex {
  version: 1;
  entries: Array<{ id: string; timestamp: string; description: string }>;
}

function diffSummary(oldCfg: Record<string, unknown>, newCfg: Record<string, unknown>): string {
  const changes: string[] = [];
  const allKeys = new Set([...Object.keys(oldCfg), ...Object.keys(newCfg)]);
  for (const k of allKeys) {
    const o = JSON.stringify(oldCfg[k]);
    const n = JSON.stringify(newCfg[k]);
    if (o !== n) {
      if (isSecretField(k)) {
        changes.push(`${k}: [CHANGED]`);
      } else if (typeof newCfg[k] !== 'object') {
        changes.push(`${k}: ${oldCfg[k] ?? '(unset)'} → ${newCfg[k]}`);
      } else {
        changes.push(`${k}: [CHANGED]`);
      }
    }
  }
  return changes.length > 0 ? changes.slice(0, 5).join(', ') : 'no changes';
}

function historyDir(homeFn: HomeDirFn = defaultHomeDir, targetConfigPath?: string): string {
  return path.join(path.dirname(configPath(homeFn, targetConfigPath)), 'config.history', 'entries');
}

function historyIndexPath(homeFn: HomeDirFn = defaultHomeDir, targetConfigPath?: string): string {
  return path.join(
    path.dirname(configPath(homeFn, targetConfigPath)),
    'config.history',
    'index.json',
  );
}

function backupLastPath(homeFn: HomeDirFn = defaultHomeDir, targetConfigPath?: string): string {
  return `${configPath(homeFn, targetConfigPath)}.last`;
}

function entryId(ts: string): string {
  return `${ts.replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
}

async function ensureHistoryDir(
  homeFn: HomeDirFn = defaultHomeDir,
  targetConfigPath?: string,
): Promise<void> {
  try {
    await fs.mkdir(historyDir(homeFn, targetConfigPath), { recursive: true });
  } catch (err) {
    throw new FsError({
      message: toErrorMessage(err),
      code: ERROR_CODES.FS_MKDIR_FAILED,
      path: historyDir(homeFn, targetConfigPath),
      cause: err,
    });
  }
}

async function readIndex(
  homeFn: HomeDirFn = defaultHomeDir,
  targetConfigPath?: string,
): Promise<HistoryIndex> {
  let raw: string;
  try {
    raw = await fs.readFile(historyIndexPath(homeFn, targetConfigPath), 'utf8');
  } catch (err) {
    // appendHistory prunes every entry file the index does not list, so an
    // empty stand-in for an index that is merely unreadable right now (EBUSY,
    // EPERM) would delete the whole history. Only a missing index is rebuilt.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return rebuildIndexFromEntries(homeFn, targetConfigPath);
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    // `as HistoryIndex` was an unchecked type assertion: it only covered a
    // PARSE failure, so valid JSON of the wrong shape came back typed as an
    // index and consumers then assumed `entries` was an array —
    // `idx.entries.unshift` threw in appendHistory, and listHistory returned
    // undefined despite its declared Promise<HistoryIndex['entries']>. The
    // catch below already treats an untrustworthy index as "use the safe
    // empty default"; a shape failure is equally untrustworthy and now takes
    // the same path. Entries without a string `id` are dropped: nothing can
    // address their file, and keeping them would target `undefined.json`.
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as HistoryIndex).entries)) {
      const entries = (parsed as HistoryIndex).entries.filter(
        (e): e is HistoryIndex['entries'][number] =>
          e !== null && typeof e === 'object' && typeof (e as { id?: unknown }).id === 'string',
      );
      return { version: 1, entries };
    }
  } catch {
    // corrupt — rebuilt below
  }
  return rebuildIndexFromEntries(homeFn, targetConfigPath);
}

/**
 * Recover the index from the self-describing entry files (newest first) when
 * the index itself is missing or untrustworthy, instead of starting from an
 * empty one whose next prune would delete every snapshot.
 */
async function rebuildIndexFromEntries(
  homeFn: HomeDirFn = defaultHomeDir,
  targetConfigPath?: string,
): Promise<HistoryIndex> {
  const dir = historyDir(homeFn, targetConfigPath);
  let files: string[];
  try {
    files = (await fs.readdir(dir)).filter((file) => file.endsWith('.json'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, entries: [] };
    throw err;
  }
  const entries: HistoryIndex['entries'] = [];
  for (const file of files) {
    const id = file.slice(0, -'.json'.length);
    let raw: string;
    try {
      raw = await fs.readFile(path.join(dir, file), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      // Unreadable right now: indexed by its file name so the sweep keeps it.
      entries.push({ id, timestamp: '', description: '' });
      continue;
    }
    try {
      const entry = JSON.parse(raw) as Partial<HistoryEntry>;
      // Only a real snapshot is adopted; anything else stays an orphan.
      if (entry.id === id && typeof entry.timestamp === 'string') {
        entries.push({
          id,
          timestamp: entry.timestamp,
          description: typeof entry.description === 'string' ? entry.description : '',
        });
      }
    } catch {
      // not a snapshot
    }
  }
  entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return { version: 1, entries };
}

async function writeIndex(
  idx: HistoryIndex,
  homeFn: HomeDirFn = defaultHomeDir,
  targetConfigPath?: string,
): Promise<void> {
  await ensureHistoryDir(homeFn, targetConfigPath);
  // atomicWrite: torn write here would wipe the entire config-history
  // index, hiding the user's prior backups behind a "no history" UI.
  try {
    await atomicWrite(historyIndexPath(homeFn, targetConfigPath), JSON.stringify(idx, null, 2));
  } catch (err) {
    throw new FsError({
      message: toErrorMessage(err),
      code: ERROR_CODES.FS_ATOMIC_WRITE_FAILED,
      path: historyIndexPath(homeFn, targetConfigPath),
      cause: err,
    });
  }
}

async function pruneHistoryEntries(
  idx: HistoryIndex,
  homeFn: HomeDirFn = defaultHomeDir,
  targetConfigPath?: string,
): Promise<void> {
  const removed = idx.entries.splice(MAX_CONFIG_HISTORY_ENTRIES);
  const keep = new Set(idx.entries.map((entry) => `${entry.id}.json`));
  const dir = historyDir(homeFn, targetConfigPath);

  for (const entry of removed) {
    try {
      await fs.unlink(path.join(dir, `${entry.id}.json`));
    } catch {
      // best-effort: stale index entries should not block config writes
    }
  }

  try {
    const files = await fs.readdir(dir);
    await Promise.all(
      files
        .filter((file) => file.endsWith('.json') && !keep.has(file))
        .map(async (file) => {
          try {
            await fs.unlink(path.join(dir, file));
          } catch {
            // best-effort: orphan cleanup should not block config writes
          }
        }),
    );
  } catch {
    // best-effort: missing history dir or readdir failure should not block writes
  }
}

/**
 * Backup current config.json → config.json.last and timestamped .bak files.
 * Safe to call even if config.json doesn't exist. Never throws.
 *
 * IMPORTANT: config.json and .key are never deleted by this function.
 * Only config.json.*.bak timestamped snapshots are pruned.
 */
export async function backupCurrent(
  homeFn: HomeDirFn = defaultHomeDir,
  targetConfigPath?: string,
): Promise<void> {
  const cfg = configPath(homeFn, targetConfigPath);
  const last = backupLastPath(homeFn, targetConfigPath);
  const ts = Date.now();

  // Read existing config content for .last backup
  let content: string | undefined;
  try {
    content = await fs.readFile(cfg, 'utf8');
  } catch {
    // May not exist yet — that's fine, we just skip the backup
  }

  if (content !== undefined) {
    try {
      // `content` is a verbatim copy of the live config, secrets included —
      // same 0600 the config itself gets.
      await atomicWrite(last, content, { mode: 0o600 });
    } catch (err) {
      writeErr(`[config-history] .last backup failed: ${toErrorMessage(err)}`);
    }
  }

  // Create timestamped snapshot
  if (content !== undefined) {
    try {
      const bakPath = `${cfg}.${ts}.bak`;
      await atomicWrite(bakPath, content, { mode: 0o600 });
    } catch (err) {
      writeErr(`[config-history] timestamped backup failed: ${toErrorMessage(err)}`);
    }
  }

  // Prune old .bak files — keep last 10
  try {
    const dir = path.dirname(cfg);
    const files = await fs.readdir(dir);
    const baks = files
      .filter((f) => f.startsWith('config.json.') && f.endsWith('.bak'))
      .sort()
      .reverse();
    for (const f of baks.slice(MAX_CONFIG_BACKUPS)) {
      await safeDelete(path.join(dir, f));
    }
  } catch (err) {
    writeErr(`[config-history] backup prune failed: ${toErrorMessage(err)}`);
  }
}

/**
 * Append a history entry for a config change.
 */
export async function appendHistory(
  oldCfg: Record<string, unknown>,
  newCfg: Record<string, unknown>,
  description: string,
  homeFn: HomeDirFn = defaultHomeDir,
  targetConfigPath?: string,
): Promise<string> {
  const timestamp = new Date().toISOString();
  const id = entryId(timestamp);

  await ensureHistoryDir(homeFn, targetConfigPath);

  const entry: HistoryEntry = {
    id,
    timestamp,
    description,
    snapshotMasked: maskConfigSecrets(newCfg) as Record<string, unknown>,
    diffSummary: diffSummary(oldCfg, newCfg),
  };

  try {
    await fs.writeFile(
      path.join(historyDir(homeFn, targetConfigPath), `${id}.json`),
      JSON.stringify(entry, null, 2),
      { encoding: 'utf8', mode: 0o600 },
    );
  } catch (err) {
    throw new FsError({
      message: toErrorMessage(err),
      code: ERROR_CODES.FS_WRITE_FAILED,
      path: path.join(historyDir(homeFn, targetConfigPath), `${id}.json`),
      cause: err,
    });
  }

  await withFileLock(historyIndexPath(homeFn, targetConfigPath), async () => {
    const idx = await readIndex(homeFn, targetConfigPath);
    // A rebuilt index already lists the entry file written above.
    idx.entries = idx.entries.filter((e) => e.id !== id);
    idx.entries.unshift({ id, timestamp, description });
    await pruneHistoryEntries(idx, homeFn, targetConfigPath);
    await writeIndex(idx, homeFn, targetConfigPath);
  });

  return id;
}

/**
 * List all history entries (newest first).
 */
export async function listHistory(
  homeFn: HomeDirFn = defaultHomeDir,
  targetConfigPath?: string,
): Promise<HistoryIndex['entries']> {
  const idx = await readIndex(homeFn, targetConfigPath);
  return idx.entries;
}

/**
 * Get a specific history entry by ID.
 */
export async function getHistoryEntry(
  id: string,
  homeFn: HomeDirFn = defaultHomeDir,
  targetConfigPath?: string,
): Promise<HistoryEntry | null> {
  const dir = historyDir(homeFn, targetConfigPath);
  const filePath = path.join(dir, `${id}.json`);
  // An id addresses exactly ONE file inside the entries dir. `path.join`
  // normalises `..`, so a traversing id (`../../secret`) resolved outside that
  // dir — turning a config-history lookup into an arbitrary-file read, and via
  // restoreFromHistory (which writes reviveSecrets(entry.snapshotMasked) to
  // config.json) into arbitrary config injection. `assertSafeToDelete` already
  // enforces the same rule on the delete path; this is its read-side twin.
  if (path.dirname(path.resolve(filePath)) !== path.resolve(dir)) return null;
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw) as HistoryEntry;
  } catch {
    return null;
  }
}

/**
 * Restore config.json to a given history entry's snapshot.
 */
export async function restoreFromHistory(
  id: string,
  homeFn: HomeDirFn = defaultHomeDir,
  targetConfigPath?: string,
): Promise<{ ok: boolean; backupId: string | null; error?: string | undefined }> {
  const entry = await getHistoryEntry(id, homeFn, targetConfigPath);
  if (!entry) return { ok: false, backupId: null, error: 'History entry not found' };

  // Ownership guard — refuse to write config.json if the calling process
  // does not own the file. Prevents one user on a multi-user system from
  // overwriting another user's config via a shared wrongstack install.
  if (!(await checkConfigOwnership(homeFn, defaultUidFn, targetConfigPath))) {
    return {
      ok: false,
      backupId: null,
      error: 'Operation denied: config file is not owned by current user',
    };
  }

  const cfg = configPath(homeFn, targetConfigPath);
  return withFileLock(cfg, async () => {
    await backupCurrent(homeFn, targetConfigPath);

    // The live config is where the snapshot's masked secrets are revived from.
    // Only a missing file may read as `{}`: an unreadable one (an editor BOM
    // used to land here) revived nothing, and the restore wrote a config with
    // every API key deleted while reporting success.
    let oldCfg: Record<string, unknown> = {};
    try {
      const raw = await fs.readFile(cfg, 'utf8');
      oldCfg = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        return {
          ok: false,
          backupId: null,
          error: `Cannot read the current config to carry its secrets over: ${toErrorMessage(err)}`,
        };
      }
    }

    // Carry live credentials across the restore — see `reviveSecrets`. Written
    // 0600 like every other config write: this file holds the revived secrets.
    const restored = reviveSecrets(entry.snapshotMasked, oldCfg) as Record<string, unknown>;

    try {
      await atomicWrite(cfg, JSON.stringify(restored, null, 2), { mode: 0o600 });
    } catch (err) {
      return { ok: false, backupId: null, error: String(err) };
    }

    const backupId = await appendHistory(
      oldCfg,
      restored,
      `Restored from history ${id}`,
      homeFn,
      targetConfigPath,
    );

    return { ok: true, backupId };
  });
}

/**
 * Restore config.json to the .last backup.
 */
export async function restoreLast(
  homeFn: HomeDirFn = defaultHomeDir,
  targetConfigPath?: string,
): Promise<{ ok: boolean; error?: string | undefined }> {
  const last = backupLastPath(homeFn, targetConfigPath);
  const cfg = configPath(homeFn, targetConfigPath);

  let lastCfg: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(last, 'utf8');
    // `.last` is a byte copy of the live config, editor BOM included.
    lastCfg = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch {
    return { ok: false, error: 'No prior backup found' };
  }

  // Ownership guard — refuse to write config.json if the calling process
  // does not own the file. Prevents one user on a multi-user system from
  // overwriting another user's config via a shared wrongstack install.
  if (!(await checkConfigOwnership(homeFn, defaultUidFn, targetConfigPath))) {
    return { ok: false, error: 'Operation denied: config file is not owned by current user' };
  }

  return withFileLock(cfg, async () => {
    let oldCfg: Record<string, unknown> = {};
    try {
      const raw = await fs.readFile(cfg, 'utf8');
      oldCfg = JSON.parse(raw);
    } catch {
      // Ignore
    }

    await backupCurrent(homeFn, targetConfigPath);

    try {
      await atomicWrite(cfg, JSON.stringify(lastCfg, null, 2), { mode: 0o600 });
    } catch (err) {
      return { ok: false, error: String(err) };
    }

    await appendHistory(
      oldCfg,
      lastCfg,
      'Restored from config.json.last',
      homeFn,
      targetConfigPath,
    );

    return { ok: true };
  });
}
