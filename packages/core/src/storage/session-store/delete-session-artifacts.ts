import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { toErrorMessage } from '../../utils/index.js';
import { sessionPath as sessionStorePath, shardManifestPath } from './paths.js';

export type DeleteSessionArtifactsOptions = {
  rootDir: string;
  id: string;
  jsonlPath: string;
};

/**
 * Per-session JSON sidecars written next to the transcript, all of which die
 * with it. Exported so the prune sweep can recognize the same set when it
 * decides whether a date directory still holds anything worth keeping.
 */
export const SESSION_SIDECAR_SUFFIXES: readonly string[] = Object.freeze([
  '.plan.json',
  '.tasks.json',
  '.todos.json',
  '.completed-work.json',
]);

export async function deleteSessionArtifacts({
  rootDir,
  id,
  jsonlPath,
}: DeleteSessionArtifactsOptions): Promise<void> {
  const shardDir = path.dirname(jsonlPath);
  const base = path.basename(id);
  const sessDir = path.join(shardDir, base);

  const uniquePaths = [
    ...new Set([
      jsonlPath,
      sessionStorePath(rootDir, id, '.jsonl'),
      sessionStorePath(rootDir, id, '.jsonl.gz'),
      sessionStorePath(rootDir, id, '.summary.json'),
    ]),
  ];
  const deletions: Array<Promise<void>> = [
    ...uniquePaths.map((target) => fsp.unlink(target)),
    // Every per-session sidecar written next to the transcript. A suffix
    // missing here does not fail loudly — it just outlives the session it
    // belongs to, keeps its date directory from ever being removed, and
    // accumulates. `.completed-work.json` did exactly that.
    ...SESSION_SIDECAR_SUFFIXES.map((suffix) =>
      fsp.unlink(sessionStorePath(rootDir, id, suffix)),
    ),
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
