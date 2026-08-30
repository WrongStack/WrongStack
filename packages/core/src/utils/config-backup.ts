import * as fs from 'node:fs/promises';
import * as path from 'node:path';

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
  return path.join(globalRoot, 'config-history');
}

/**
 * Derive a human-readable slug for a config file path relative to the
 * ~/.wrongstack root. Examples:
 *   config.json                            →  config
 *   profiles/default/config.json           →  profiles-default-config
 */
export function configSlug(absolutePath: string, globalRoot: string): string {
  const rel = path.relative(globalRoot, absolutePath);
  const normalized = rel.replace(/\\/g, '/').replace(/\.json$/i, '');
  return normalized.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'config';
}

/**
 * Before overwriting a config file, save its current content to the
 * config-history directory with a timestamp. Best-effort: failures are
 * silently ignored so they never block the config write itself.
 */
export async function backupConfigFile(
  filePath: string,
  paths: ConfigBackupPaths,
): Promise<void> {
  let currentContent: string;
  try {
    currentContent = await fs.readFile(filePath, 'utf8');
    if (!currentContent.trim()) return;
  } catch {
    return; // ENOENT or other error — no current content to back up
  }

  const now = new Date();
  const ts = now.toISOString()
    .replace(/[:.]/g, '-')
    .replace(/Z$/, '');
  const slug = configSlug(filePath, paths.globalRoot);
  const backupDir = configHistoryDir(paths.globalRoot);
  const backupFile = path.join(backupDir, `${slug}-${ts}.json`);

  try {
    await fs.mkdir(backupDir, { recursive: true });
    await fs.writeFile(backupFile, currentContent, { mode: 0o600, encoding: 'utf8' });
  } catch {
    // best-effort — never block the config write for a backup failure
  }
}
