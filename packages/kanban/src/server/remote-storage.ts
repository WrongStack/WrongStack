import { createHash } from 'node:crypto';
import * as path from 'node:path';

import { StaleWriteError } from '../manager/lifecycle-error.js';
import { getInstalledKanbanStorageBackend, type KanbanStorageBackend } from '../storage-backend.js';
import type { KanbanBoard, KanbanBoardHistoryEntry, KanbanEvent } from '../types.js';
import { getKanbanServerConnection } from './client.js';
import type { KanbanErrorCode, KanbanServerMethod, KanbanServerOperations } from './protocol.js';

class RemoteKanbanStorage implements KanbanStorageBackend {
  readonly kind = 'remote' as const;

  constructor(private readonly projectRoot: string) {}

  private async request<M extends KanbanServerMethod>(
    method: M,
    params: KanbanServerOperations[M]['args'],
  ): Promise<KanbanServerOperations[M]['result']> {
    const connection = await getKanbanServerConnection(this.projectRoot);
    if (!connection) {
      throw new Error(
        'Kanban project server is disabled; production storage has no direct-file fallback',
      );
    }
    return connection.request(method, params);
  }

  listBoardIds(): Promise<string[]> {
    return this.request('storageListBoardIds', {});
  }

  readBoard(boardRef: string): Promise<KanbanBoard | null> {
    return this.request('storageReadBoard', { boardRef });
  }

  async writeBoard(board: KanbanBoard, expectedRevision?: number): Promise<void> {
    await this.request('storageWriteBoard', {
      board,
      ...(expectedRevision !== undefined ? { expectedRevision } : {}),
    });
  }

  async appendEvent(boardId: string, event: KanbanEvent): Promise<void> {
    await this.request('storageAppendEvent', { boardId, event });
  }

  readEvents(boardRef: string): Promise<KanbanEvent[]> {
    return this.request('storageReadEvents', { boardRef });
  }

  deleteBoard(boardRef: string): Promise<boolean> {
    return this.request('storageDeleteBoard', { boardRef });
  }

  async appendBoardHistory(entry: KanbanBoardHistoryEntry): Promise<void> {
    await this.request('storageAppendBoardHistory', { entry });
  }

  readBoardHistory(boardId?: string): Promise<KanbanBoardHistoryEntry[]> {
    return this.request('storageReadBoardHistory', {
      ...(boardId !== undefined ? { boardId } : {}),
    });
  }

  readMetadata(key: string): Promise<string | null> {
    return this.request('storageReadMetadata', { key });
  }

  async writeMetadata(key: string, value: string): Promise<void> {
    await this.request('storageWriteMetadata', { key, value });
  }

  async mutateBoard<T>(
    boardRef: string,
    mutator: (board: KanbanBoard) => T | Promise<T>,
  ): Promise<{ board: KanbanBoard; result: T } | null> {
    const board = await this.readBoard(boardRef);
    if (!board) return null;
    const readRevision = board.revision ?? 0;
    const before = fingerprint(board);
    const result = await mutator(board);
    if (fingerprint(board) === before) return { board, result };
    board.revision = readRevision + 1;
    try {
      await this.writeBoard(board, readRevision);
    } catch (error) {
      // The writeBoard call crosses IPC, so StaleWriteError from the server
      // arrives here as a plain Error (the typed class is lost via JSON
      // serialization in client.ts's onData handler). The server's
      // errorFromThrown serialises StaleWriteError with code === 'STALE_WRITE'
      // and client.ts's onData attaches the code to the reconstructed Error.
      // Only wrap that case into a local StaleWriteError so callers (e.g.
      // claimReadyTask) can catch by type. All other IPC failures
      // (connection loss, timeout, server-down, disk-full) propagate
      // unchanged so the caller can distinguish real infrastructure
      // failures from benign stale-write contention.
      if (error instanceof Error && (error as { code?: KanbanErrorCode }).code === 'STALE_WRITE') {
        throw new StaleWriteError(error.message);
      }
      throw error;
    }
    return { board, result };
  }
}

const MAX_REMOTE_STORES = 8;
const remoteStores = new Map<string, RemoteKanbanStorage>();

function canonicalRoot(projectRoot: string): string {
  const resolved = path.resolve(projectRoot);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function fingerprint(board: KanbanBoard): string {
  return createHash('sha256').update(JSON.stringify(board)).digest('hex');
}

export function getProductionKanbanStorage(projectRoot: string): KanbanStorageBackend {
  const installed = getInstalledKanbanStorageBackend(projectRoot);
  if (installed) return installed;

  const key = canonicalRoot(projectRoot);
  let storage = remoteStores.get(key);
  if (storage) {
    remoteStores.delete(key);
    remoteStores.set(key, storage);
    return storage;
  }
  storage = new RemoteKanbanStorage(projectRoot);
  remoteStores.set(key, storage);
  while (remoteStores.size > MAX_REMOTE_STORES) {
    const oldest = remoteStores.keys().next().value;
    if (oldest === undefined) break;
    remoteStores.delete(oldest);
  }
  return storage;
}
