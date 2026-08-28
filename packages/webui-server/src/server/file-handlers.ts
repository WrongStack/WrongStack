/**
 * Shared file-operation WebSocket handlers for both the standalone WebUI
 * server and the CLI's `--webui` embedded server. Extracted from the
 * duplicated switch cases in `index.ts` and `cli/src/webui-server.ts`.
 *
 * Each function handles the full request→response cycle for one message
 * type. Callers drop them into their switch statement:
 *
 *   case 'files.tree': return handleFilesTree(ws, msg, projectRoot);
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ToolValidationError } from '@wrongstack/core/types';
import { atomicWrite } from '@wrongstack/core/utils';
import { enqueueReindex, extractFileSkeleton, type SkeletonOptions } from '@wrongstack/tools';
import type { WebSocket } from 'ws';
import { isHiddenEntry, rankFiles, SKIP_DIRS } from './file-picker.js';
import { isPathInside, resolveWorkingDirInsideProject } from './path-containment.js';
import { errMessage, messageSessionId, send } from './ws-utils.js';

/**
 * Resolve a user-supplied file path against `projectRoot` and verify the
 * canonical (real) path stays inside the canonical project root. This
 * rejects:
 *   - lexical escapes (`../../etc/passwd`)
 *   - in-project symlinks that point outside the project root
 *   - absolute paths outside the project root
 *
 * The target file does not need to exist; we `realpath` the parent
 * directory and re-attach the basename. This matches the behavior of
 * `realpath(3)` once the file is later created.
 */
async function resolveFileInsideProject(projectRoot: string, filePath: string): Promise<string> {
  // Lexical containment check first — cheap, and avoids calling realpath
  // on a path we already know is bogus. This also blocks `..` segments.
  const resolved = path.resolve(projectRoot, filePath);
  if (!isPathInside(projectRoot, resolved)) {
    throw new ToolValidationError({ message: 'Path outside project root', field: 'path' });
  }

  // Canonical containment: walk the parent directory's real path and
  // re-attach the basename. If the parent doesn't exist yet, walk up
  // until we find an existing ancestor and verify the rest of the path
  // is still inside the real project root.
  const { parent, base } = splitParentAndBase(resolved);
  const realProjectRoot = await fs.realpath(projectRoot);
  const realParent = await realpathAllowMissing(parent);
  const realFull = path.join(realParent, base);
  if (!isPathInside(realProjectRoot, realFull)) {
    throw new ToolValidationError({ message: 'Path outside project root', field: 'path' });
  }
  // The parent walk canonicalizes the directory chain but re-attaches the
  // basename verbatim, so a symlink at the final component is NOT resolved
  // by the check above — `fs.readFile`/`atomicWrite` would follow it and
  // escape the project root. lstat the final component (lstat never follows
  // symlinks); if it is a link, canonicalize its true target and re-verify
  // containment. A dangling link cannot be verified, so it is rejected.
  const realFinal = await canonicalizeFinalComponent(realFull);
  if (!isPathInside(realProjectRoot, realFinal)) {
    throw new ToolValidationError({ message: 'Path outside project root', field: 'path' });
  }
  return realFinal;
}

/**
 * Canonicalize the final path component when it is a symlink. `lstat` does
 * not follow symlinks, so this detects a link at the target itself without
 * traversing it. A regular file or a missing path (a write target that does
 * not exist yet) is returned unchanged. A symlink is resolved with
 * `realpath` so the caller can re-check containment against its true target;
 * a dangling symlink (realpath ENOENT) cannot be verified and is rejected
 * conservatively rather than followed.
 */
async function canonicalizeFinalComponent(p: string): Promise<string> {
  let stat: import('node:fs').Stats;
  try {
    stat = await fs.lstat(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return p;
    throw err;
  }
  if (!stat.isSymbolicLink()) return p;
  try {
    return await fs.realpath(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ToolValidationError({ message: 'Path outside project root', field: 'path' });
    }
    throw err;
  }
}

function splitParentAndBase(p: string): { parent: string; base: string } {
  const base = path.basename(p);
  const parent = path.dirname(p);
  return { parent, base };
}

/**
 * `realpath` that does not throw when the path doesn't exist. Walks up
 * until an existing ancestor is found, realpaths that ancestor, then
 * re-attaches the missing tail. This is what we need for write targets
 * that don't exist yet, and for read targets whose parent may have
 * been deleted between check and use.
 */
async function realpathAllowMissing(p: string): Promise<string> {
  // Existing path — normal realpath, canonicalizing any symlinks.
  try {
    return await fs.realpath(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  // Walk up to the first existing ancestor, realpath that, and reattach.
  const segments: string[] = [];
  let cursor = p;
  while (true) {
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      // Hit a filesystem root and still nothing exists. The lexical
      // check above already kept us inside projectRoot, so this should
      // be unreachable; bail out conservatively.
      throw new ToolValidationError({ message: 'Path outside project root', field: 'path' });
    }
    segments.unshift(path.basename(cursor));
    try {
      const realParent = await fs.realpath(parent);
      return path.join(realParent, ...segments);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      cursor = parent;
    }
  }
}

// ── Type helpers (inlined, no dependence on types.ts) ──

interface FilesListPayload {
  query?: string | undefined;
  limit?: number | undefined;
  /** Optional directory root for the file list (relative to projectRoot).
   *  When set, only files under this directory are returned. */
  path?: string | undefined;
}

interface FilesReadPayload {
  filePath: string;
}

interface FilesWritePayload {
  filePath: string;
  content: string;
}

/** Guard: ensure msg is an object with a payload of the expected shape.
 *  Throws TypeError if the shape is wrong so callers catch it explicitly. */
function validatedPayload<T>(msg: unknown, label: string): T {
  if (msg == null || typeof msg !== 'object') {
    throw new TypeError(`Expected object for ${label}, got ${msg}`);
  }
  const payload = (msg as { payload?: unknown }).payload;
  if (payload == null || typeof payload !== 'object') {
    throw new TypeError(`Expected payload object for ${label}, got ${payload}`);
  }
  return payload as T;
}

function withSessionEcho<T extends Record<string, unknown>>(
  payload: T,
  sessionId: string | undefined,
): T & { sessionId?: string } {
  return sessionId ? { ...payload, sessionId } : payload;
}

interface FilesWriteOptions {
  onWritten?: ((filePath: string) => void | Promise<void>) | undefined;
}

// ── Shared handlers ───────────────────────────────────────────────────

/**
 * Build and send a nested directory tree for the File Explorer.
 *
 * Walks `projectRoot` to depth 10 max, skipping heavyweight dirs
 * (node_modules, .git, dist, …) and dot-entries. Responds with
 * `{ type: 'files.tree', payload: { root, tree } }`.
 */
export async function handleFilesTree(
  ws: WebSocket,
  msg: unknown,
  projectRoot: string,
): Promise<void> {
  interface TreeNode {
    name: string;
    path: string;
    type: 'file' | 'directory';
    children?: TreeNode[];
    size?: number;
    lastModified?: number;
  }

  // Use the optional `path` from the message payload as the tree root.
  // When absent, empty, or ".", fall back to projectRoot (backward compatible).
  const sessionId = messageSessionId(msg as { payload?: unknown });
  const payload = (msg as { payload?: { path?: string | undefined } }).payload;
  const rawPath = payload?.path?.trim();

  // Guard: the requested tree root must be both lexically AND via
  // realpath() inside the project root. A symlinked subdirectory that
  // points outside the project would otherwise expose arbitrary
  // directory structure to a connected client.
  let treeRoot: string;
  let realProjectRoot: string;
  try {
    if (rawPath && rawPath !== '.') {
      treeRoot = await resolveWorkingDirInsideProject(projectRoot, rawPath);
    } else {
      treeRoot = projectRoot;
    }
    realProjectRoot = await fs.realpath(projectRoot);
  } catch {
    send(ws, {
      type: 'files.tree',
      payload: withSessionEcho(
        { root: projectRoot, tree: [], error: 'Path outside project root' },
        sessionId,
      ),
    });
    return;
  }

  // Compute the path prefix so tree paths are always relative to
  // projectRoot (not treeRoot). This ensures double-clicking a file in
  // the explorer sends the correct path to files.read/files.write.
  const pathPrefix =
    treeRoot === projectRoot
      ? ''
      : (path.relative(projectRoot, treeRoot) + '/').replace(/\\/g, '/');

  /**
   * Walk one directory level into `TreeNode`s.
   *
   * Two things this deliberately does NOT do, because the whole project is
   * walked eagerly on every `files.tree` and the explorer was visibly late:
   *
   *  - It does not `stat()` directories. The only field that stat produced for
   *    a directory was `lastModified`, which no client reads (the explorer
   *    sorts by `size`, a file-only field). `realpath` stays — that is the
   *    symlink-escape guard, not a metadata read.
   *  - It does not await entries one at a time. The per-entry `realpath`/`stat`
   *    are independent, so they go through libuv's threadpool together instead
   *    of queueing behind each other. `Promise.all` preserves array order, and
   *    `entries` is sorted first, so the emitted order is unchanged.
   *
   * Measured on this repo (8074 files / 672 dirs): ~500ms -> ~65ms, and the
   * payload drops from 1.23MB to 0.95MB.
   */
  async function buildTree(dir: string, rel: string, depth: number): Promise<TreeNode[]> {
    if (depth > 10) return [];
    let entries: import('node:fs').Dirent[] = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    const nodes = await Promise.all(
      entries.map(async (e): Promise<TreeNode | null> => {
        if (isHiddenEntry(e.name)) return null;
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        const childAbs = path.join(dir, e.name);
        // Prepend the workingDir prefix so the path is projectRoot-relative
        const childPath = pathPrefix + childRel;
        if (e.isDirectory()) {
          if (SKIP_DIRS.has(e.name)) return null;
          // Reject symlinked directories whose real path escapes the
          // real project root. A symlink to an in-project directory is
          // fine and recursed into normally.
          let realChild: string;
          try {
            realChild = await fs.realpath(childAbs);
          } catch {
            return null;
          }
          if (!isPathInside(realProjectRoot, realChild)) {
            return null;
          }
          return {
            name: e.name,
            path: childPath,
            type: 'directory',
            children: await buildTree(realChild, childRel, depth + 1),
          };
        }
        if (!e.isFile()) return null;
        let fileStat: import('node:fs').Stats;
        try {
          fileStat = await fs.stat(childAbs);
        } catch {
          return null;
        }
        return {
          name: e.name,
          path: childPath,
          type: 'file',
          size: fileStat.size,
        };
      }),
    );
    return nodes.filter((n): n is TreeNode => n !== null);
  }

  try {
    const tree = await buildTree(treeRoot, '', 0);
    const rootLabel =
      treeRoot === projectRoot ? projectRoot : path.relative(projectRoot, treeRoot) || '.';
    send(ws, {
      type: 'files.tree',
      payload: withSessionEcho({ root: rootLabel, tree }, sessionId),
    });
  } catch (err) {
    const rootLabel =
      treeRoot === projectRoot ? projectRoot : path.relative(projectRoot, treeRoot) || '.';
    send(ws, {
      type: 'files.tree',
      payload: withSessionEcho({ root: rootLabel, tree: [], error: errMessage(err) }, sessionId),
    });
  }
}

/**
 * Cap for files.read payloads — mirrors MAX_DIFF_BYTES in git-handlers.ts so
 * the editor surface never receives an unbounded string. Files above the cap
 * (or binary files, detected via a NUL byte like handleGitDiff) are reported
 * with a flag instead of content.
 */
const MAX_READ_BYTES = 2 * 1024 * 1024; // 2 MB

/**
 * Read a file's content for the Monaco editor.
 *
 * Guards against path traversal (`../` escapes) and, mirroring
 * handleGitDiff, refuses oversized (over 2 MB) and binary files by replying
 * with a `tooLarge` / `binary` flag instead of content. Responds with
 * `{ type: 'files.read', payload: { filePath, content } }`.
 */
export async function handleFilesRead(
  ws: WebSocket,
  msg: unknown,
  projectRoot: string,
): Promise<void> {
  const sessionId = messageSessionId(msg as { payload?: unknown });
  let filePath: string;
  try {
    ({ filePath } = validatedPayload<FilesReadPayload>(msg, 'files.read'));
  } catch {
    send(ws, {
      type: 'files.read',
      payload: withSessionEcho(
        { filePath: '', content: '', error: 'Malformed request' },
        sessionId,
      ),
    });
    return;
  }

  // Path traversal guard: resolve and verify both lexically AND via
  // realpath() that the file stays inside the canonical project root.
  // A string-prefix check is not enough — an in-project symlink to
  // an external file would otherwise escape the project root.
  let realResolved: string;
  try {
    realResolved = await resolveFileInsideProject(projectRoot, filePath);
  } catch {
    send(ws, {
      type: 'files.read',
      payload: withSessionEcho({ filePath, content: '', error: 'Forbidden' }, sessionId),
    });
    return;
  }

  try {
    // stat first: an oversized file is never read into memory at all.
    const stat = await fs.stat(realResolved);
    if (stat.size > MAX_READ_BYTES) {
      send(ws, {
        type: 'files.read',
        payload: withSessionEcho({ filePath, content: '', tooLarge: true }, sessionId),
      });
      return;
    }
    const buf = await fs.readFile(realResolved);
    if (buf.includes(0)) {
      send(ws, {
        type: 'files.read',
        payload: withSessionEcho({ filePath, content: '', binary: true }, sessionId),
      });
      return;
    }
    send(ws, {
      type: 'files.read',
      payload: withSessionEcho({ filePath, content: buf.toString('utf8') }, sessionId),
    });
  } catch (err) {
    send(ws, {
      type: 'files.read',
      payload: withSessionEcho({ filePath, content: '', error: errMessage(err) }, sessionId),
    });
  }
}

interface FilesSkeletonPayload {
  filePath: string;
  content?: string | undefined;
  options?: SkeletonOptions | undefined;
}

/**
 * Extract an AST-based skeleton for a file.
 * Responds with `{ type: 'files.skeleton_result', payload: { filePath, lang, skeleton, stats } }`.
 */
export async function handleFilesSkeleton(
  ws: WebSocket,
  msg: unknown,
  projectRoot: string,
): Promise<void> {
  let filePath: string;
  let content: string | undefined;
  let options: SkeletonOptions | undefined;
  try {
    const payload = validatedPayload<FilesSkeletonPayload>(msg, 'files.skeleton');
    filePath = payload.filePath;
    content = payload.content;
    options = payload.options;
  } catch {
    send(ws, {
      type: 'files.skeleton_result',
      payload: { filePath: '', skeleton: '', error: 'Malformed request' },
    });
    return;
  }

  let realResolved: string;
  try {
    realResolved = await resolveFileInsideProject(projectRoot, filePath);
  } catch {
    send(ws, {
      type: 'files.skeleton_result',
      payload: { filePath, skeleton: '', error: 'Forbidden' },
    });
    return;
  }

  try {
    const fileContent = content !== undefined ? content : await fs.readFile(realResolved, 'utf8');
    const result = await extractFileSkeleton({
      file: realResolved,
      content: fileContent,
      options: options ?? {},
    });
    send(ws, {
      type: 'files.skeleton_result',
      payload: {
        filePath,
        lang: result.lang,
        skeleton: result.skeleton,
        stats: result.stats,
      },
    });
  } catch (err) {
    send(ws, {
      type: 'files.skeleton_result',
      payload: { filePath, skeleton: '', error: errMessage(err) },
    });
  }
}

/**
 * Write file content back to disk (atomic write via tmp + rename).
 *
 * Guards against path traversal. Responds with
 * `{ type: 'files.written', payload: { filePath, success } }`.
 */
export async function handleFilesWrite(
  ws: WebSocket,
  msg: unknown,
  projectRoot: string,
  opts: FilesWriteOptions = {},
): Promise<void> {
  const sessionId = messageSessionId(msg as { payload?: unknown });
  let filePath: string;
  let content: string;
  try {
    ({ filePath, content } = validatedPayload<FilesWritePayload>(msg, 'files.write'));
  } catch {
    send(ws, {
      type: 'files.written',
      payload: withSessionEcho(
        { filePath: '', success: false, error: 'Malformed request' },
        sessionId,
      ),
    });
    return;
  }

  // Path traversal guard: resolve and verify both lexically AND via
  // realpath() that the parent directory stays inside the canonical
  // project root. A string-prefix check is not enough — an in-project
  // symlink to an external directory would let a write escape the
  // project root and clobber files elsewhere on disk.
  let realResolved: string;
  try {
    realResolved = await resolveFileInsideProject(projectRoot, filePath);
  } catch {
    send(ws, {
      type: 'files.written',
      payload: withSessionEcho({ filePath, success: false, error: 'Forbidden' }, sessionId),
    });
    return;
  }

  try {
    await atomicWrite(realResolved, content);
    send(ws, {
      type: 'files.written',
      payload: withSessionEcho({ filePath, success: true }, sessionId),
    });
    try {
      enqueueReindex({ projectRoot, files: [realResolved] });
    } catch {
      // Non-fatal background reindex
    }
    if (opts.onWritten) {
      void Promise.resolve(opts.onWritten(realResolved)).catch(() => undefined);
    }
  } catch (err) {
    send(ws, {
      type: 'files.written',
      payload: withSessionEcho({ filePath, success: false, error: errMessage(err) }, sessionId),
    });
  }
}

/**
 * Lightweight project file picker for the chat `@` mention popup.
 *
 * Walks `projectRoot` (max depth 8), skipping hidden and heavyweight
 * dirs, then fuzzy-ranks results against `query`. Responds with
 * `{ type: 'files.list', payload: { files } }`.
 */
export async function handleFilesList(
  ws: WebSocket,
  msg: unknown,
  projectRoot: string,
): Promise<void> {
  const payload = (msg as { payload?: FilesListPayload }).payload ?? {};
  const limit = payload.limit ?? 50;

  // Guard: the requested list root must be both lexically AND via
  // realpath() inside the project root. A symlinked subdirectory that
  // points outside the project would otherwise expose arbitrary
  // filenames to a connected client.
  let listRoot: string;
  let realProjectRoot: string;
  try {
    if (payload.path) {
      listRoot = await resolveWorkingDirInsideProject(projectRoot, payload.path);
    } else {
      listRoot = projectRoot;
    }
    realProjectRoot = await fs.realpath(projectRoot);
  } catch {
    send(ws, { type: 'files.list', payload: { files: [] } });
    return;
  }

  const results: string[] = [];

  async function walk(dir: string, rel: string, depth: number): Promise<void> {
    if (depth > 8 || results.length >= 600) return;
    let entries: import('node:fs').Dirent[] = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (results.length >= 600) return;
      if (isHiddenEntry(e.name)) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        // Reject symlinked directories whose real path escapes the
        // real project root. A symlink to an in-project directory is
        // fine and recursed into normally.
        let realChild: string;
        try {
          realChild = await fs.realpath(path.join(dir, e.name));
        } catch {
          continue;
        }
        if (!isPathInside(realProjectRoot, realChild)) {
          continue;
        }
        await walk(realChild, childRel, depth + 1);
      } else if (e.isFile()) {
        results.push(childRel);
      }
    }
  }

  await walk(listRoot, '', 0);
  send(ws, {
    type: 'files.list',
    payload: { files: rankFiles(results, payload.query ?? '', limit) },
  });
}

// ── files.create ──────────────────────────────────────────────────────

interface FilesCreatePayload {
  filePath: string;
  type: 'file' | 'directory';
}

/**
 * Create a new file or directory inside the project root.
 *
 * Guards against path traversal via `resolveFileInsideProject`. Rejects
 * if the target already exists. Responds with
 * `{ type: 'files.created', payload: { filePath, success } }`.
 */
export async function handleFilesCreate(
  ws: WebSocket,
  msg: unknown,
  projectRoot: string,
): Promise<void> {
  const sessionId = messageSessionId(msg as { payload?: unknown });
  let filePath: string;
  let entryType: 'file' | 'directory';
  try {
    const payload = validatedPayload<FilesCreatePayload>(msg, 'files.create');
    filePath = payload.filePath;
    entryType = payload.type;
    if (entryType !== 'file' && entryType !== 'directory') {
      send(ws, {
        type: 'files.created',
        payload: withSessionEcho(
          { filePath, success: false, error: 'Type must be "file" or "directory".' },
          sessionId,
        ),
      });
      return;
    }
  } catch {
    send(ws, {
      type: 'files.created',
      payload: withSessionEcho(
        { filePath: '', success: false, error: 'Malformed request' },
        sessionId,
      ),
    });
    return;
  }

  let realResolved: string;
  try {
    realResolved = await resolveFileInsideProject(projectRoot, filePath);
  } catch {
    send(ws, {
      type: 'files.created',
      payload: withSessionEcho({ filePath, success: false, error: 'Forbidden' }, sessionId),
    });
    return;
  }

  try {
    // Reject if the target already exists — the client should use
    // files.write to overwrite an existing file, not files.create.
    await fs.access(realResolved);
    send(ws, {
      type: 'files.created',
      payload: withSessionEcho(
        { filePath, success: false, error: 'File or directory already exists.' },
        sessionId,
      ),
    });
    return;
  } catch {
    // ENOENT is expected — the target doesn't exist yet.
  }

  try {
    if (entryType === 'directory') {
      // recursive: true is safe here — mkdir only creates missing
      // intermediate directories; existing ones are left untouched.
      await fs.mkdir(realResolved, { recursive: true });
    } else {
      // Create parent directories if needed, then the empty file.
      // Use flag 'wx' (exclusive create) so the atomic syscall
      // itself rejects if the file was created in the TOCTOU window
      // between our fs.access check above and the write here.
      await fs.mkdir(path.dirname(realResolved), { recursive: true });
      await fs.writeFile(realResolved, '', { encoding: 'utf8', flag: 'wx' });
    }
    send(ws, {
      type: 'files.created',
      payload: withSessionEcho({ filePath, success: true }, sessionId),
    });
  } catch (err) {
    send(ws, {
      type: 'files.created',
      payload: withSessionEcho({ filePath, success: false, error: errMessage(err) }, sessionId),
    });
  }
}

// ── files.delete ──────────────────────────────────────────────────────

interface FilesDeletePayload {
  filePath: string;
  recursive?: boolean;
}

/**
 * Delete a file or directory inside the project root.
 *
 * Guards against path traversal via `resolveFileInsideProject`. Directories
 * require `recursive: true` to delete non-empty contents. Responds with
 * `{ type: 'files.deleted', payload: { filePath, success } }`.
 */
export async function handleFilesDelete(
  ws: WebSocket,
  msg: unknown,
  projectRoot: string,
): Promise<void> {
  const sessionId = messageSessionId(msg as { payload?: unknown });
  let filePath: string;
  let recursive: boolean;
  try {
    const payload = validatedPayload<FilesDeletePayload>(msg, 'files.delete');
    filePath = payload.filePath;
    recursive = payload.recursive ?? false;
  } catch {
    send(ws, {
      type: 'files.deleted',
      payload: withSessionEcho(
        { filePath: '', success: false, error: 'Malformed request' },
        sessionId,
      ),
    });
    return;
  }

  // Reject deletion of the project root itself — a client could send
  // an empty path or "." which resolves to projectRoot. resolveFileInsideProject
  // returns the canonical projectRoot for those inputs.
  let realResolved: string;
  try {
    realResolved = await resolveFileInsideProject(projectRoot, filePath);
  } catch {
    send(ws, {
      type: 'files.deleted',
      payload: withSessionEcho({ filePath, success: false, error: 'Forbidden' }, sessionId),
    });
    return;
  }

  const realProjectRoot = await fs.realpath(projectRoot);
  if (realResolved === realProjectRoot) {
    send(ws, {
      type: 'files.deleted',
      payload: withSessionEcho(
        { filePath, success: false, error: 'Cannot delete the project root.' },
        sessionId,
      ),
    });
    return;
  }

  try {
    await fs.rm(realResolved, { recursive, force: false });
    send(ws, {
      type: 'files.deleted',
      payload: withSessionEcho({ filePath, success: true }, sessionId),
    });
  } catch (err) {
    send(ws, {
      type: 'files.deleted',
      payload: withSessionEcho({ filePath, success: false, error: errMessage(err) }, sessionId),
    });
  }
}

// ── files.rename ──────────────────────────────────────────────────────

interface FilesRenamePayload {
  oldPath: string;
  newPath: string;
}

/**
 * Rename or move a file/directory within the project root.
 *
 * Guards both source and destination via `resolveFileInsideProject`.
 * Rejects if the destination already exists or the source doesn't.
 * Responds with `{ type: 'files.renamed', payload: { oldPath, newPath, success } }`.
 */
export async function handleFilesRename(
  ws: WebSocket,
  msg: unknown,
  projectRoot: string,
): Promise<void> {
  const sessionId = messageSessionId(msg as { payload?: unknown });
  let oldPath: string;
  let newPath: string;
  try {
    const payload = validatedPayload<FilesRenamePayload>(msg, 'files.rename');
    oldPath = payload.oldPath;
    newPath = payload.newPath;
  } catch {
    send(ws, {
      type: 'files.renamed',
      payload: withSessionEcho(
        { oldPath: '', newPath: '', success: false, error: 'Malformed request' },
        sessionId,
      ),
    });
    return;
  }

  let realOld: string;
  let realNew: string;
  try {
    realOld = await resolveFileInsideProject(projectRoot, oldPath);
    realNew = await resolveFileInsideProject(projectRoot, newPath);
  } catch {
    send(ws, {
      type: 'files.renamed',
      payload: withSessionEcho({ oldPath, newPath, success: false, error: 'Forbidden' }, sessionId),
    });
    return;
  }

  // Reject renaming the project root itself.
  const realProjectRoot = await fs.realpath(projectRoot);
  if (realOld === realProjectRoot) {
    send(ws, {
      type: 'files.renamed',
      payload: withSessionEcho(
        { oldPath, newPath, success: false, error: 'Cannot rename the project root.' },
        sessionId,
      ),
    });
    return;
  }

  try {
    // Source must exist.
    await fs.access(realOld);
  } catch {
    send(ws, {
      type: 'files.renamed',
      payload: withSessionEcho(
        { oldPath, newPath, success: false, error: 'Source file does not exist.' },
        sessionId,
      ),
    });
    return;
  }

  try {
    // Destination must NOT exist — rename should not overwrite.
    await fs.access(realNew);
    send(ws, {
      type: 'files.renamed',
      payload: withSessionEcho(
        {
          oldPath,
          newPath,
          success: false,
          error: 'Destination already exists.',
        },
        sessionId,
      ),
    });
    return;
  } catch {
    // ENOENT expected — destination is free.
  }

  try {
    // Create parent dirs of the destination if needed (supports move semantics).
    await fs.mkdir(path.dirname(realNew), { recursive: true });
    await fs.rename(realOld, realNew);
    send(ws, {
      type: 'files.renamed',
      payload: withSessionEcho({ oldPath, newPath, success: true }, sessionId),
    });
  } catch (err) {
    send(ws, {
      type: 'files.renamed',
      payload: withSessionEcho(
        { oldPath, newPath, success: false, error: errMessage(err) },
        sessionId,
      ),
    });
  }
}

// ── files.move ────────────────────────────────────────────────────────

interface FilesMovePayload {
  srcPath: string;
  destDir: string;
}

/**
 * Move a file/directory into a destination directory within the project root.
 *
 * Guards both source and destination via `resolveFileInsideProject`.
 * The file keeps its basename — it is placed inside `destDir`.
 * Responds with `{ type: 'files.moved', payload: { srcPath, destPath, success } }`.
 */
export async function handleFilesMove(
  ws: WebSocket,
  msg: unknown,
  projectRoot: string,
): Promise<void> {
  const sessionId = messageSessionId(msg as { payload?: unknown });
  let srcPath: string;
  let destDir: string;
  try {
    const payload = validatedPayload<FilesMovePayload>(msg, 'files.move');
    srcPath = payload.srcPath;
    destDir = payload.destDir;
  } catch {
    send(ws, {
      type: 'files.moved',
      payload: withSessionEcho(
        { srcPath: '', destPath: '', success: false, error: 'Malformed request' },
        sessionId,
      ),
    });
    return;
  }

  let realSrc: string;
  let realDestDir: string;
  try {
    realSrc = await resolveFileInsideProject(projectRoot, srcPath);
    realDestDir = await resolveFileInsideProject(projectRoot, destDir);
  } catch {
    send(ws, {
      type: 'files.moved',
      payload: withSessionEcho(
        { srcPath, destPath: '', success: false, error: 'Forbidden' },
        sessionId,
      ),
    });
    return;
  }

  // Reject moving the project root.
  const realProjectRoot = await fs.realpath(projectRoot);
  if (realSrc === realProjectRoot) {
    send(ws, {
      type: 'files.moved',
      payload: withSessionEcho(
        { srcPath, destPath: '', success: false, error: 'Cannot move the project root.' },
        sessionId,
      ),
    });
    return;
  }

  // The destination must be an existing directory.
  try {
    const destStat = await fs.stat(realDestDir);
    if (!destStat.isDirectory()) {
      send(ws, {
        type: 'files.moved',
        payload: withSessionEcho(
          { srcPath, destPath: '', success: false, error: 'Destination is not a directory.' },
          sessionId,
        ),
      });
      return;
    }
  } catch {
    send(ws, {
      type: 'files.moved',
      payload: withSessionEcho(
        { srcPath, destPath: '', success: false, error: 'Destination directory does not exist.' },
        sessionId,
      ),
    });
    return;
  }

  // Source must exist.
  try {
    await fs.access(realSrc);
  } catch {
    send(ws, {
      type: 'files.moved',
      payload: withSessionEcho(
        { srcPath, destPath: '', success: false, error: 'Source file does not exist.' },
        sessionId,
      ),
    });
    return;
  }

  const baseName = path.basename(realSrc);
  const destPath = path.join(realDestDir, baseName);
  const relDestPath = destDir ? `${destDir}/${baseName}` : baseName;

  // Destination file must NOT already exist.
  try {
    await fs.access(destPath);
    send(ws, {
      type: 'files.moved',
      payload: withSessionEcho(
        {
          srcPath,
          destPath: relDestPath,
          success: false,
          error: 'A file with that name already exists in the destination directory.',
        },
        sessionId,
      ),
    });
    return;
  } catch {
    // ENOENT expected.
  }

  try {
    await fs.rename(realSrc, destPath);
    send(ws, {
      type: 'files.moved',
      payload: withSessionEcho({ srcPath, destPath: relDestPath, success: true }, sessionId),
    });
  } catch (err) {
    send(ws, {
      type: 'files.moved',
      payload: withSessionEcho(
        { srcPath, destPath: relDestPath, success: false, error: errMessage(err) },
        sessionId,
      ),
    });
  }
}
