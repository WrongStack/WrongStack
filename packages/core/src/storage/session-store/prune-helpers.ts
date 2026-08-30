import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { isSessionTranscriptFileName } from '../../utils/session-scoped-path.js';

/**
 * Prunable === is a transcript. This module held the only complete sidecar
 * list in the codebase while the listing scans held shorter ones; sharing the
 * predicate is what stops them disagreeing again.
 */
export function isPrunableSessionJsonl(name: string): boolean {
  return isSessionTranscriptFileName(name);
}

export async function pruneSessionFiles(
  storeDir: string,
  maxAgeDays: number,
  deleteSession: (id: string) => Promise<void>,
  isSessionInUse?: ((sessionId: string) => Promise<string | null>) | undefined,
): Promise<number> {
  const cutoff = Date.now() - maxAgeDays * 86_400_000;
  let deleted = 0;

  const pruneFile = async (dir: string, name: string, prefix: string): Promise<void> => {
    const jsonlPath = path.join(dir, name);
    try {
      const stat = await fsp.stat(jsonlPath);
      if (stat.mtimeMs >= cutoff) return;
      /* v8 ignore start -- defensive: file vanished between readdir and stat */
    } catch {
      return;
    }
    /* v8 ignore stop */
    const base = name.replace(/\.jsonl$/, '');
    const id = prefix ? `${prefix}/${base}` : base;
    if (isSessionInUse && (await isSessionInUse(id))) return;
    await deleteSession(id);
    deleted++;
  };

  /* v8 ignore next -- defensive: store dir is ensured before prune runs */
  const entries = await fsp.readdir(storeDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isFile()) {
      if (isPrunableSessionJsonl(entry.name)) await pruneFile(storeDir, entry.name, '');
      continue;
    }
    /* v8 ignore next -- defensive: root entries are only files or directories */
    if (!entry.isDirectory()) continue;
    const dateDir = path.join(storeDir, entry.name);
    /* v8 ignore next -- defensive: dateDir came from readdir and is readable */
    const files = await fsp.readdir(dateDir, { withFileTypes: true }).catch(() => []);
    for (const file of files) {
      if (!file.isFile() || !isPrunableSessionJsonl(file.name)) continue;
      await pruneFile(dateDir, file.name, entry.name);
    }
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dateDir = path.join(storeDir, entry.name);
    try {
      const remaining = await fsp.readdir(dateDir);
      if (remaining.length === 0) {
        /* v8 ignore next -- best-effort: rmdir of a confirmed-empty dir does not reject */
        await fsp.rmdir(dateDir).catch(() => undefined);
      }
    } catch {
      // best-effort
    }
  }

  return deleted;
}
