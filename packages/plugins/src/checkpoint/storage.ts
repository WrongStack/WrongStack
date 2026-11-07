import { isUtf8 } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, realpath, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Snapshot } from './snapshot.js';

function inside(root: string, target: string): boolean {
  const normRoot = process.platform === 'win32' ? root.toLowerCase() : root;
  const normTarget = process.platform === 'win32' ? target.toLowerCase() : target;
  const path = relative(normRoot, normTarget);
  return (
    path !== '..' &&
    !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) &&
    !isAbsolute(path)
  );
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonicalPath(parent), basename(path));
  }
}

/** Existing ancestors are canonicalized too, including for a missing target file. */
export async function resolveProjectPath(raw: string, root: string): Promise<string | null> {
  if (typeof raw !== 'string' || !raw || raw.includes('\0')) return null;
  const resolvedRoot = resolve(root);
  const path = resolve(resolvedRoot, raw);
  if (!isAbsolute(raw) && !inside(resolvedRoot, path)) return null;
  const canonicalRoot = await canonicalPath(resolvedRoot);
  const canonical = await canonicalPath(path);
  return inside(canonicalRoot, canonical) ? canonical : null;
}

export async function captureFile(
  path: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Snapshot['files'][number] | 'too-large'> {
  signal.throwIfAborted();
  try {
    const file = await open(path, 'r');
    try {
      const info = await file.stat();
      if (!info.isFile()) throw new Error('Expected a regular file');
      if (info.size > maxBytes) return 'too-large';
      const bytes = Buffer.alloc(info.size + 1);
      let total = 0;
      while (total < bytes.length) {
        signal.throwIfAborted();
        const { bytesRead } = await file.read(bytes, total, bytes.length - total, total);
        if (!bytesRead) break;
        total += bytesRead;
      }
      signal.throwIfAborted();
      const after = await file.stat();
      if (
        total !== info.size ||
        after.size !== info.size ||
        after.mtimeMs !== info.mtimeMs ||
        after.ctimeMs !== info.ctimeMs
      ) {
        throw new Error('File changed during capture; retry with stable inputs');
      }
      const content = bytes.subarray(0, total);
      return isUtf8(content)
        ? { path, content: content.toString('utf8'), bytes: total, mode: info.mode & 0o777 }
        : {
            path,
            content: content.toString('base64'),
            encoding: 'base64',
            bytes: total,
            mode: info.mode & 0o777,
          };
    } finally {
      await file.close();
    }
  } catch (error) {
    signal.throwIfAborted();
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { path, content: null, bytes: 0 };
    throw new Error(
      `could not snapshot ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/** Per-file replacement leaves the original intact if preparation fails or is cancelled. */
export async function restoreFile(
  file: Snapshot['files'][number],
  root: string,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  if ((await resolveProjectPath(file.path, root)) !== file.path)
    throw new Error('Restore path moved outside the project or changed its target');
  if (file.content === null) return;
  await mkdir(dirname(file.path), { recursive: true });
  let existingMode: number | undefined;
  try {
    existingMode = (await stat(file.path)).mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const mode = file.mode ?? existingMode ?? 0o600;
  const temporary = join(dirname(file.path), `.checkpoint-${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', mode | 0o200);
  try {
    try {
      signal.throwIfAborted();
      await handle.writeFile(Buffer.from(file.content, file.encoding ?? 'utf8'), { signal });
    } finally {
      await handle.close();
    }
    await chmod(temporary, mode).catch(() => undefined);
    signal.throwIfAborted();
    if ((await resolveProjectPath(file.path, root)) !== file.path)
      throw new Error('Restore path changed during preparation');
    signal.throwIfAborted();
    let clearedReadOnly = false;
    if (
      process.platform === 'win32' &&
      existingMode !== undefined &&
      (existingMode & 0o200) === 0
    ) {
      clearedReadOnly = true;
      await chmod(file.path, 0o666).catch(() => undefined);
    }
    try {
      await rename(temporary, file.path);
    } catch (error) {
      if (clearedReadOnly && existingMode !== undefined) {
        await chmod(file.path, existingMode).catch(() => undefined);
      }
      throw error;
    }
    if (process.platform === 'win32') {
      await chmod(file.path, mode).catch(() => undefined);
    }
  } finally {
    if (process.platform === 'win32' && (mode & 0o200) === 0) {
      await chmod(temporary, 0o666).catch(() => undefined);
    }
    await rm(temporary, { force: true });
  }
}
