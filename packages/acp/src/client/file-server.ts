/**
 * FileServer — answers `fs/read_text_file` and `fs/write_text_file`
 * from an ACP agent, scoped to a single project root.
 *
 * Per the spec, all file paths in ACP MUST be absolute. We additionally
 * require them to resolve under `projectRoot` after normalisation AND after
 * resolving symlinks (`fs.realpath`). A path that passes a lexical prefix
 * check but points outside the root via an in-project symlink/junction is
 * rejected. This closes the CWE-22/CWE-59 symlink-escape vector that a
 * purely textual containment check leaves open.
 *
 * The server itself is transport-agnostic: the caller (ACPSession)
 * routes incoming fs/* requests to `readTextFile`/`writeTextFile` and
 * sends the result back. Keeping the routing out of this class lets the
 * file logic be unit-tested in isolation.
 */
import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

export interface FileServerOptions {
  /** Absolute path; only files under this root are accessible. */
  projectRoot: string;
  /** Per-call timeout, default 30s. */
  timeoutMs?: number;
  /**
   * Hard cap on the number of bytes that may be read in a single
   * `readTextFile` call. Protects against a malicious agent requesting a
   * gigantic file to exhaust host memory. Default 5 MiB.
   */
  maxReadBytes?: number;
  /**
   * Hard cap on the number of bytes that may be written in a single
   * `writeTextFile` call. Default 5 MiB.
   */
  maxWriteBytes?: number;
  /** Filesystem implementation override for deterministic tests. */
  operations?: FileServerOperations;
}

export interface FileServerOperations {
  stat(file: string): Promise<{ size: number }>;
  readFile(file: string, options: { encoding: 'utf8'; signal: AbortSignal }): Promise<string>;
  writeFile(
    file: string,
    content: string,
    options: { encoding: 'utf8'; signal: AbortSignal },
  ): Promise<void>;
  realpath(file: string): Promise<string>;
  rename(from: string, to: string): Promise<void>;
  unlink(file: string): Promise<void>;
}

const DEFAULT_FILE_OPERATIONS: FileServerOperations = {
  stat: fsp.stat,
  readFile: fsp.readFile,
  writeFile: fsp.writeFile,
  realpath: fsp.realpath,
  rename: fsp.rename,
  unlink: fsp.unlink,
};

export interface ReadFileParams {
  sessionId: string;
  path: string;
}

export interface WriteFileParams {
  sessionId: string;
  path: string;
  content: string;
}

export type FsErrorCode =
  | 'ENOENT'
  | 'EACCES'
  | 'OUTSIDE_ROOT'
  | 'TIMEOUT'
  | 'INVALID_PATH'
  | 'TOO_LARGE';

const DEFAULT_MAX_READ_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_WRITE_BYTES = 5 * 1024 * 1024;

/**
 * Thrown for protocol-level rejections (path outside root, etc.).
 * The session converts these into JSON-RPC error responses.
 */
export class FsError extends Error {
  readonly code: FsErrorCode;
  readonly path: string;
  constructor(code: FsErrorCode, path: string, message: string) {
    super(message);
    this.name = 'FsError';
    this.code = code;
    this.path = path;
  }
}

export class FileServer {
  private readonly root: string;
  private readonly realRoot: string;
  private readonly timeoutMs: number;
  private readonly maxReadBytes: number;
  private readonly maxWriteBytes: number;
  private readonly operations: FileServerOperations;

  constructor(opts: FileServerOptions) {
    this.root = path.resolve(opts.projectRoot);
    // Resolve the root itself once — it may be a symlink (macOS /var →
    // /private/var, Windows 8.3 short names, etc.). All realpaths are
    // compared against this canonical root for a like-for-like check.
    // Synchronous in constructor: the root must exist for an ACP session
    // and this keeps the per-call path simple.
    this.realRoot = safeRealpathSync(this.root);
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.maxReadBytes = opts.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;
    this.maxWriteBytes = opts.maxWriteBytes ?? DEFAULT_MAX_WRITE_BYTES;
    this.operations = opts.operations ?? DEFAULT_FILE_OPERATIONS;
  }

  /** Read a text file. Returns the content as a string. */
  async readTextFile(params: ReadFileParams): Promise<{ content: string }> {
    const safe = await this.resolveInside(params.path);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      // Size check before reading to prevent loading a huge file.
      const stat = await this.operations.stat(safe).catch((err) => {
        throw mapFsError(err, safe);
      });
      if (stat.size > this.maxReadBytes) {
        throw new FsError(
          'TOO_LARGE',
          safe,
          `file is ${stat.size} bytes, max read is ${this.maxReadBytes} bytes`,
        );
      }
      const content = await this.operations.readFile(safe, {
        encoding: 'utf8',
        signal: controller.signal,
      });
      return { content };
    } catch (err) {
      if (err instanceof FsError) throw err;
      if (controller.signal.aborted) {
        throw new FsError('TIMEOUT', safe, `readTextFile timed out after ${this.timeoutMs}ms`);
      }
      throw mapFsError(err, safe);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Write a text file. Atomic via write-then-rename. */
  async writeTextFile(params: WriteFileParams): Promise<void> {
    const byteLength = Buffer.byteLength(params.content, 'utf8');
    if (byteLength > this.maxWriteBytes) {
      throw new FsError(
        'TOO_LARGE',
        params.path,
        `content is ${byteLength} bytes, max write is ${this.maxWriteBytes} bytes`,
      );
    }

    const safe = await this.resolveInside(params.path);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const tmp = `${safe}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await this.operations.writeFile(tmp, params.content, {
        encoding: 'utf8',
        signal: controller.signal,
      });
      // Re-verify both tmp and the rename destination's parent dir before
      // rename. This closes the TOCTOU window where an attacker could plant a
      // symlink at the destination's parent between resolveInside and rename.
      await this.assertRealInside(tmp);
      await this.assertRealInside(path.dirname(safe));
      await this.operations.rename(tmp, safe);
    } catch (err) {
      if (err instanceof FsError) {
        // Best-effort cleanup of the tmp file
        await this.operations.unlink(tmp).catch(() => undefined);
        throw err;
      }
      // Best-effort cleanup of the tmp file
      try {
        await this.operations.unlink(tmp);
      } catch {
        // tmp didn't exist; ignore
      }
      if (controller.signal.aborted) {
        throw new FsError('TIMEOUT', safe, `writeTextFile timed out after ${this.timeoutMs}ms`);
      }
      throw mapFsError(err, safe);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Resolve a path and verify it is inside the project root by realpath.
   * Rejects with `FsError` if the textual path, the resolved path, or the
   * real (symlink-resolved) path escapes the project root.
   *
   * For files that don't exist yet (e.g. a write to a new file), the
   * nearest existing ancestor directory is realpath-checked instead.
   */
  private async resolveInside(p: string): Promise<string> {
    if (typeof p !== 'string' || p.length === 0) {
      throw new FsError('INVALID_PATH', p, 'path is empty or not a string');
    }
    if (!path.isAbsolute(p)) {
      throw new FsError('INVALID_PATH', p, 'path must be absolute (ACP requirement)');
    }
    const resolved = path.resolve(p);
    // +path.sep prevents "/project-evil" matching "/project" as a prefix.
    const rootWithSep = this.root.endsWith(path.sep) ? this.root : this.root + path.sep;
    if (resolved !== this.root && !resolved.startsWith(rootWithSep)) {
      throw new FsError('OUTSIDE_ROOT', resolved, 'path is outside the project root');
    }

    // Now resolve symlinks and compare against the canonical root.
    await this.assertRealInside(resolved);
    return resolved;
  }

  /**
   * Resolve `resolvedPath` through `fs.realpath` and verify the result is
   * inside `realRoot`. For non-existent paths (new files), walk up to the
   * nearest existing ancestor and check that instead.
   */
  private async assertRealInside(resolvedPath: string): Promise<void> {
    let probe = resolvedPath;
    for (;;) {
      let real: string;
      try {
        real = await this.operations.realpath(probe);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          const parent = path.dirname(probe);
          if (parent === probe) {
            throw new FsError('ENOENT', resolvedPath, `no existing ancestor: ${resolvedPath}`);
          }
          probe = parent;
          continue;
        }
        throw mapFsError(err, resolvedPath);
      }
      if (real === this.realRoot || real.startsWith(this.realRoot + path.sep)) return;
      throw new FsError(
        'OUTSIDE_ROOT',
        resolvedPath,
        'path resolves through a symlink outside the project root',
      );
    }
  }
}

function mapFsError(err: unknown, p: string): FsError {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') return new FsError('ENOENT', p, `no such file: ${p}`);
  if (code === 'EACCES' || code === 'EPERM') {
    return new FsError('EACCES', p, `permission denied: ${p}`);
  }
  const msg = err instanceof Error ? err.message : String(err);
  return new FsError('INVALID_PATH', p, msg);
}

/**
 * Synchronous realpath that falls back to the input on failure (root may be
 * a fresh directory that hasn't been statted yet). The constructor needs the
 * canonical root before any async call so per-request resolveInside has a
 * stable comparison target.
 */
function safeRealpathSync(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}
