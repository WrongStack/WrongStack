import * as path from 'node:path';
import { ensureDir } from '../../utils/atomic-write.js';
import { restrictDirPermissions } from '../../security/file-permissions.js';
import { sessionScopedPath } from '../../utils/session-scoped-path.js';

export function sessionPath(storeDir: string, id: string, ext: string): string {
  return sessionScopedPath(storeDir, id, ext);
}

export function shardManifestPath(storeDir: string, shardKey: string): string {
  return shardKey
    ? path.join(storeDir, shardKey, '_manifest.json')
    : path.join(storeDir, '_manifest.json');
}

export function shardKeyForSessionId(id: string): string {
  const dirName = path.dirname(id);
  return dirName === '.' ? '' : dirName;
}

/** Shard dirs already owner-only hardened. F67 (WS-045). */
const hardenedShardDirs = new Set<string>();

export async function ensureShardDir(storeDir: string, id: string): Promise<string> {
  const dirPath = path.dirname(sessionScopedPath(storeDir, id, ''));
  await ensureDir(dirPath);
  // F67 (WS-045 directory-hardening-on-creation): the shard holds verbatim
  // transcripts; harden once per dir so every journal/sidecar inherits
  // owner-only (best-effort). Session loads must not pay an icacls each time.
  if (!hardenedShardDirs.has(dirPath)) {
    hardenedShardDirs.add(dirPath);
    await restrictDirPermissions(dirPath, { label: 'session-shard' });
  }
  return dirPath;
}
