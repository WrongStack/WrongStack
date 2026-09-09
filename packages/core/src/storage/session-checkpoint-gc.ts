import { createReadStream } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { createGunzip } from 'node:zlib';
import { toErrorMessage } from '../utils/index.js';

/**
 * Garbage collection for the workspace-checkpoint CAS (`<sessions>/_cas`).
 *
 * Every `checkpoint` event in a transcript may carry a `workspaceCheckpoint`
 * whose `manifestHash` names a manifest, which in turn names the blobs that
 * reproduce that workspace. Deleting a session removes its transcript — and
 * with it the only reference — but nothing ever removed the manifest or the
 * blobs. On a real store that left 958 of 2,399 manifests unreachable and an
 * objects tree of 1.1 GB.
 *
 * The sweep is mark-and-sweep with an age floor, and it is deliberately NOT
 * wired into boot: a full reachability scan of that store took 101 seconds, so
 * it belongs behind an explicit `/prune --checkpoints`, not on every start.
 */

/** A hash as written by the CAS: lowercase sha-256. */
const MANIFEST_HASH_IN_TRANSCRIPT = /"manifestHash":"([a-f\d]{64})"/g;
const HASH_RE = /^[a-f\d]{64}$/;

/** Directories under the session store that never hold transcripts. */
const NON_TRANSCRIPT_DIRS = new Set(['_cas']);

export interface CheckpointGcResult {
  /** Manifests examined on disk. */
  manifestsScanned: number;
  manifestsDeleted: number;
  objectsScanned: number;
  objectsDeleted: number;
  bytesReclaimed: number;
  /** Non-fatal problems; the sweep keeps anything it could not read. */
  errors: string[];
}

/**
 * Collect every checkpoint manifest hash still referenced by a transcript.
 *
 * Streams line by line on purpose. A single transcript in a working store is
 * hundreds of megabytes, and reading one whole into a string is enough to end
 * the process — the naive version of this scan died with a heap OOM before it
 * finished the first directory.
 */
export async function collectReachableManifestHashes(storeDir: string): Promise<Set<string>> {
  const reachable = new Set<string>();
  for (const file of await listTranscripts(storeDir)) {
    try {
      const raw = createReadStream(file);
      const input = file.endsWith('.gz') ? raw.pipe(createGunzip()) : raw;
      const lines = readline.createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
      try {
        for await (const line of lines) {
          // Cheap reject first: the substring test skips the regex for the
          // overwhelming majority of lines, which carry no checkpoint at all.
          if (!line.includes('manifestHash')) continue;
          for (const match of line.matchAll(MANIFEST_HASH_IN_TRANSCRIPT)) {
            if (match[1]) reachable.add(match[1]);
          }
        }
      } finally {
        lines.close();
        raw.destroy();
      }
    } catch {
      // A transcript that cannot be read is treated as reachable-unknown: the
      // sweep's age floor is what keeps that from deleting live data.
    }
  }
  return reachable;
}

/**
 * Delete manifests no transcript references, then every blob no surviving
 * manifest references.
 *
 * `keepNewerThanMs` is a floor, not an optimization: anything modified after it
 * survives even when it looks unreachable. A checkpoint captured while this
 * sweep runs, or one referenced from a transcript the scan could not read, is
 * therefore safe as long as it is recent.
 */
export async function sweepCheckpointCas(opts: {
  casRoot: string;
  reachableManifestHashes: ReadonlySet<string>;
  keepNewerThanMs: number;
}): Promise<CheckpointGcResult> {
  const result: CheckpointGcResult = {
    manifestsScanned: 0,
    manifestsDeleted: 0,
    objectsScanned: 0,
    objectsDeleted: 0,
    bytesReclaimed: 0,
    errors: [],
  };

  const manifestsDir = path.join(opts.casRoot, 'manifests');
  const objectsDir = path.join(opts.casRoot, 'objects');

  // Pass 1 — manifests. A manifest survives when a transcript still points at
  // it, or when it is younger than the floor. Every surviving manifest's blobs
  // are recorded so pass 2 cannot delete them.
  const liveBlobs = new Set<string>();
  for (const entry of await readDirSafe(manifestsDir, result)) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    result.manifestsScanned++;
    const hash = entry.name.slice(0, -'.json'.length);
    const file = path.join(manifestsDir, entry.name);

    const young = await isNewerThan(file, opts.keepNewerThanMs, result);
    const keep = young || !HASH_RE.test(hash) || opts.reachableManifestHashes.has(hash);
    if (keep) {
      for (const blob of await readManifestBlobHashes(file, result)) liveBlobs.add(blob);
      continue;
    }

    const size = await fileSize(file);
    if (await unlinkSafe(file, result)) {
      result.manifestsDeleted++;
      result.bytesReclaimed += size;
    } else {
      // Failed to delete: assume it lives, so its blobs are not swept either.
      for (const blob of await readManifestBlobHashes(file, result)) liveBlobs.add(blob);
    }
  }

  // Pass 2 — objects, stored as `objects/<first 2 hex>/<rest>`.
  for (const shard of await readDirSafe(objectsDir, result)) {
    if (!shard.isDirectory()) continue;
    const shardDir = path.join(objectsDir, shard.name);
    for (const entry of await readDirSafe(shardDir, result)) {
      if (!entry.isFile()) continue;
      result.objectsScanned++;
      const hash = `${shard.name}${entry.name}`;
      if (liveBlobs.has(hash)) continue;
      const file = path.join(shardDir, entry.name);
      if (await isNewerThan(file, opts.keepNewerThanMs, result)) continue;
      const size = await fileSize(file);
      if (await unlinkSafe(file, result)) {
        result.objectsDeleted++;
        result.bytesReclaimed += size;
      }
    }
    // An emptied shard directory is itself garbage.
    await fsp.rmdir(shardDir).catch(() => undefined);
  }

  return result;
}

async function listTranscripts(storeDir: string): Promise<string[]> {
  const found: string[] = [];
  const pending = [storeDir];
  while (pending.length > 0) {
    const dir = pending.pop();
    if (dir === undefined) break;
    let entries: DirEntry[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!NON_TRANSCRIPT_DIRS.has(entry.name)) pending.push(path.join(dir, entry.name));
        continue;
      }
      if (entry.isFile() && /\.jsonl(\.gz)?$/.test(entry.name)) {
        found.push(path.join(dir, entry.name));
      }
    }
  }
  return found;
}

async function readManifestBlobHashes(
  file: string,
  result: CheckpointGcResult,
): Promise<string[]> {
  try {
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8')) as {
      entries?: Array<{ blobHash?: unknown }>;
    };
    if (!Array.isArray(parsed.entries)) return [];
    return parsed.entries
      .map((entry) => entry?.blobHash)
      .filter((hash): hash is string => typeof hash === 'string' && HASH_RE.test(hash));
  } catch (err) {
    // An unreadable manifest is kept, and so are its blobs — but we cannot
    // name them, so record it rather than silently under-protecting.
    result.errors.push(`${path.basename(file)}: ${toErrorMessage(err)}`);
    return [];
  }
}

/** What `readdir(..., { withFileTypes: true })` yields, named so both walkers agree. */
type DirEntry = { name: string; isFile(): boolean; isDirectory(): boolean };

async function readDirSafe(dir: string, result: CheckpointGcResult): Promise<DirEntry[]> {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // A store with no checkpoints yet has no `_cas` at all; that is not an error.
    if (code !== 'ENOENT') result.errors.push(`${dir}: ${toErrorMessage(err)}`);
    return [];
  }
}

async function isNewerThan(
  file: string,
  floorMs: number,
  result: CheckpointGcResult,
): Promise<boolean> {
  try {
    const stat = await fsp.stat(file);
    return stat.mtimeMs >= floorMs;
  } catch (err) {
    result.errors.push(`${path.basename(file)}: ${toErrorMessage(err)}`);
    // Unknown age counts as young: never delete what we could not date.
    return true;
  }
}

async function fileSize(file: string): Promise<number> {
  try {
    return (await fsp.stat(file)).size;
  } catch {
    return 0;
  }
}

async function unlinkSafe(file: string, result: CheckpointGcResult): Promise<boolean> {
  try {
    await fsp.unlink(file);
    return true;
  } catch (err) {
    result.errors.push(`${path.basename(file)}: ${toErrorMessage(err)}`);
    return false;
  }
}
