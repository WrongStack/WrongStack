import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import * as path from 'node:path';
import { atomicWrite, resolveWstackPaths, writeErr } from '@wrongstack/core/utils';
import { ERROR_CODES, FsError } from '@wrongstack/core/types';
import { isSecretField } from '@wrongstack/core/security';
import { toErrorMessage } from '@wrongstack/core/utils';

// ── UID ownership ──────────────────────────────────────────────────────────

type UidFn = () => string | number | undefined;
const defaultUidFn: UidFn = () => os.userInfo().uid;

async function getFileUid(filePath: string): Promise<string | number | undefined> {
  try {
    const stat = await fs.stat(filePath);
    return stat.uid;
  } catch {
    return undefined;
  }
}

/**
 * Verify the calling process owns config.json before allowing a write operation.
 * Guards against one user on a shared multi-user system overwriting another's config.
 *
 * On Windows, .uid is always undefined on the UserInfo object, and the NT ACL
 * model already restricts writes — so we skip the check on win32.
 * On Unix, we compare the process euid against the file's uid.
 * If config.json doesn't exist yet, we allow the write (first-time setup).
 */
async function checkConfigOwnership(
  homeFn: HomeDirFn,
  uidFn: UidFn = defaultUidFn,
  targetConfigPath?: string,
): Promise<boolean> {
  if (os.platform() === 'win32') return true; // ACLs handle this on Windows

  const cfg = configPath(homeFn, targetConfigPath);
  const fileUid = await getFileUid(cfg);
  if (fileUid === undefined) return true; // file doesn't exist yet — allow

  const callerUid = uidFn();
  if (callerUid === undefined) return true; // can't determine — allow, don't block

  return fileUid === callerUid;
}

// ── Protected files/directories ────────────────────────────────────
// These are NEVER touched by any operation in this module.
// Guards against bugs (glob patterns, typos, race conditions)
// accidentally deleting critical user data.
const PROTECTED_BASENAMES = new Set(['config.json', '.key', 'index.json']);
const MAX_CONFIG_BACKUPS = 10;
export const MAX_CONFIG_HISTORY_ENTRIES = 50;

// Top-level directories that should never be deleted even if a prune
// pattern accidentally widens. These are absolute directory names
// relative to the .wrongstack root.

/**
 * Guard: throw if `filename` is a protected file or lives inside a protected
 * directory. Used before any unlink / rm call to make accidentally deleting
 * critical files impossible.
 */
function assertSafeToDelete(filename: string, parentDir: string): void {
  // 1. Exact-match protected files
  if (PROTECTED_BASENAMES.has(filename)) {
    throw new FsError({
      message: `Refusing to delete protected file: ${filename}`,
      code: ERROR_CODES.FS_DELETE_FAILED,
      path: path.join(parentDir, filename),
      context: { reason: 'protected_basename' },
    });
  }
  // 2. No path traversal
  if (filename !== path.basename(filename)) {
    throw new FsError({
      message: `Refusing to delete path with traversal: ${filename}`,
      code: ERROR_CODES.FS_DELETE_FAILED,
      path: filename,
      context: { reason: 'path_traversal' },
    });
  }
  // 3. Validate it's a timestamped config backup (config.json.{ts}.bak)
  //    before we ever consider deleting it.
  if (!filename.startsWith('config.json.') || !filename.endsWith('.bak')) {
    // Unknown files — be conservative, refuse
    throw new FsError({
      message: `Refusing to delete unknown file: ${filename}`,
      code: ERROR_CODES.FS_DELETE_FAILED,
      path: path.join(parentDir, filename),
      context: { reason: 'unknown_file_pattern' },
    });
  }
  // 4. Check parent is the .wrongstack root and the target is not a dir
  const resolvedParent = path.resolve(parentDir);
  const parentOfProfile = path.dirname(resolvedParent);
  const isGlobalRoot = path.basename(resolvedParent) === '.wrongstack';
  const isProfileDir =
    path.basename(parentOfProfile) === 'profiles' &&
    path.basename(path.dirname(parentOfProfile)) === '.wrongstack';
  if (!isGlobalRoot && !isProfileDir) {
    throw new FsError({
      message: `Unexpected parent directory for bak prune: ${resolvedParent}`,
      code: ERROR_CODES.FS_DELETE_FAILED,
      path: resolvedParent,
      context: { reason: 'invalid_parent' },
    });
  }
}

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

/** Placeholder written in place of every secret value in a history snapshot. */
const REDACTED = '[REDACTED]';

/**
 * Recurse into a value for masking. Arrays are walked too: a provider's saved
 * credentials live in `providers.<id>.apiKeys[]`, so skipping arrays wrote the
 * real `apiKey` of every saved key into `history/<id>.json` in cleartext —
 * masking the scalar spelling while the array spelling went through untouched.
 */
function maskValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(maskValue);
  if (typeof v === 'object' && v !== null) return maskConfigSecrets(v as Record<string, unknown>);
  return v;
}

function maskConfigSecrets(cfg: Record<string, unknown>): Record<string, unknown> {
  if (typeof cfg !== 'object' || cfg === null) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cfg)) {
    if (isSecretField(k)) {
      out[k] = REDACTED;
    } else {
      out[k] = maskValue(v);
    }
  }
  return out;
}

/**
 * Rebuild a writable config from a masked history snapshot.
 *
 * History deliberately never stores secrets, so a snapshot cannot restore them
 * — but writing it back verbatim replaced every live credential with the
 * literal `"[REDACTED]"`, which the next boot reads as a plaintext key and
 * every request 401s. Instead: take the structure from the snapshot and carry
 * each masked value over from the config that is on disk right now. When the
 * current config has no value at that path the key is dropped rather than
 * materialising the placeholder.
 */
function reviveSecrets(masked: unknown, current: unknown): unknown {
  if (masked === REDACTED) return current;
  if (Array.isArray(masked)) {
    const cur = Array.isArray(current) ? current : [];
    return masked.map((item, i) => reviveSecrets(item, cur[i]));
  }
  if (typeof masked !== 'object' || masked === null) return masked;

  const curObj =
    typeof current === 'object' && current !== null && !Array.isArray(current)
      ? (current as Record<string, unknown>)
      : {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(masked as Record<string, unknown>)) {
    const revived = reviveSecrets(v, curObj[k]);
    // A secret with no counterpart in the live config: omit it entirely.
    if (revived === undefined) continue;
    out[k] = revived;
  }
  return out;
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

type HomeDirFn = () => string;
const defaultHomeDir: HomeDirFn = () => os.homedir();

function activeProfileConfigPath(homeFn: HomeDirFn): string {
  const paths =
    homeFn === defaultHomeDir
      ? resolveWstackPaths({ projectRoot: process.cwd() })
      : resolveWstackPaths({ projectRoot: process.cwd(), userHome: homeFn() });
  return paths.profileConfig(paths.profileName);
}

function historyDir(homeFn: HomeDirFn = defaultHomeDir, targetConfigPath?: string): string {
  return path.join(path.dirname(configPath(homeFn, targetConfigPath)), 'config.history', 'entries');
}

function historyIndexPath(homeFn: HomeDirFn = defaultHomeDir, targetConfigPath?: string): string {
  return path.join(path.dirname(configPath(homeFn, targetConfigPath)), 'config.history', 'index.json');
}

function configPath(homeFn: HomeDirFn = defaultHomeDir, targetConfigPath?: string): string {
  return targetConfigPath ?? activeProfileConfigPath(homeFn);
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
  try {
    const raw = await fs.readFile(historyIndexPath(homeFn, targetConfigPath), 'utf8');
    return JSON.parse(raw) as HistoryIndex;
  } catch {
    return { version: 1, entries: [] };
  }
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
      writeErr(
        `[config-history] .last backup failed: ${toErrorMessage(err)}`,
      );
    }
  }

  // Create timestamped snapshot
  if (content !== undefined) {
    try {
      const bakPath = `${cfg}.${ts}.bak`;
      await atomicWrite(bakPath, content, { mode: 0o600 });
    } catch (err) {
      writeErr(
        `[config-history] timestamped backup failed: ${toErrorMessage(err)}`,
      );
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
    writeErr(
      `[config-history] backup prune failed: ${toErrorMessage(err)}`,
    );
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

  const idx = await readIndex(homeFn, targetConfigPath);
  idx.entries.unshift({ id, timestamp, description });
  await pruneHistoryEntries(idx, homeFn, targetConfigPath);
  await writeIndex(idx, homeFn, targetConfigPath);

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
  try {
    const raw = await fs.readFile(
      path.join(historyDir(homeFn, targetConfigPath), `${id}.json`),
      'utf8',
    );
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

  await backupCurrent(homeFn, targetConfigPath);

  let oldCfg: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(configPath(homeFn, targetConfigPath), 'utf8');
    oldCfg = JSON.parse(raw);
  } catch {
    // No config to restore from
  }

  // Carry live credentials across the restore — see `reviveSecrets`. Written
  // 0600 like every other config write: this file holds the revived secrets.
  const restored = reviveSecrets(entry.snapshotMasked, oldCfg) as Record<string, unknown>;

  try {
    await atomicWrite(configPath(homeFn, targetConfigPath), JSON.stringify(restored, null, 2), {
      mode: 0o600,
    });
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

  let oldCfg: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(cfg, 'utf8');
    oldCfg = JSON.parse(raw);
  } catch {
    // Ignore
  }

  let lastCfg: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(last, 'utf8');
    lastCfg = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'No prior backup found' };
  }

  // Ownership guard — refuse to write config.json if the calling process
  // does not own the file. Prevents one user on a multi-user system from
  // overwriting another user's config via a shared wrongstack install.
  if (!(await checkConfigOwnership(homeFn, defaultUidFn, targetConfigPath))) {
    return { ok: false, error: 'Operation denied: config file is not owned by current user' };
  }

  await backupCurrent(homeFn, targetConfigPath);

  try {
    await atomicWrite(cfg, JSON.stringify(lastCfg, null, 2));
  } catch (err) {
    return { ok: false, error: String(err) };
  }

  await appendHistory(oldCfg, lastCfg, 'Restored from config.json.last', homeFn, targetConfigPath);

  return { ok: true };
}
