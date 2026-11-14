/** Fix backups: written before every apply, restored on rollback and by `undo`. */

import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveWstackPaths } from '@wrongstack/core/utils';
import type { InternalPlan } from './fix-types.js';

export interface BackupManifest {
  id: string;
  createdAt: string;
  findingIds: string[];
  files: Array<{ file: string; action: 'edit' | 'delete'; blob: string; afterHash: string | null }>;
}

export interface DeadCodeBackupInfo {
  id: string;
  createdAt: string;
  files: number;
  findingIds: string[];
}

export function backupRoot(projectRoot: string): string {
  return path.join(resolveWstackPaths({ projectRoot }).projectDir, 'dead-code', 'backups');
}

function sha(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

export function writeBackup(projectRoot: string, plan: InternalPlan): BackupManifest {
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}-${randomUUID()}`;
  const dir = path.join(backupRoot(projectRoot), id);
  fs.mkdirSync(path.join(dir, 'blobs'), { recursive: true });
  const manifest: BackupManifest = {
    id,
    createdAt: new Date().toISOString(),
    findingIds: plan.planned,
    files: plan.internal.map((c, i) => {
      const blob = `${i}.txt`;
      fs.writeFileSync(path.join(dir, 'blobs', blob), c.before);
      return {
        file: c.file,
        action: c.action,
        blob,
        afterHash: c.after === null ? null : sha(c.after),
      };
    }),
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

export function restoreFromManifest(
  projectRoot: string,
  manifest: BackupManifest,
  skip: ReadonlySet<string> = new Set(),
): string[] {
  const dir = path.join(backupRoot(projectRoot), manifest.id);
  const restored: string[] = [];
  for (const entry of manifest.files) {
    if (skip.has(entry.file)) continue;
    const content = fs.readFileSync(path.join(dir, 'blobs', entry.blob), 'utf8');
    const abs = path.join(projectRoot, entry.file);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    restored.push(entry.file);
  }
  return restored;
}

export function listDeadCodeBackups(projectRoot: string): DeadCodeBackupInfo[] {
  const root = backupRoot(projectRoot);
  let ids: string[];
  try {
    ids = fs.readdirSync(root);
  } catch {
    return [];
  }
  const out: DeadCodeBackupInfo[] = [];
  for (const id of ids) {
    try {
      const m = JSON.parse(
        fs.readFileSync(path.join(root, id, 'manifest.json'), 'utf8'),
      ) as BackupManifest;
      out.push({
        id: m.id,
        createdAt: m.createdAt,
        files: m.files.length,
        findingIds: m.findingIds,
      });
    } catch {
      // Not a backup directory.
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export interface DeadCodeUndoResult {
  restored: string[];
  /** Files changed after the fix; restored only with `force`. */
  conflicts: string[];
}

export function undoDeadCodeFix(
  projectRoot: string,
  backupId: string,
  opts: { force?: boolean } = {},
): DeadCodeUndoResult {
  if (!/^[\w.-]+$/.test(backupId) || backupId === '.' || backupId === '..')
    throw new Error(`dead-code undo: invalid backup id "${backupId}"`);
  const file = path.join(backupRoot(projectRoot), backupId, 'manifest.json');
  if (!fs.existsSync(file)) throw new Error(`dead-code undo: no backup "${backupId}"`);
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as BackupManifest;
  const conflicts = changedSinceFix(projectRoot, manifest);
  if (conflicts.length > 0 && !opts.force) return { restored: [], conflicts };
  return { restored: restoreFromManifest(projectRoot, manifest), conflicts };
}

/** Files no longer exactly as the fix left them (edited again, or a deleted file recreated). */
export function changedSinceFix(projectRoot: string, manifest: BackupManifest): string[] {
  const conflicts: string[] = [];
  for (const entry of manifest.files) {
    const abs = path.join(projectRoot, entry.file);
    const exists = fs.existsSync(abs);
    if (entry.action === 'delete' && exists) conflicts.push(entry.file);
    if (entry.action === 'edit') {
      const current = exists ? fs.readFileSync(abs, 'utf8') : null;
      if (current === null || sha(current) !== entry.afterHash) conflicts.push(entry.file);
    }
  }
  return conflicts;
}
