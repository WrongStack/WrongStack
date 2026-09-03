import { createHash, type Hash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { atomicReplaceWithWriter } from '../../utils/atomic-write.js';
import {
  endsWithTranscriptSuffix,
  isColdSessionTranscriptFileName,
  isSessionTranscriptFileName,
  SESSION_COLD_TRANSCRIPT_SUFFIX,
  SESSION_HOT_TRANSCRIPT_SUFFIX,
  sessionScopedPath,
} from '../../utils/session-scoped-path.js';
import {
  coldTranscriptRelativePath,
  hotTranscriptRelativePath,
  locateTranscript,
  type TranscriptLocation,
} from './transcript-location.js';

export interface TranscriptCodecResult {
  id: string;
  relativePath: string;
  filePath: string;
  state: 'hot' | 'cold';
  sha256: string;
  uncompressedBytes: number;
  compressedBytes: number;
}

/** Same transient codes `atomicWrite` retries on Windows (AV/indexer locks).
 *  Also used on POSIX for NFS/Spotlight `EBUSY`. */
const TRANSIENT_FS_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RETRY_DELAYS_MS = [10, 25, 60, 120, 250, 500, 1000, 2000];

function hashingTap(hash: Hash, onBytes: (n: number) => void): Transform {
  return new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      onBytes((chunk as Buffer).length);
      callback(null, chunk);
    },
  });
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function unlinkWithRetry(target: string): Promise<void> {
  let attempt = 0;
  for (;;) {
    try {
      await fsp.unlink(target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return;
      const transient = code !== undefined && TRANSIENT_FS_CODES.has(code);
      if (!transient || attempt === RETRY_DELAYS_MS.length) throw error;
      await sleep(RETRY_DELAYS_MS[attempt]!);
      attempt++;
    }
  }
}

/**
 * Stream into an already-open `FileHandle` without creating a second fd.
 * `FileHandle.createWriteStream()` on Windows can leave the handle for GC
 * close (DEP0137) and then EPERM the follow-up rename.
 */
function handleWritable(handle: FileHandle): Writable {
  return new Writable({
    write(chunk, _encoding, callback) {
      void handle.write(chunk).then(
        () => callback(),
        (error: Error) => callback(error),
      );
    },
  });
}

export type GzipTranscriptOptions = {
  /** zlib level 1–9. Backfill uses 1 (JSONL still compresses hard). */
  level?: number | undefined;
  /** Extra gunzip round-trip. Gzip already has CRC32; skip on bulk backfill. */
  verify?: boolean | undefined;
};

async function gzipFile(
  src: string,
  dest: string,
  opts: GzipTranscriptOptions = {},
): Promise<{ sha256: string; uncompressedBytes: number; compressedBytes: number }> {
  const hash = createHash('sha256');
  let uncompressedBytes = 0;
  const level = Math.min(9, Math.max(1, Math.floor(opts.level ?? 6)));
  await atomicReplaceWithWriter(
    dest,
    async (handle) => {
      await pipeline(
        createReadStream(src),
        hashingTap(hash, (n) => {
          uncompressedBytes += n;
        }),
        createGzip({ level }),
        handleWritable(handle),
      );
    },
    { mode: 0o600 },
  );
  const expected = hash.digest('hex');
  if (opts.verify !== false) {
    const verify = createHash('sha256');
    await pipeline(
      createReadStream(dest),
      createGunzip(),
      new Writable({
        write(chunk, _encoding, callback) {
          verify.update(chunk);
          callback();
        },
      }),
    );
    if (verify.digest('hex') !== expected) {
      throw new Error(`Gzip verification failed for ${path.basename(src)}`);
    }
  }
  const stat = await fsp.stat(dest);
  return { sha256: expected, uncompressedBytes, compressedBytes: stat.size };
}

async function gunzipFile(
  src: string,
  dest: string,
): Promise<{ sha256: string; uncompressedBytes: number; compressedBytes: number }> {
  const compressed = await fsp.stat(src);
  const hash = createHash('sha256');
  let uncompressedBytes = 0;
  await atomicReplaceWithWriter(
    dest,
    async (handle) => {
      await pipeline(
        createReadStream(src),
        createGunzip(),
        hashingTap(hash, (n) => {
          uncompressedBytes += n;
        }),
        handleWritable(handle),
      );
    },
    { mode: 0o600 },
  );
  return {
    sha256: hash.digest('hex'),
    uncompressedBytes,
    compressedBytes: compressed.size,
  };
}

function coldCompanionPath(jsonlPath: string): string {
  if (endsWithTranscriptSuffix(jsonlPath, SESSION_COLD_TRANSCRIPT_SUFFIX)) return jsonlPath;
  if (endsWithTranscriptSuffix(jsonlPath, SESSION_HOT_TRANSCRIPT_SUFFIX)) {
    return `${jsonlPath.slice(0, -SESSION_HOT_TRANSCRIPT_SUFFIX.length)}${SESSION_COLD_TRANSCRIPT_SUFFIX}`;
  }
  return `${jsonlPath}${SESSION_COLD_TRANSCRIPT_SUFFIX}`;
}

function hotCompanionPath(gzipPath: string): string {
  if (endsWithTranscriptSuffix(gzipPath, SESSION_COLD_TRANSCRIPT_SUFFIX)) {
    return `${gzipPath.slice(0, -SESSION_COLD_TRANSCRIPT_SUFFIX.length)}${SESSION_HOT_TRANSCRIPT_SUFFIX}`;
  }
  if (gzipPath.toLowerCase().endsWith('.gz')) return gzipPath.slice(0, -3);
  return gzipPath;
}

async function walkNamedFiles(
  dir: string,
  keep: (name: string) => boolean,
): Promise<string[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walkNamedFiles(full, keep)));
      continue;
    }
    if (entry.isFile() && keep(entry.name)) out.push(full);
  }
  return out;
}

function sessionArtifactDir(storeDir: string, id: string): string {
  const hot = sessionScopedPath(storeDir, id, SESSION_HOT_TRANSCRIPT_SUFFIX);
  return path.join(path.dirname(hot), path.basename(id));
}

async function archiveCompanionTranscripts(
  storeDir: string,
  id: string,
  gzipOpts: GzipTranscriptOptions,
): Promise<void> {
  const dir = sessionArtifactDir(storeDir, id);
  const files = await walkNamedFiles(
    dir,
    (name) => isSessionTranscriptFileName(name) && !isColdSessionTranscriptFileName(name),
  );
  for (const jsonl of files) {
    await gzipFile(jsonl, coldCompanionPath(jsonl), gzipOpts);
    await unlinkWithRetry(jsonl);
  }
}

async function rehydrateCompanionTranscripts(storeDir: string, id: string): Promise<void> {
  const dir = sessionArtifactDir(storeDir, id);
  const files = await walkNamedFiles(dir, (name) => isColdSessionTranscriptFileName(name));
  for (const gzip of files) {
    await gunzipFile(gzip, hotCompanionPath(gzip));
    await unlinkWithRetry(gzip);
  }
}

export async function archiveLocatedTranscript(
  storeDir: string,
  location: TranscriptLocation,
  includeSubagents: boolean,
  gzipOpts: GzipTranscriptOptions = {},
): Promise<TranscriptCodecResult> {
  if (location.state === 'cold') {
    if (includeSubagents) await archiveCompanionTranscripts(storeDir, location.id, gzipOpts);
    return {
      id: location.id,
      relativePath: location.relativePath,
      filePath: location.filePath,
      state: 'cold',
      sha256: '',
      uncompressedBytes: 0,
      compressedBytes: location.size,
    };
  }
  const dest = sessionScopedPath(storeDir, location.id, SESSION_COLD_TRANSCRIPT_SUFFIX);
  const codec = await gzipFile(location.filePath, dest, gzipOpts);
  await unlinkWithRetry(location.filePath);
  if (includeSubagents) await archiveCompanionTranscripts(storeDir, location.id, gzipOpts);
  return {
    id: location.id,
    relativePath: coldTranscriptRelativePath(location.id),
    filePath: dest,
    state: 'cold',
    sha256: codec.sha256,
    uncompressedBytes: codec.uncompressedBytes,
    compressedBytes: codec.compressedBytes,
  };
}

export async function rehydrateLocatedTranscript(
  storeDir: string,
  location: TranscriptLocation,
  includeSubagents: boolean,
): Promise<TranscriptCodecResult> {
  if (location.state === 'hot') {
    const leftover = sessionScopedPath(storeDir, location.id, SESSION_COLD_TRANSCRIPT_SUFFIX);
    await unlinkWithRetry(leftover).catch(() => undefined);
    if (includeSubagents) await rehydrateCompanionTranscripts(storeDir, location.id);
    return {
      id: location.id,
      relativePath: hotTranscriptRelativePath(location.id),
      filePath: location.filePath,
      state: 'hot',
      sha256: '',
      uncompressedBytes: location.size,
      compressedBytes: 0,
    };
  }
  const dest = sessionScopedPath(storeDir, location.id, SESSION_HOT_TRANSCRIPT_SUFFIX);
  const codec = await gunzipFile(location.filePath, dest);
  await unlinkWithRetry(location.filePath);
  if (includeSubagents) await rehydrateCompanionTranscripts(storeDir, location.id);
  return {
    id: location.id,
    relativePath: hotTranscriptRelativePath(location.id),
    filePath: dest,
    state: 'hot',
    sha256: codec.sha256,
    uncompressedBytes: codec.uncompressedBytes,
    compressedBytes: codec.compressedBytes,
  };
}

export async function archiveSessionTranscript(
  storeDir: string,
  id: string,
  includeSubagents: boolean,
  gzipOpts: GzipTranscriptOptions = {},
): Promise<TranscriptCodecResult> {
  const location = await locateTranscript(storeDir, id);
  if (!location) throw new Error(`Session not found: ${id}`);
  return archiveLocatedTranscript(storeDir, location, includeSubagents, gzipOpts);
}

export async function rehydrateSessionTranscript(
  storeDir: string,
  id: string,
  includeSubagents: boolean,
): Promise<TranscriptCodecResult> {
  const location = await locateTranscript(storeDir, id);
  if (!location) throw new Error(`Session not found: ${id}`);
  return rehydrateLocatedTranscript(storeDir, location, includeSubagents);
}
