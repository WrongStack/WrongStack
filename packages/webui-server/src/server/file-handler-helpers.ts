import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ToolValidationError } from '@wrongstack/core/types';
import { isPathInside } from './path-containment.js';

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
export async function resolveFileInsideProject(
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
export async function canonicalizeFinalComponent(p: string): Promise<string> {
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

export function splitParentAndBase(p: string): { parent: string; base: string } {
  const base = path.basename(p);
  const parent = path.dirname(p);
  return { parent, base };
}

/**
 * True when a readdir entry is a directory, resolving symlinks. `Dirent.isDirectory()`
 * returns false for symlinks even when the link target is a directory; the
 * gitignore matcher's trailing-slash rules (e.g. `node_modules/`) prune a
 * directory by its own name and would otherwise miss a symlinked directory.
 */
export async function isEntryDirectory(dir: string, e: import('node:fs').Dirent): Promise<boolean> {
  if (e.isDirectory()) return true;
  if (!e.isSymbolicLink()) return false;
  try {
    const stat = await fs.stat(path.join(dir, e.name));
    return stat.isDirectory();
  } catch {
    return false;
  }
}

/**
 * `realpath` that does not throw when the path doesn't exist. Walks up
 * until an existing ancestor is found, realpaths that ancestor, then
 * re-attaches the missing tail. This is what we need for write targets
 * that don't exist yet, and for read targets whose parent may have
 * been deleted between check and use.
 */
export async function realpathAllowMissing(p: string): Promise<string> {
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

/** Guard: ensure msg is an object with a payload of the expected shape.
 *  Throws TypeError if the shape is wrong so callers catch it explicitly. */
export function validatedPayload<T>(msg: unknown, label: string): T {
  if (msg == null || typeof msg !== 'object') {
    throw new TypeError(`Expected object for ${label}, got ${msg}`);
  }
  const payload = (msg as { payload?: unknown }).payload;
  if (payload == null || typeof payload !== 'object') {
    throw new TypeError(`Expected payload object for ${label}, got ${payload}`);
  }
  return payload as T;
}

export function withSessionEcho<T extends Record<string, unknown>>(
  payload: T,
  sessionId: string | undefined,
): T & { sessionId?: string } {
  return sessionId ? { ...payload, sessionId } : payload;
}
