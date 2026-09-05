import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { WebSocket } from 'ws';
import {
  resolveFileInsideProject,
  validatedPayload,
  withSessionEcho,
} from './file-handler-helpers.js';
import { errMessage, messageSessionId, send } from './ws-utils.js';

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
