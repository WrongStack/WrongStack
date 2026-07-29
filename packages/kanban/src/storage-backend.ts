import * as path from 'node:path';

import type { KanbanBoard, KanbanEvent } from './types.js';

export interface KanbanStorageBackend {
  readonly kind: 'sqlite' | 'remote';
  listBoardIds(): Promise<string[]>;
  readBoard(boardRef: string): Promise<KanbanBoard | null>;
  writeBoard(board: KanbanBoard, expectedRevision?: number): Promise<void>;
  appendEvent(boardId: string, event: KanbanEvent): Promise<void>;
  readEvents(boardRef: string): Promise<KanbanEvent[]>;
  deleteBoard(boardRef: string): Promise<boolean>;
  readMetadata(key: string): Promise<string | null>;
  writeMetadata(key: string, value: string): Promise<void>;
  mutateBoard<T>(
    boardRef: string,
    mutator: (board: KanbanBoard) => T | Promise<T>,
  ): Promise<{ board: KanbanBoard; result: T } | null>;
}

const installedBackends = new Map<string, KanbanStorageBackend>();

function keyFor(projectRoot: string): string {
  const resolved = path.resolve(projectRoot);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Install the authoritative storage implementation for one project.
 *
 * Production installs this only inside the elected project-server process.
 * Tests may install an in-process backend explicitly.
 */
export function installKanbanStorageBackend(
  projectRoot: string,
  backend: KanbanStorageBackend,
): () => void {
  const key = keyFor(projectRoot);
  const existing = installedBackends.get(key);
  if (existing && existing !== backend) {
    throw new Error(`Kanban storage backend already installed for ${projectRoot}`);
  }
  installedBackends.set(key, backend);
  return () => {
    if (installedBackends.get(key) === backend) installedBackends.delete(key);
  };
}

export function getInstalledKanbanStorageBackend(
  projectRoot: string,
): KanbanStorageBackend | undefined {
  return installedBackends.get(keyFor(projectRoot));
}
