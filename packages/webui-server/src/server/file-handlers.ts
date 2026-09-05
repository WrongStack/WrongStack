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
import { atomicWrite } from '@wrongstack/core/utils';
import { enqueueReindex, extractFileSkeleton, type SkeletonOptions } from '@wrongstack/tools';
import { loadGitignoreMatcher } from '@wrongstack/tools/codebase-index';
import type { WebSocket } from 'ws';
import {
  isEntryDirectory,
  resolveFileInsideProject,
  validatedPayload,
  withSessionEcho,
} from './file-handler-helpers.js';
import { isHiddenEntry, rankFiles, SKIP_DIRS } from './file-picker.js';
import { isPathInside, resolveWorkingDirInsideProject } from './path-containment.js';
import { errMessage, messageSessionId, send } from './ws-utils.js';

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
    /** True when the project-root `.gitignore` matches this entry. */
    ignored?: boolean;
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

  // Load the project-root `.gitignore` once per request. A missing or
  // unreadable file returns a matcher that matches nothing, matching the
  // indexer's behaviour. Entries whose relative path is matched are
  // stamped `ignored: true` and pruned from the tree — the WebUI Bug
  // Hunter scope dropdown otherwise has to show dozens of build/cache
  // directories that the developer has already told git to ignore.
  const isGitignored = await loadGitignoreMatcher(projectRoot);

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
        // Project-root .gitignore (loaded once per request above). Skip the
        // entry entirely when it matches — keeping it would force every
        // downstream consumer (file explorer, picker, Bug Hunter scope list)
        // to re-derive the same rule. The path passed to the matcher is
        // projectRoot-relative; we pass `isEntryDirectory(e)` so a trailing-slash
        // rule like `dist/` prunes a directory by its own name, including
        // when it is a symlink to a directory (readdir reports
        // isDirectory() === false for symlinks, which would otherwise let a
        // `node_modules/` rule miss a symlinked node_modules).
        if (isGitignored(childRel, await isEntryDirectory(dir, e))) return null;
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

  // Same project-root `.gitignore` rule as the file tree — see
  // handleFilesTree above for the rationale.
  const isGitignored = await loadGitignoreMatcher(projectRoot);

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
      // Same projectRoot .gitignore rule — pass isEntryDirectory() so a
      // trailing-slash rule like `node_modules/` prunes a directory by its
      // own name, including when it is a symlink to a directory. See
      // handleFilesTree above for the full rationale.
      if (isGitignored(childRel, await isEntryDirectory(dir, e))) continue;
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

export {
  handleFilesCreate,
  handleFilesDelete,
  handleFilesMove,
  handleFilesRename,
} from './file-handler-mutations.js';
