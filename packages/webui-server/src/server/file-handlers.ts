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
import type { WebSocket } from 'ws';
import { ToolValidationError } from '@wrongstack/core/types';
import { atomicWrite } from '@wrongstack/core/utils';
import { SKIP_DIRS, isHiddenEntry, rankFiles } from './file-picker.js';
import { isPathInside, resolveWorkingDirInsideProject } from './path-containment.js';
import { send, errMessage } from './ws-utils.js';

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
async function resolveFileInsideProject(
  projectRoot: string,
  filePath: string,
): Promise<string> {
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

export interface FilesWriteOptions {
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
  }

  // Use the optional `path` from the message payload as the tree root.
  // When absent, empty, or ".", fall back to projectRoot (backward compatible).
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
      payload: { root: projectRoot, tree: [], error: 'Path outside project root' },
    });
    return;
  }

  // Compute the path prefix so tree paths are always relative to
  // projectRoot (not treeRoot). This ensures double-clicking a file in
  // the explorer sends the correct path to files.read/files.write.
  const pathPrefix = treeRoot === projectRoot
    ? ''
    : (path.relative(projectRoot, treeRoot) + '/').replace(/\\/g, '/');

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
    const nodes: TreeNode[] = [];
    for (const e of entries) {
      if (isHiddenEntry(e.name)) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const childAbs = path.join(dir, e.name);
      // Prepend the workingDir prefix so the path is projectRoot-relative
      const childPath = pathPrefix + childRel;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        // Reject symlinked directories whose real path escapes the
        // real project root. A symlink to an in-project directory is
        // fine and recursed into normally.
        let realChild: string;
        try {
          realChild = await fs.realpath(childAbs);
        } catch {
          continue;
        }
        if (!isPathInside(realProjectRoot, realChild)) {
          continue;
        }
        const children = await buildTree(realChild, childRel, depth + 1);
        nodes.push({ name: e.name, path: childPath, type: 'directory', children });
      } else if (e.isFile()) {
        nodes.push({ name: e.name, path: childPath, type: 'file' });
      }
    }
    return nodes;
  }

  try {
    const tree = await buildTree(treeRoot, '', 0);
    const rootLabel = treeRoot === projectRoot
      ? projectRoot
      : path.relative(projectRoot, treeRoot) || '.';
    send(ws, { type: 'files.tree', payload: { root: rootLabel, tree } });
  } catch (err) {
    const rootLabel = treeRoot === projectRoot
      ? projectRoot
      : path.relative(projectRoot, treeRoot) || '.';
    send(ws, {
      type: 'files.tree',
      payload: { root: rootLabel, tree: [], error: errMessage(err) },
    });
  }
}

/**
 * Read a file's content for the Monaco editor.
 *
 * Guards against path traversal (`../` escapes). Responds with
 * `{ type: 'files.read', payload: { filePath, content } }`.
 */
export async function handleFilesRead(
  ws: WebSocket,
  msg: unknown,
  projectRoot: string,
): Promise<void> {
  let filePath: string;
  try {
    ({ filePath } = validatedPayload<FilesReadPayload>(msg, 'files.read'));
  } catch {
    send(ws, { type: 'files.read', payload: { filePath: '', content: '', error: 'Malformed request' } });
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
    send(ws, { type: 'files.read', payload: { filePath, content: '', error: 'Forbidden' } });
    return;
  }

  try {
    const content = await fs.readFile(realResolved, 'utf8');
    send(ws, { type: 'files.read', payload: { filePath, content } });
  } catch (err) {
    send(ws, {
      type: 'files.read',
      payload: { filePath, content: '', error: errMessage(err) },
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
  let filePath: string;
  let content: string;
  try {
    ({ filePath, content } = validatedPayload<FilesWritePayload>(msg, 'files.write'));
  } catch {
    send(ws, { type: 'files.written', payload: { filePath: '', success: false, error: 'Malformed request' } });
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
    send(ws, { type: 'files.written', payload: { filePath, success: false, error: 'Forbidden' } });
    return;
  }

  try {
    await atomicWrite(realResolved, content);
    send(ws, { type: 'files.written', payload: { filePath, success: true } });
    if (opts.onWritten) {
      void Promise.resolve(opts.onWritten(realResolved)).catch(() => undefined);
    }
  } catch (err) {
    send(ws, {
      type: 'files.written',
      payload: { filePath, success: false, error: errMessage(err) },
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
