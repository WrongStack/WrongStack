import { createHash, randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type {
  WorkspaceCheckpointCoverage,
  WorkspaceCheckpointRef,
  WorkspaceMaterializationResult,
} from '@wrongstack/contracts/types/session';
import { atomicWrite } from '../utils/atomic-write.js';
import { toErrorMessage } from '../utils/error.js';
import { openVcs, type VcsKind, type VcsOptions } from '../vcs/vcs-adapter.js';
import { mapWithConcurrency } from './storage-concurrency.js';

export interface SessionCheckpointCasOptions {
  rootDir: string;
  projectRoot: string;
  /** How to reach the project's version control; tests inject a runner. */
  vcs?: VcsOptions | undefined;
}

type WorkspaceCheckpointEntry =
  | { path: string; state: 'file'; blobHash: string; mode: number }
  | { path: string; state: 'absent' }
  | { path: string; state: 'symlink'; linkTarget: string };

interface WorkspaceCheckpointManifest {
  version: 1;
  baseHead: string;
  coverage: WorkspaceCheckpointCoverage;
  entries: WorkspaceCheckpointEntry[];
  unresolved: Array<{ path: string; reason: string }>;
}

const HASH_RE = /^[a-f\d]{64}$/;
const CAPTURE_CONCURRENCY = 8;
const MAX_BLOB_BYTES = 64 * 1024 * 1024;
const MAX_CHECKPOINT_BYTES = 512 * 1024 * 1024;

function sha256(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  // Canonical escape test: `..hidden` is a legal in-root first segment.
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function normalizeRelative(input: string): string | null {
  if (!input || path.isAbsolute(input)) return null;
  const normalized = input.replace(/\\/g, '/').replace(/^\.\//, '');
  const resolved = path.posix.normalize(normalized);
  if (!resolved || resolved === '.' || resolved === '..' || resolved.startsWith('../')) return null;
  return resolved;
}

const COVERAGE: Record<VcsKind, WorkspaceCheckpointCoverage> = {
  git: 'git-head-plus-dirty',
  jj: 'jj-head-plus-dirty',
  hg: 'hg-head-plus-dirty',
};

function vcsOfCoverage(coverage: unknown): VcsKind | undefined {
  return (Object.keys(COVERAGE) as VcsKind[]).find((kind) => COVERAGE[kind] === coverage);
}

/**
 * `relative` (to the repository root) as a path relative to `projectRoot`,
 * or null when it lies outside the project.
 */
function toProjectRelative(repoRoot: string, projectRoot: string, relative: string): string | null {
  const prefix = path.relative(repoRoot, projectRoot).split(path.sep).join('/');
  if (!prefix) return relative;
  return relative.startsWith(`${prefix}/`) ? relative.slice(prefix.length + 1) : null;
}

/**
 * Mark a deduplicated CAS file as just used. The checkpoint GC spares anything
 * younger than its age floor, so a new checkpoint that reuses an old object or
 * manifest must make it young again — otherwise a sweep running concurrently
 * deletes what the new checkpoint references.
 */
async function touch(file: string): Promise<void> {
  const now = new Date();
  await fsp.utimes(file, now, now).catch(() => undefined);
}

function isWrongStackWorktreePath(relative: string): boolean {
  return relative === '.wrongstack/worktrees' || relative.startsWith('.wrongstack/worktrees/');
}

/**
 * Content-addressed workspace checkpoint store.
 *
 * A manifest references the commit the working copy is based on (git, jj or
 * hg) plus CAS blobs for every changed or untracked, non-ignored path.
 * Applying it to a checkout at the same base reproduces the checkpoint
 * without touching the parent working tree.
 */
export class SessionCheckpointCas {
  private readonly rootDir: string;
  private readonly projectRoot: string;
  private readonly vcs: VcsOptions;

  constructor(opts: SessionCheckpointCasOptions) {
    this.rootDir = path.resolve(opts.rootDir);
    this.projectRoot = path.resolve(opts.projectRoot);
    this.vcs = opts.vcs ?? {};
  }

  async capture(
    _sessionId: string,
    _promptIndex: number,
  ): Promise<WorkspaceCheckpointRef | undefined> {
    const vcs = await openVcs(this.projectRoot, this.vcs);
    if (!vcs) return undefined;
    const [baseHead, changed] = await Promise.all([vcs.baseRevision(), vcs.changedPaths()]);
    if (!baseHead || !changed) return undefined;

    const relativePaths = [
      ...new Set(
        changed
          .map((relative) => toProjectRelative(vcs.root, this.projectRoot, relative))
          .filter((relative): relative is string => relative !== null),
      ),
    ]
      // Never recursively capture WrongStack's own allocated checkouts, even
      // if a repository accidentally tracks that administrative directory.
      .filter((relative) => !isWrongStackWorktreePath(relative))
      .sort();
    const unresolved: WorkspaceCheckpointManifest['unresolved'] = [];
    let scheduledBytes = 0;
    const captured = await mapWithConcurrency(
      relativePaths,
      CAPTURE_CONCURRENCY,
      async (relative): Promise<WorkspaceCheckpointEntry | null> => {
        const absolute = path.resolve(this.projectRoot, ...relative.split('/'));
        if (!isInside(this.projectRoot, absolute)) {
          unresolved.push({ path: relative, reason: 'path escapes project root' });
          return null;
        }
        try {
          const stat = await fsp.lstat(absolute);
          if (stat.isSymbolicLink()) {
            const linkTarget = await fsp.readlink(absolute);
            const resolvedLink = path.resolve(path.dirname(absolute), linkTarget);
            if (path.isAbsolute(linkTarget) || !isInside(this.projectRoot, resolvedLink)) {
              unresolved.push({
                path: relative,
                reason: 'symlink target escapes project root',
              });
              return null;
            }
            return { path: relative, state: 'symlink', linkTarget };
          }
          if (!stat.isFile()) {
            unresolved.push({ path: relative, reason: 'changed path is not a regular file' });
            return null;
          }
          if (stat.size > MAX_BLOB_BYTES) {
            unresolved.push({
              path: relative,
              reason: `file exceeds ${MAX_BLOB_BYTES}-byte checkpoint blob limit`,
            });
            return null;
          }
          if (scheduledBytes + stat.size > MAX_CHECKPOINT_BYTES) {
            unresolved.push({
              path: relative,
              reason: `checkpoint exceeds ${MAX_CHECKPOINT_BYTES}-byte aggregate blob limit`,
            });
            return null;
          }
          scheduledBytes += stat.size;
          const content = await fsp.readFile(absolute);
          const blobHash = sha256(content);
          await this.putBlob(blobHash, content);
          return { path: relative, state: 'file', blobHash, mode: stat.mode & 0o777 };
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            return { path: relative, state: 'absent' };
          }
          unresolved.push({ path: relative, reason: toErrorMessage(err) });
          return null;
        }
      },
    );

    const capturedAt = new Date().toISOString();
    const manifest: WorkspaceCheckpointManifest = {
      version: 1,
      baseHead: baseHead.toLowerCase(),
      coverage: COVERAGE[vcs.kind],
      entries: captured.filter((entry): entry is WorkspaceCheckpointEntry => entry !== null),
      unresolved: [...unresolved].sort((a, b) => a.path.localeCompare(b.path)),
    };
    const encoded = JSON.stringify(manifest);
    const manifestHash = sha256(encoded);
    await this.putManifest(manifestHash, encoded);
    return {
      manifestHash,
      baseHead: manifest.baseHead,
      entryCount: manifest.entries.length,
      unresolvedCount: manifest.unresolved.length,
      capturedAt,
      coverage: manifest.coverage,
    };
  }

  async materialize(
    checkpoint: WorkspaceCheckpointRef,
    targetRoot: string,
  ): Promise<WorkspaceMaterializationResult> {
    const target = path.resolve(targetRoot);
    const targetStat = await fsp.stat(target);
    if (!targetStat.isDirectory())
      throw new Error(`Checkpoint target is not a directory: ${target}`);

    const manifest = await this.loadManifest(checkpoint.manifestHash);
    if (
      manifest.baseHead !== checkpoint.baseHead.toLowerCase() ||
      manifest.coverage !== checkpoint.coverage ||
      manifest.entries.length !== checkpoint.entryCount ||
      manifest.unresolved.length !== checkpoint.unresolvedCount
    ) {
      throw new Error('Workspace checkpoint reference does not match its CAS manifest');
    }
    if (manifest.unresolved.length > 0) {
      throw new Error(
        `Workspace checkpoint has ${manifest.unresolved.length} unresolved path(s); exact materialization refused`,
      );
    }
    const kind = vcsOfCoverage(manifest.coverage);
    const targetVcs = await openVcs(target, this.vcs);
    if (!targetVcs || targetVcs.kind !== kind) {
      const found = targetVcs ? `a ${targetVcs.kind} checkout` : 'not under version control';
      throw new Error(`Checkpoint was taken in a ${kind} checkout; the target is ${found}`);
    }
    const targetHead = await targetVcs.baseRevision();
    if (targetHead !== manifest.baseHead) {
      throw new Error(
        `Checkpoint target HEAD must equal ${manifest.baseHead}; got ${targetHead ?? 'unknown'}`,
      );
    }
    const materializingParentRoot = target === this.projectRoot;
    if (!materializingParentRoot) {
      const pristine = await targetVcs.isPristine();
      if (pristine === undefined) {
        throw new Error('Unable to verify that the checkpoint target is clean');
      }
      if (!pristine) {
        throw new Error('Checkpoint target must be a clean checkout before materialization');
      }
    }

    const realTarget = await fsp.realpath(target);
    const writtenFiles: string[] = [];
    const deletedFiles: string[] = [];
    const errors: string[] = [];
    const prepared: Array<{
      entry: WorkspaceCheckpointEntry;
      output: string;
      content?: Buffer | undefined;
    }> = [];
    for (const entry of manifest.entries) {
      try {
        const output = await this.safeOutputPath(target, realTarget, entry.path);
        if (entry.state === 'symlink') {
          if (path.isAbsolute(entry.linkTarget)) {
            throw new Error('absolute symlink target refused');
          }
          const resolvedLink = path.resolve(path.dirname(output), entry.linkTarget);
          if (!isInside(target, resolvedLink))
            throw new Error('symlink target escapes checkpoint root');
        }
        prepared.push({
          entry,
          output,
          ...(entry.state === 'file' ? { content: await this.readBlob(entry.blobHash) } : {}),
        });
      } catch (err) {
        errors.push(`${entry.path}: ${toErrorMessage(err)}`);
      }
    }
    // Integrity and path validation happen before the first mutation. This is
    // not a cross-file filesystem transaction, but corrupt input cannot leave
    // an otherwise clean target half-applied.
    if (errors.length > 0) {
      return { targetRoot: target, writtenFiles, deletedFiles, errors };
    }

    for (const { entry, output, content } of prepared) {
      try {
        if (entry.state === 'absent') {
          await fsp.unlink(output).catch((err) => {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
          });
          deletedFiles.push(entry.path);
          continue;
        }
        if (entry.state === 'symlink') {
          await fsp.unlink(output).catch((err) => {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
          });
          await fsp.mkdir(path.dirname(output), { recursive: true });
          await fsp.symlink(entry.linkTarget, output);
          writtenFiles.push(entry.path);
          continue;
        }
        if (!content) throw new Error('CAS blob was not prepared');
        await atomicWrite(output, content, { mode: entry.mode });
        await fsp.chmod(output, entry.mode).catch(() => undefined);
        writtenFiles.push(entry.path);
      } catch (err) {
        errors.push(`${entry.path}: ${toErrorMessage(err)}`);
      }
    }
    return { targetRoot: target, writtenFiles, deletedFiles, errors };
  }

  private objectPath(hash: string): string {
    if (!HASH_RE.test(hash)) throw new Error(`Invalid CAS object hash: ${hash}`);
    return path.join(this.rootDir, 'objects', hash.slice(0, 2), hash.slice(2));
  }

  private manifestPath(hash: string): string {
    if (!HASH_RE.test(hash)) throw new Error(`Invalid checkpoint manifest hash: ${hash}`);
    return path.join(this.rootDir, 'manifests', `${hash}.json`);
  }

  private async putBlob(hash: string, content: Buffer): Promise<void> {
    const target = this.objectPath(hash);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    try {
      const existing = await fsp.readFile(target);
      if (sha256(existing) !== hash) throw new Error(`Corrupt CAS object collision: ${hash}`);
      await touch(target);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }

    // Publish only a fully-written object. Creating the final path first would
    // expose a partial blob to another process (or leave one after a crash).
    // A same-directory hard link is an atomic create-if-absent operation.
    const temp = path.join(
      path.dirname(target),
      `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`,
    );
    let handle: fsp.FileHandle | undefined;
    try {
      handle = await fsp.open(temp, 'wx', 0o600);
      await handle.writeFile(content);
      await handle.sync();
      await handle.close();
      handle = undefined;
      try {
        await fsp.link(temp, target);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        const existing = await fsp.readFile(target);
        if (sha256(existing) !== hash) throw new Error(`Corrupt CAS object collision: ${hash}`);
        await touch(target);
      }
    } finally {
      await handle?.close().catch(() => undefined);
      await fsp.unlink(temp).catch(() => undefined);
    }
  }

  private async putManifest(hash: string, encoded: string): Promise<void> {
    const target = this.manifestPath(hash);
    const existing = await fsp.readFile(target).catch(() => null);
    if (existing) {
      if (sha256(existing) !== hash)
        throw new Error(`Corrupt checkpoint manifest collision: ${hash}`);
      await touch(target);
      return;
    }
    await atomicWrite(target, encoded, { mode: 0o600 });
  }

  private async readBlob(hash: string): Promise<Buffer> {
    const content = await fsp.readFile(this.objectPath(hash));
    if (sha256(content) !== hash) throw new Error(`CAS blob integrity check failed: ${hash}`);
    return content;
  }

  private async loadManifest(hash: string): Promise<WorkspaceCheckpointManifest> {
    const raw = await fsp.readFile(this.manifestPath(hash));
    if (sha256(raw) !== hash)
      throw new Error(`Checkpoint manifest integrity check failed: ${hash}`);
    const parsed = JSON.parse(raw.toString('utf8')) as Partial<WorkspaceCheckpointManifest>;
    if (
      parsed.version !== 1 ||
      typeof parsed.baseHead !== 'string' ||
      !vcsOfCoverage(parsed.coverage) ||
      !Array.isArray(parsed.entries) ||
      !Array.isArray(parsed.unresolved)
    ) {
      throw new Error(`Invalid workspace checkpoint manifest: ${hash}`);
    }
    const entriesValid = parsed.entries.every((entry) => {
      if (!entry || typeof entry !== 'object') return false;
      const candidate = entry as Partial<WorkspaceCheckpointEntry>;
      if (typeof candidate.path !== 'string' || !normalizeRelative(candidate.path)) return false;
      if (candidate.state === 'absent') return true;
      if (candidate.state === 'symlink') return typeof candidate.linkTarget === 'string';
      return (
        candidate.state === 'file' &&
        typeof candidate.blobHash === 'string' &&
        HASH_RE.test(candidate.blobHash) &&
        typeof candidate.mode === 'number' &&
        Number.isInteger(candidate.mode) &&
        candidate.mode >= 0 &&
        candidate.mode <= 0o777
      );
    });
    const unresolvedValid = parsed.unresolved.every(
      (entry) =>
        entry !== null &&
        typeof entry === 'object' &&
        typeof entry.path === 'string' &&
        typeof entry.reason === 'string',
    );
    if (!entriesValid || !unresolvedValid) {
      throw new Error(`Invalid workspace checkpoint manifest entries: ${hash}`);
    }
    return parsed as WorkspaceCheckpointManifest;
  }

  private async safeOutputPath(
    target: string,
    realTarget: string,
    relative: string,
  ): Promise<string> {
    const normalized = normalizeRelative(relative);
    if (!normalized) throw new Error('invalid relative path');
    const output = path.resolve(target, ...normalized.split('/'));
    if (!isInside(target, output)) throw new Error('path escapes checkpoint target');

    let probe = output;
    for (;;) {
      try {
        const real = await fsp.realpath(probe);
        if (!isInside(realTarget, real))
          throw new Error('path resolves through a symlink outside checkpoint target');
        return output;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        const parent = path.dirname(probe);
        if (parent === probe) throw err;
        probe = parent;
      }
    }
  }
}
