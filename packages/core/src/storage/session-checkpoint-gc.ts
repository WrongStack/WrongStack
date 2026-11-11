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
 *
 * Throws when any transcript (or directory of them) exists but cannot be read
 * to the end. The age floor only protects checkpoints younger than it, so a
 * skipped transcript used to hand every OLDER checkpoint it names to the sweep
 * — silently. A transcript deleted mid-scan is not a failure: its references
 * are gone with it.
 */
export async function collectReachableManifestHashes(storeDir: string): Promise<Set<string>> {
  const reachable = new Set<string>();
  const { files, unreadable } = await listTranscripts(storeDir);
  for (const file of files) {
    try {
      const raw = createReadStream(file);
      let input: NodeJS.ReadableStream = raw;
      if (file.endsWith('.gz')) {
        const gunzip = createGunzip();
        // `pipe` does not forward source errors: an open/read failure left the
        // gunzip waiting forever and surfaced as an uncaught 'error' event.
        raw.once('error', (err) => gunzip.destroy(err));
        input = raw.pipe(gunzip);
      }
      const lines = readline.createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
      const branchStatuses = new Map<string, 'active' | 'folded' | 'archived'>([
        ['main', 'active'],
      ]);
      const branchHashes = new Map<string, Set<string>>();
      const addBranchHash = (branchId: string, hash: string): void => {
        if (!HASH_RE.test(hash)) return;
        let bucket = branchHashes.get(branchId);
        if (!bucket) {
          bucket = new Set<string>();
          branchHashes.set(branchId, bucket);
        }
        bucket.add(hash);
      };
      try {
        for await (const line of lines) {
          const hasManifestHash = line.includes('manifestHash');
          const hasBranchLifecycle = line.includes('"branch_');
          // Cheap reject first: the substring tests skip JSON/regex work for the
          // overwhelming majority of lines, which carry neither checkpoints nor branch state.
          if (!hasManifestHash && !hasBranchLifecycle) continue;

          let parsed: Record<string, unknown> | undefined;
          try {
            const candidate: unknown = JSON.parse(line);
            if (candidate !== null && typeof candidate === 'object') {
              parsed = candidate as Record<string, unknown>;
            }
          } catch {
            // Malformed line: fall back to conservative root retention below.
          }

          if (parsed) {
            const eventType = parsed.type;
            if (eventType === 'branch_created' && typeof parsed.newBranchId === 'string') {
              branchStatuses.set(parsed.newBranchId, 'active');
              const baseCp = parsed.baseWorkspaceCheckpoint as
                | { manifestHash?: unknown }
                | undefined;
              if (typeof baseCp?.manifestHash === 'string') {
                addBranchHash(parsed.newBranchId, baseCp.manifestHash);
              }
              continue;
            }
            if (eventType === 'branch_switched') {
              const fromBranchId =
                typeof parsed.fromBranchId === 'string' && parsed.fromBranchId.length > 0
                  ? parsed.fromBranchId
                  : 'main';
              const depCp = parsed.departureCheckpoint as { manifestHash?: unknown } | undefined;
              if (typeof depCp?.manifestHash === 'string') {
                addBranchHash(fromBranchId, depCp.manifestHash);
              }
              continue;
            }
            if (
              eventType === 'branch_folded' &&
              typeof parsed.sourceBranchId === 'string' &&
              parsed.sourceBranchId !== 'main'
            ) {
              branchStatuses.set(
                parsed.sourceBranchId,
                parsed.archiveSource === true ? 'archived' : 'folded',
              );
              continue;
            }
            if (
              eventType === 'branch_status_changed' &&
              typeof parsed.targetBranchId === 'string' &&
              parsed.targetBranchId !== 'main'
            ) {
              if (
                parsed.status === 'active' ||
                parsed.status === 'folded' ||
                parsed.status === 'archived'
              ) {
                branchStatuses.set(parsed.targetBranchId, parsed.status);
              }
              continue;
            }
          }

          if (!hasManifestHash) continue;
          const ownerBranchId =
            parsed && typeof parsed.branchId === 'string' && parsed.branchId.length > 0
              ? parsed.branchId
              : 'main';
          for (const match of line.matchAll(MANIFEST_HASH_IN_TRANSCRIPT)) {
            if (match[1]) addBranchHash(ownerBranchId, match[1]);
          }
        }
        for (const [branchId, hashes] of branchHashes) {
          const status = branchStatuses.get(branchId) ?? 'active';
          if (status === 'archived') continue;
          for (const hash of hashes) reachable.add(hash);
        }
      } finally {
        lines.close();
        raw.destroy();
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        unreadable.push(`${path.relative(storeDir, file)}: ${toErrorMessage(err)}`);
      }
    }
  }
  if (unreadable.length > 0) {
    throw new Error(
      `Checkpoint GC refused: ${unreadable.length} transcript path(s) could not be read, so the ` +
        `checkpoints they reference cannot be told apart from garbage. Fix or move them, then ` +
        `retry: ${unreadable.slice(0, 5).join('; ')}${unreadable.length > 5 ? '; …' : ''}`,
    );
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
  // Set when a surviving manifest could not be read: its blobs are live but
  // unnamed, so no object can be proven garbage this run.
  let liveBlobsIncomplete = false;
  const markLive = async (file: string) => {
    const blobs = await readManifestBlobHashes(file, result);
    if (blobs === null) liveBlobsIncomplete = true;
    else for (const blob of blobs) liveBlobs.add(blob);
  };
  let manifestEntries: DirEntry[];
  try {
    manifestEntries = await fsp.readdir(manifestsDir, { withFileTypes: true });
  } catch (err) {
    manifestEntries = [];
    // No manifests dir means no references; an unlistable one hides them all,
    // and sweeping objects then would delete every live checkpoint's content.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      result.errors.push(`${manifestsDir}: ${toErrorMessage(err)}`);
      liveBlobsIncomplete = true;
    }
  }
  for (const entry of manifestEntries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    result.manifestsScanned++;
    const hash = entry.name.slice(0, -'.json'.length);
    const file = path.join(manifestsDir, entry.name);

    const young = await isNewerThan(file, opts.keepNewerThanMs, result);
    const keep = young || !HASH_RE.test(hash) || opts.reachableManifestHashes.has(hash);
    if (keep) {
      await markLive(file);
      continue;
    }

    const size = await fileSize(file);
    if (await unlinkSafe(file, result)) {
      result.manifestsDeleted++;
      result.bytesReclaimed += size;
    } else {
      // Failed to delete: assume it lives, so its blobs are not swept either.
      await markLive(file);
    }
  }
  if (liveBlobsIncomplete) {
    result.errors.push('Object sweep skipped: a kept manifest could not be read');
    return result;
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

async function listTranscripts(
  storeDir: string,
): Promise<{ files: string[]; unreadable: string[] }> {
  const found: string[] = [];
  const unreadable: string[] = [];
  const pending = [storeDir];
  while (pending.length > 0) {
    const dir = pending.pop();
    if (dir === undefined) break;
    let entries: DirEntry[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      // An unlistable directory hides every transcript under it.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        unreadable.push(`${path.relative(storeDir, dir) || '.'}: ${toErrorMessage(err)}`);
      }
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
  return { files: found, unreadable };
}

async function readManifestBlobHashes(
  file: string,
  result: CheckpointGcResult,
): Promise<string[] | null> {
  try {
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8')) as {
      entries?: Array<{ blobHash?: unknown }>;
    };
    if (!Array.isArray(parsed.entries)) {
      throw new Error('Invalid checkpoint manifest entries');
    }
    return parsed.entries
      .map((entry) => entry?.blobHash)
      .filter((hash): hash is string => typeof hash === 'string' && HASH_RE.test(hash));
  } catch (err) {
    // An unreadable manifest is kept, and so are its blobs — but we cannot
    // name them, so the caller must not sweep objects at all.
    result.errors.push(`${path.basename(file)}: ${toErrorMessage(err)}`);
    return null;
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
