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

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { atomicWrite } from '@wrongstack/core/utils';
import { enqueueReindex, extractFileSkeleton, type SkeletonOptions } from '@wrongstack/tools';
import { loadGitignoreMatcher } from '@wrongstack/tools/codebase-index';
import type { WebSocket } from 'ws';
import {
  resolveFileInsideProject,
  validatedPayload,
  withSessionEcho,
} from './file-handler-helpers.js';
import { isHiddenEntry, rankFiles, SKIP_DIRS } from './file-picker.js';
import { isPathInside, resolveWorkingDirInsideProject } from './path-containment.js';
import { clampLimit } from './ws-payload-validation.js';
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
  /** When set, the write happens only if the file's current bytes still hash to this value. */
  expectedSha256?: string | undefined;
}

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const pathKey = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
const safeSessionId = (msg: unknown) =>
  messageSessionId(msg != null && typeof msg === 'object' ? (msg as { payload?: unknown }) : {});
/**
 * One in-flight write per resolved path inside this process, so a verify-then-rename
 * from one window cannot interleave with another window's save of the same file.
 */
const writeQueues = new Map<string, Promise<void>>();
async function serializedWrite<T>(target: string, fn: () => Promise<T>): Promise<T> {
  const key = pathKey(target);
  const run = (writeQueues.get(key) ?? Promise.resolve()).then(fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  writeQueues.set(key, tail);
  try {
    return await run;
  } finally {
    if (writeQueues.get(key) === tail) writeQueues.delete(key);
  }
}
async function currentSha256(target: string): Promise<string | null> {
  try {
    return sha256(await fs.readFile(target));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
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
  const sessionId = safeSessionId(msg);
  const rawPayload =
    msg != null && typeof msg === 'object' && !Array.isArray(msg)
      ? (msg as { payload?: unknown }).payload
      : undefined;
  if (
    rawPayload !== undefined &&
    (typeof rawPayload !== 'object' || rawPayload === null || Array.isArray(rawPayload))
  ) {
    send(ws, {
      type: 'files.tree',
      payload: withSessionEcho(
        { root: projectRoot, tree: [], error: 'Malformed request' },
        sessionId,
      ),
    });
    return;
  }
  const payload = (rawPayload ?? {}) as { path?: unknown; includeIgnored?: unknown };
  if (payload.path !== undefined && typeof payload.path !== 'string') {
    send(ws, {
      type: 'files.tree',
      payload: withSessionEcho(
        { root: projectRoot, tree: [], error: 'Malformed request' },
        sessionId,
      ),
    });
    return;
  }
  const rawPath = payload.path?.trim();
  const includeIgnored = payload.includeIgnored === true;

  // Guard: the requested tree root must be both lexically AND via
  // realpath() inside the project root. A symlinked subdirectory that
  // points outside the project would otherwise expose arbitrary
  // directory structure to a connected client.
  let treeRoot: string;
  let realTreeRoot: string;
  let realProjectRoot: string;
  try {
    if (rawPath && rawPath !== '.') {
      treeRoot = await resolveWorkingDirInsideProject(projectRoot, rawPath);
    } else {
      treeRoot = projectRoot;
    }
    realProjectRoot = await fs.realpath(projectRoot);
    realTreeRoot = await fs.realpath(treeRoot);
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
   * Walk one directory level concurrently (`Promise.all`) without `stat()`ing
   * regular directories (`realpath` guards containment; `size` is file-only).
   */
  async function buildTree(
    dir: string,
    rel: string,
    depth: number,
    ancestors: ReadonlySet<string>,
  ): Promise<TreeNode[]> {
    if (depth > 10) return [];
    let entries: import('node:fs').Dirent[] = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const nodes = await Promise.all(
      entries.map(async (e): Promise<TreeNode | null> => {
        if (isHiddenEntry(e.name)) return null;
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        const childAbs = path.join(dir, e.name);
        const childPath = pathPrefix + childRel;
        let realChild: string | undefined;
        let linkStat: import('node:fs').Stats | undefined;
        if (e.isSymbolicLink()) {
          try {
            realChild = await fs.realpath(childAbs);
            if (!isPathInside(realProjectRoot, realChild)) return null;
            linkStat = await fs.stat(realChild);
          } catch {
            return null;
          }
        }
        const isDir = linkStat ? linkStat.isDirectory() : e.isDirectory();
        const isFile = linkStat ? linkStat.isFile() : e.isFile();
        const ignored = isGitignored(childPath, isDir);
        if (ignored && !includeIgnored) return null;
        if (isDir) {
          if (SKIP_DIRS.has(e.name)) return null;
          const realDir = realChild ?? (await fs.realpath(childAbs).catch(() => null));
          if (!realDir || !isPathInside(realProjectRoot, realDir)) return null;
          const key = pathKey(realDir);
          if (ancestors.has(key)) return null;
          const nextAncestors = new Set(ancestors);
          nextAncestors.add(key);
          return {
            name: e.name,
            path: childPath,
            type: 'directory',
            ...(ignored ? { ignored: true } : {}),
            children: await buildTree(realDir, childRel, depth + 1, nextAncestors),
          };
        }
        if (!isFile) return null;
        const fileStat = linkStat ?? (await fs.stat(childAbs).catch(() => null));
        if (!fileStat) return null;
        return {
          name: e.name,
          path: childPath,
          type: 'file',
          size: fileStat.size,
          ...(ignored ? { ignored: true } : {}),
        };
      }),
    );
    return nodes
      .filter((n): n is TreeNode => n !== null)
      .sort((a, b) =>
        a.type !== b.type ? (a.type === 'directory' ? -1 : 1) : a.name.localeCompare(b.name),
      );
  }

  try {
    const tree = await buildTree(treeRoot, '', 0, new Set([pathKey(realTreeRoot)]));
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
  const sessionId = safeSessionId(msg);
  const rawRequestId = (msg as { payload?: { requestId?: unknown } })?.payload?.requestId;
  const requestId =
    typeof rawRequestId === 'string' && /^[\w:.-]{1,128}$/.test(rawRequestId)
      ? rawRequestId
      : undefined;
  const echo = (payload: Record<string, unknown>) =>
    withSessionEcho({ ...payload, ...(requestId ? { requestId } : {}) }, sessionId);
  let filePath: string;
  try {
    ({ filePath } = validatedPayload<FilesReadPayload>(msg, 'files.read'));
    if (typeof filePath !== 'string' || filePath.trim().length === 0) {
      throw new TypeError('Malformed files.read payload');
    }
  } catch {
    send(ws, {
      type: 'files.read',
      payload: echo({ filePath: '', content: '', error: 'Malformed request' }),
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
      payload: echo({ filePath, content: '', error: 'Forbidden' }),
    });
    return;
  }

  try {
    // stat first: an oversized file is never read into memory at all.
    const stat = await fs.stat(realResolved);
    if (stat.isDirectory()) {
      send(ws, {
        type: 'files.read',
        payload: echo({ filePath, content: '', error: 'Path is a directory' }),
      });
      return;
    }
    if (stat.size > MAX_READ_BYTES) {
      send(ws, {
        type: 'files.read',
        payload: echo({ filePath, content: '', tooLarge: true }),
      });
      return;
    }
    const buf = await fs.readFile(realResolved);
    if (buf.includes(0)) {
      send(ws, {
        type: 'files.read',
        payload: echo({ filePath, content: '', binary: true }),
      });
      return;
    }
    send(ws, {
      type: 'files.read',
      // The hash covers the raw bytes, so a later conditional write compares exactly
      // what is on disk rather than a decoded string.
      payload: echo({ filePath, content: buf.toString('utf8'), sha256: sha256(buf) }),
    });
  } catch (err) {
    send(ws, {
      type: 'files.read',
      payload: echo({ filePath, content: '', error: errMessage(err) }),
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
    if (
      typeof payload.filePath !== 'string' ||
      payload.filePath.trim().length === 0 ||
      (payload.content !== undefined && typeof payload.content !== 'string') ||
      (payload.options !== undefined &&
        (typeof payload.options !== 'object' ||
          payload.options === null ||
          Array.isArray(payload.options)))
    ) {
      throw new TypeError('Malformed files.skeleton payload');
    }
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
    if (content === undefined && (await fs.stat(realResolved)).isDirectory()) {
      send(ws, {
        type: 'files.skeleton_result',
        payload: { filePath, skeleton: '', error: 'Path is a directory' },
      });
      return;
    }
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
 * With `expectedSha256`, the current bytes are re-hashed immediately before the
 * rename inside a per-path queue: saves through this engine never overwrite each
 * other unseen. This is not an OS lock — another process writing in the instant
 * between that check and the rename can still be replaced.
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
  const sessionId = safeSessionId(msg);
  let filePath: string;
  let content: string;
  let expectedSha256: string | undefined;
  try {
    ({ filePath, content, expectedSha256 } = validatedPayload<FilesWritePayload>(
      msg,
      'files.write',
    ));
    if (
      typeof filePath !== 'string' ||
      typeof content !== 'string' ||
      (expectedSha256 !== undefined &&
        (typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedSha256)))
    )
      throw new TypeError('Malformed files.write payload');
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
    const conflict = await serializedWrite(realResolved, async () => {
      if (expectedSha256 !== undefined) {
        const current = await currentSha256(realResolved);
        if (current !== expectedSha256) return { currentSha256: current };
      }
      await atomicWrite(realResolved, content);
      return null;
    });
    if (conflict) {
      send(ws, {
        type: 'files.written',
        payload: withSessionEcho(
          {
            filePath,
            success: false,
            conflict: true,
            currentSha256: conflict.currentSha256,
            error:
              conflict.currentSha256 === null
                ? 'FILE_CONFLICT: The file was removed after it was read. Nothing was written.'
                : 'FILE_CONFLICT: The file changed on disk after it was read. Nothing was written.',
          },
          sessionId,
        ),
      });
      return;
    }
    send(ws, {
      type: 'files.written',
      payload: withSessionEcho(
        { filePath, success: true, sha256: sha256(Buffer.from(content, 'utf8')) },
        sessionId,
      ),
    });
    if (opts.onWritten) {
      // The host's indexing hook owns the reindex: it honours `indexing.onEdit`
      // and targets the configured index directory. Enqueueing here as well
      // queued a second run against the DEFAULT index directory — a stray
      // index for a custom `codebaseIndexDir`, and a duplicate run otherwise.
      void Promise.resolve(opts.onWritten(realResolved)).catch(() => undefined);
    } else {
      try {
        enqueueReindex({ projectRoot, files: [realResolved] });
      } catch {
        // Non-fatal background reindex
      }
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
  const rawPayload =
    msg != null && typeof msg === 'object' && !Array.isArray(msg)
      ? (msg as { payload?: unknown }).payload
      : undefined;
  if (
    rawPayload !== undefined &&
    (typeof rawPayload !== 'object' || rawPayload === null || Array.isArray(rawPayload))
  ) {
    send(ws, { type: 'files.list', payload: { files: [] } });
    return;
  }
  const payload = (rawPayload ?? {}) as FilesListPayload;
  if (
    (payload.path !== undefined && typeof payload.path !== 'string') ||
    (payload.query !== undefined && typeof payload.query !== 'string')
  ) {
    send(ws, { type: 'files.list', payload: { files: [] } });
    return;
  }
  const limit = clampLimit(payload.limit, 50, 600);

  let listRoot: string;
  let realListRoot: string;
  let realProjectRoot: string;
  try {
    const rawPath = payload.path?.trim();
    if (rawPath && rawPath !== '.') {
      listRoot = await resolveWorkingDirInsideProject(projectRoot, rawPath);
    } else {
      listRoot = projectRoot;
    }
    realProjectRoot = await fs.realpath(projectRoot);
    realListRoot = await fs.realpath(listRoot);
  } catch {
    send(ws, { type: 'files.list', payload: { files: [] } });
    return;
  }

  const pathPrefix =
    listRoot === projectRoot
      ? ''
      : (path.relative(projectRoot, listRoot) + '/').replace(/\\/g, '/');

  const results: string[] = [];
  const isGitignored = await loadGitignoreMatcher(projectRoot);

  async function walk(
    dir: string,
    rel: string,
    depth: number,
    ancestors: ReadonlySet<string>,
  ): Promise<void> {
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
      const childAbs = path.join(dir, e.name);
      const childPath = pathPrefix + childRel;
      let realChild: string | undefined;
      let linkStat: import('node:fs').Stats | undefined;
      if (e.isSymbolicLink()) {
        try {
          realChild = await fs.realpath(childAbs);
          if (!isPathInside(realProjectRoot, realChild)) continue;
          linkStat = await fs.stat(realChild);
        } catch {
          continue;
        }
      }
      const isDir = linkStat ? linkStat.isDirectory() : e.isDirectory();
      const isFile = linkStat ? linkStat.isFile() : e.isFile();
      if (isGitignored(childPath, isDir)) continue;
      if (isDir) {
        if (SKIP_DIRS.has(e.name)) continue;
        const realDir = realChild ?? (await fs.realpath(childAbs).catch(() => null));
        if (!realDir || !isPathInside(realProjectRoot, realDir)) continue;
        const key = pathKey(realDir);
        if (ancestors.has(key)) continue;
        const nextAncestors = new Set(ancestors);
        nextAncestors.add(key);
        await walk(realDir, childRel, depth + 1, nextAncestors);
      } else if (isFile) {
        results.push(childPath);
      }
    }
  }

  await walk(listRoot, '', 0, new Set([pathKey(realListRoot)]));
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
