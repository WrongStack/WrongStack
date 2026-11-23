import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { restrictFilePermissions } from '../security/file-permissions.js';
import { slugify } from './slug.js';

/**
 * Minimal paths object needed for config backup — just the global root
 * from which we derive the backup history directory.
 */
interface ConfigBackupPaths {
  globalRoot: string;
}

/**
 * Backup directory for config file history.
 * Every config write creates a timestamped snapshot here so the user can
 * recover from accidental changes. Backups are never cleaned up automatically.
 */
export function configHistoryDir(globalRoot: string): string {
  if (typeof globalRoot !== 'string' || !globalRoot) return 'config-history';
  return path.join(globalRoot, 'config-history');
}

/**
 * Derive a human-readable slug for a config file path relative to the
 * ~/.wrongstack root. Examples:
 *   config.json                            →  config
 *   profiles/default/config.json           →  profiles-default-config
 */
export function configSlug(absolutePath: string, globalRoot: string): string {
  if (typeof absolutePath !== 'string' || typeof globalRoot !== 'string') {
    return 'config';
  }
  const rel = path.relative(globalRoot, absolutePath);
  const normalized = rel.replace(/\\/g, '/').replace(/\.json$/i, '');
  return slugify(normalized, 'config');
}

/**
 * Before overwriting a config file, save its current content to the
 * config-history directory with a timestamp. Best-effort: failures are
 * silently ignored so they never block the config write itself.
 */
export async function backupConfigFile(filePath: string, paths: ConfigBackupPaths): Promise<void> {
  // A backup the recovery reader can never find is worthless — it only scans
  // `<globalRoot>/config-history` — and configHistoryDir's falsy-globalRoot
  // branch resolves to the CWD-relative `./config-history`, littering
  // whatever directory the process started in (leaked snapshots even got
  // committed into the repo). Callers holding partial paths objects skip the
  // best-effort backup instead of misdirecting it.
  if (typeof paths.globalRoot !== 'string' || !paths.globalRoot) return;
  let currentContent: string;
  try {
    currentContent = await fs.readFile(filePath, 'utf8');
    if (!currentContent.trim()) return;
  } catch {
    return; // ENOENT or other error — no current content to back up
  }

  let backupTime = Date.now();
  const slug = configSlug(filePath, paths.globalRoot);
  const backupDir = configHistoryDir(paths.globalRoot);

  try {
    await fs.mkdir(backupDir, { recursive: true });
    for (;;) {
      const ts = new Date(backupTime).toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
      const backupFile = path.join(backupDir, `${slug}-${ts}.json`);
      try {
        await fs.writeFile(backupFile, currentContent, {
          mode: 0o600,
          encoding: 'utf8',
          flag: 'wx',
        });
        // F25 (WS-045 class): on Windows `mode: 0o600` is a no-op, so this
        // config snapshot — full config content, possibly API keys — stayed
        // readable by other local accounts where inheritance was not owner-only.
        // Each snapshot is a new file; harden it after the write. Best-effort
        // (warned, never thrown) inside the already best-effort backup.
        await restrictFilePermissions(backupFile, { label: 'config-backup' });
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        // Keep the recovery reader's timestamp grammar without replacing a snapshot.
        backupTime++;
      }
    }
  } catch {
    // best-effort — never block the config write for a backup failure
  }
}
