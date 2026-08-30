import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { toErrorMessage } from '../../utils/index.js';
import { sessionPath as sessionStorePath, shardManifestPath } from './paths.js';

export type DeleteSessionArtifactsOptions = {
  rootDir: string;
  id: string;
  jsonlPath: string;
};

export async function deleteSessionArtifacts({
  rootDir,
  id,
  jsonlPath,
}: DeleteSessionArtifactsOptions): Promise<void> {
  const shardDir = path.dirname(jsonlPath);
  const base = path.basename(id);
  const sessDir = path.join(shardDir, base);

  const deletions: Array<Promise<void>> = [
    fsp.unlink(jsonlPath),
    fsp.unlink(sessionStorePath(rootDir, id, '.summary.json')),
    fsp.unlink(sessionStorePath(rootDir, id, '.plan.json')),
    fsp.unlink(sessionStorePath(rootDir, id, '.tasks.json')),
    fsp.unlink(sessionStorePath(rootDir, id, '.todos.json')),
    fsp.unlink(shardManifestPath(rootDir, path.dirname(id) === '.' ? '' : path.dirname(id))),
  ];

  const results = await Promise.allSettled(deletions);
  for (const result of results) {
    if (result.status === 'rejected') {
      warnDeleteFailure(id, result.reason);
    }
  }

  await fsp.rm(sessDir, { recursive: true, force: true }).catch((err) => {
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'session_store.rmdir_failed',
        sessionId: id,
        message: toErrorMessage(err),
        timestamp: new Date().toISOString(),
      }),
    );
  });
}

function warnDeleteFailure(id: string, reason: unknown): void {
  const msg = reason instanceof Error ? reason.message : String(reason);
  if ((reason as NodeJS.ErrnoException)?.code === 'ENOENT') return;
  console.warn(
    JSON.stringify({
      level: 'warn',
      event: 'session_store.delete_failed',
      sessionId: id,
      message: msg,
      timestamp: new Date().toISOString(),
    }),
  );
}
