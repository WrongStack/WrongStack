import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { WorkspaceCheckpointRef, WorkspaceMaterializationResult } from '../types/session.js';
import { atomicWrite } from '../utils/atomic-write.js';
import { buildChildEnv } from '../utils/child-env.js';
import { toErrorMessage } from '../utils/error.js';
import { mapWithConcurrency } from './storage-concurrency.js';

export interface CheckpointGitResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Set when the runner discarded output after its safety limit. */
  stdoutTruncated?: boolean | undefined;
  stderrTruncated?: boolean | undefined;
}

export interface SessionCheckpointCasOptions {
  rootDir: string;
  projectRoot: string;
  runGit?: ((args: string[], cwd: string) => Promise<CheckpointGitResult>) | undefined;
}

type WorkspaceCheckpointEntry =
  | { path: string; state: 'file'; blobHash: string; mode: number }
  | { path: string; state: 'absent' }
  | { path: string; state: 'symlink'; linkTarget: string };

interface WorkspaceCheckpointManifest {
  version: 1;
  baseHead: string;
  coverage: 'git-head-plus-dirty';
  entries: WorkspaceCheckpointEntry[];
  unresolved: Array<{ path: string; reason: string }>;
}

const HASH_RE = /^[a-f\d]{64}$/;
const CAPTURE_CONCURRENCY = 8;
const MAX_GIT_OUTPUT = 16 * 1024 * 1024;
const MAX_BLOB_BYTES = 64 * 1024 * 1024;
const MAX_CHECKPOINT_BYTES = 512 * 1024 * 1024;

function sha256(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizeRelative(input: string): string | null {
  if (!input || path.isAbsolute(input)) return null;
  const normalized = input.replace(/\\/g, '/').replace(/^\.\//, '');
  const resolved = path.posix.normalize(normalized);
  if (!resolved || resolved === '.' || resolved === '..' || resolved.startsWith('../')) return null;
  return resolved;
}

function parseNulPaths(output: string): string[] {
  return output
    .split('\0')
    .map(normalizeRelative)
    .filter((value): value is string => value !== null);
}

function isWrongStackWorktreePath(relative: string): boolean {
  return relative === '.wrongstack/worktrees' || relative.startsWith('.wrongstack/worktrees/');
}

/**
 * Content-addressed workspace checkpoint store.
 *
 * A manifest references a Git base tree plus CAS blobs for every changed or
 * untracked, non-ignored path. Applying it to a checkout at the same baseHead
 * reproduces the checkpoint without touching the parent working tree.
 */
export class SessionCheckpointCas {
  private readonly rootDir: string;
  private readonly projectRoot: string;
  private readonly runGit: (args: string[], cwd: string) => Promise<CheckpointGitResult>;

  constructor(opts: SessionCheckpointCasOptions) {
    this.rootDir = path.resolve(opts.rootDir);
    this.projectRoot = path.resolve(opts.projectRoot);
    this.runGit = opts.runGit ?? defaultRunGit;
  }

  async capture(
    _sessionId: string,
    _promptIndex: number,
  ): Promise<WorkspaceCheckpointRef | undefined> {
    const head = await this.runGit(['rev-parse', '--verify', 'HEAD'], this.projectRoot);
    const baseHead = head.stdout.trim();
    if (head.code !== 0 || head.stdoutTruncated || !/^[a-f\d]{40,64}$/i.test(baseHead)) {
      return undefined;
    }

    const [tracked, untracked] = await Promise.all([
      this.runGit(['diff', 'HEAD', '--name-only', '-z', '--'], this.projectRoot),
      this.runGit(['ls-files', '--others', '--exclude-standard', '-z'], this.projectRoot),
    ]);
    if (
      tracked.code !== 0 ||
      untracked.code !== 0 ||
      tracked.stdoutTruncated ||
      untracked.stdoutTruncated
    ) {
      return undefined;
    }

    const relativePaths = [
      ...new Set([...parseNulPaths(tracked.stdout), ...parseNulPaths(untracked.stdout)]),
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
      coverage: 'git-head-plus-dirty',
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
    const targetHead = await this.runGit(['rev-parse', '--verify', 'HEAD'], target);
    if (
      targetHead.code !== 0 ||
      targetHead.stdoutTruncated ||
      targetHead.stdout.trim().toLowerCase() !== manifest.baseHead
    ) {
      throw new Error(
        `Checkpoint target HEAD must equal ${manifest.baseHead}; got ${targetHead.stdout.trim() || 'unknown'}`,
      );
    }
    const materializingParentRoot = target === this.projectRoot;
    if (!materializingParentRoot) {
      const targetStatus = await this.runGit(
        ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching'],
        target,
      );
      if (targetStatus.code !== 0 || targetStatus.stdoutTruncated) {
        throw new Error('Unable to verify that the checkpoint target is clean');
      }
      if (targetStatus.stdout.length > 0) {
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
      parsed.coverage !== 'git-head-plus-dirty' ||
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

function defaultRunGit(args: string[], cwd: string): Promise<CheckpointGitResult> {
  return new Promise((resolve) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    const child = spawn('git', args, {
      cwd,
      env: buildChildEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: AbortSignal.timeout(30_000),
      windowsHide: true,
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      const remaining = MAX_GIT_OUTPUT - stdoutBytes;
      if (remaining <= 0) {
        stdoutTruncated = true;
        return;
      }
      const kept = chunk.subarray(0, remaining);
      stdoutChunks.push(kept);
      stdoutBytes += kept.length;
      if (kept.length < chunk.length) stdoutTruncated = true;
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const remaining = MAX_GIT_OUTPUT - stderrBytes;
      if (remaining <= 0) {
        stderrTruncated = true;
        return;
      }
      const kept = chunk.subarray(0, remaining);
      stderrChunks.push(kept);
      stderrBytes += kept.length;
      if (kept.length < chunk.length) stderrTruncated = true;
    });
    const result = (code: number, extraStderr?: string): CheckpointGitResult => ({
      code,
      stdout: Buffer.concat(stdoutChunks).toString('utf8'),
      stderr: `${Buffer.concat(stderrChunks).toString('utf8')}${extraStderr ?? ''}`,
      stdoutTruncated,
      stderrTruncated,
    });
    child.on('error', (err) => resolve(result(1, err.message)));
    child.on('close', (code) => resolve(result(code ?? 1)));
  });
}
