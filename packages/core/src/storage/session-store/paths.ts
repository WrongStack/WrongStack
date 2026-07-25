import * as path from 'node:path';
import { ensureDir } from '../../utils/atomic-write.js';
import { sessionScopedPath } from '../../utils/session-scoped-path.js';

export function sessionPath(storeDir: string, id: string, ext: '.jsonl' | '.summary.json'): string {
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

export async function ensureShardDir(storeDir: string, id: string): Promise<string> {
  const dirPath = path.dirname(sessionScopedPath(storeDir, id, ''));
  await ensureDir(dirPath);
  return dirPath;
}
