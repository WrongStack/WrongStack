import {
  createBoard,
  DEFAULT_COLUMNS,
  getBoard,
  type KanbanBoard,
  type KanbanColumn,
  listBoards,
  removeBoard,
  updateBoard,
} from '@wrongstack/kanban';

const SESSION_BOARD_TAG = 'session-work';
export const MIRROR_DISABLED_ENV = 'WRONGSTACK_KANBAN_TASK_MIRROR';

/**
 * Days after archiving before a session board is deleted outright.
 *
 * Unset by default: a session mirror archives after a week and then stays,
 * because the archive is the surviving record of what a session did. That is
 * also why archives accumulate with no ceiling — set this when you would
 * rather have the ceiling than the history. `0` or an unparseable value is
 * treated as unset.
 */
const PURGE_AFTER_ARCHIVE_DAYS_ENV = 'WRONGSTACK_KANBAN_ARCHIVE_PURGE_DAYS';

function sessionBoardRetention(): {
  mode: 'archive_after_ttl';
  ttlMs: number;
  purgeAfterArchiveMs?: number;
} {
  const raw = Number.parseFloat(process.env[PURGE_AFTER_ARCHIVE_DAYS_ENV] ?? '');
  const purgeDays = Number.isFinite(raw) && raw > 0 ? raw : undefined;
  return {
    mode: 'archive_after_ttl' as const,
    ttlMs: 7 * 24 * 60 * 60 * 1000,
    ...(purgeDays !== undefined
      ? { purgeAfterArchiveMs: Math.round(purgeDays * 24 * 60 * 60 * 1000) }
      : {}),
  };
}

export const SESSION_KANBAN_COLUMNS: KanbanColumn[] = DEFAULT_COLUMNS.map((column) => ({
  ...column,
}));

const boardQueue = new Map<string, Promise<void>>();
const boardEnsures = new Map<string, Promise<KanbanBoard>>();
const activeSessionBoards = new Map<string, number>();
const sessionCleanupListeners = new Set<(projectRoot: string, sessionId: string) => void>();

export function onSessionKanbanCleanedUp(
  listener: (projectRoot: string, sessionId: string) => void,
): void {
  sessionCleanupListeners.add(listener);
}

function notifySessionCleanedUp(projectRoot: string, sessionId: string): void {
  for (const listener of sessionCleanupListeners) {
    listener(projectRoot, sessionId);
  }
}

export function boardKey(projectRoot: string, sessionId: string): string {
  return `${projectRoot}\0${sessionId}`;
}

function sessionTag(sessionId: string): string {
  return `session:${sessionId}`;
}

function sessionBoardTitle(sessionId: string): string {
  const leaf = sessionId.split(/[\\/]/).filter(Boolean).pop() ?? sessionId;
  return `Session ${leaf.slice(0, 12)}`;
}

export function sessionBoardTags(sessionId: string): string[] {
  return ['session', SESSION_BOARD_TAG, sessionTag(sessionId)];
}

export function sessionIdFromTags(tags: readonly string[] | undefined): string | null {
  const tag = tags?.find((candidate) => candidate.startsWith('session:'));
  return tag?.slice('session:'.length) || null;
}

export function isOwnedSessionBoard(tags: readonly string[] | undefined): boolean {
  return Boolean(tags?.includes(SESSION_BOARD_TAG) && sessionIdFromTags(tags));
}

export function retainActiveSessionBoard(projectRoot: string, sessionId: string): void {
  const key = boardKey(projectRoot, sessionId);
  activeSessionBoards.set(key, (activeSessionBoards.get(key) ?? 0) + 1);
}

export function releaseActiveSessionBoard(projectRoot: string, sessionId: string): void {
  const key = boardKey(projectRoot, sessionId);
  const remaining = (activeSessionBoards.get(key) ?? 0) - 1;
  if (remaining > 0) activeSessionBoards.set(key, remaining);
  else activeSessionBoards.delete(key);
}

function isSessionBoardActive(projectRoot: string, sessionId: string): boolean {
  return (activeSessionBoards.get(boardKey(projectRoot, sessionId)) ?? 0) > 0;
}

function sameColumns(columns: readonly KanbanColumn[]): boolean {
  return (
    columns.length === SESSION_KANBAN_COLUMNS.length &&
    columns.every((column, index) => column.id === SESSION_KANBAN_COLUMNS[index]?.id)
  );
}

export async function ensureSessionKanbanBoard(
  projectRoot: string | undefined,
  sessionId: string,
): Promise<KanbanBoard | null> {
  if (!projectRoot || !sessionId || process.env[MIRROR_DISABLED_ENV] === '0') return null;
  const key = boardKey(projectRoot, sessionId);
  const inFlight = boardEnsures.get(key);
  if (inFlight) return inFlight;

  const promise = (async () => {
    const summary = (await listBoards(projectRoot)).find((board) =>
      board.tags?.includes(sessionTag(sessionId)),
    );
    let board = summary ? await getBoard(projectRoot, summary.id) : null;
    if (!board) {
      return createBoard(projectRoot, {
        title: sessionBoardTitle(sessionId),
        description: 'Live session work: todos, tasks, and plan items.',
        tags: sessionBoardTags(sessionId),
        columns: SESSION_KANBAN_COLUMNS,
        generatedBy: `session-kanban:${sessionId}`,
        kind: 'session_mirror' as const,
        retention: sessionBoardRetention(),
      });
    }

    if (!sameColumns(board.columns) || !board.tags?.includes(SESSION_BOARD_TAG)) {
      board =
        (await updateBoard(projectRoot, board.id, {
          title: sessionBoardTitle(sessionId),
          description: 'Live session work: todos, tasks, and plan items.',
          tags: [...new Set([...(board.tags ?? []), ...sessionBoardTags(sessionId)])],
          columns: SESSION_KANBAN_COLUMNS,
        })) ?? board;
    }
    return board;
  })();

  boardEnsures.set(key, promise);
  try {
    return await promise;
  } finally {
    boardEnsures.delete(key);
  }
}

export function enqueueBoardWork<T>(
  projectRoot: string,
  sessionId: string,
  work: () => Promise<T>,
): Promise<T> {
  const key = boardKey(projectRoot, sessionId);
  const previous = boardQueue.get(key) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(work);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  boardQueue.set(key, tail);
  void tail.then(() => {
    if (boardQueue.get(key) === tail) boardQueue.delete(key);
  });
  return result;
}

async function removeEmptySessionBoardDirect(
  projectRoot: string,
  boardId: string,
  sessionId: string,
): Promise<string | null> {
  if (isSessionBoardActive(projectRoot, sessionId)) return null;
  const board = await getBoard(projectRoot, boardId);
  if (!board || board.tasks.length > 0 || !isOwnedSessionBoard(board.tags)) return null;
  if (sessionIdFromTags(board.tags) !== sessionId) return null;
  return (await removeBoard(projectRoot, board.id)) ? board.id : null;
}

async function removeEmptySessionBoard(
  projectRoot: string,
  boardId: string,
  sessionId: string,
): Promise<string | null> {
  return enqueueBoardWork(projectRoot, sessionId, async () => {
    await boardEnsures.get(boardKey(projectRoot, sessionId))?.catch(() => null);
    return removeEmptySessionBoardDirect(projectRoot, boardId, sessionId);
  });
}

async function removeOwnedSessionBoardDirect(
  projectRoot: string,
  boardId: string,
  sessionId: string,
): Promise<string | null> {
  if (isSessionBoardActive(projectRoot, sessionId)) return null;
  const board = await getBoard(projectRoot, boardId);
  if (!board || !isOwnedSessionBoard(board.tags)) return null;
  if (sessionIdFromTags(board.tags) !== sessionId) return null;
  return (await removeBoard(projectRoot, board.id)) ? board.id : null;
}

export async function cleanupSessionKanbanBoard(
  projectRoot: string | undefined,
  sessionId: string,
): Promise<string[]> {
  if (!projectRoot || !sessionId || process.env[MIRROR_DISABLED_ENV] === '0') return [];
  if (isSessionBoardActive(projectRoot, sessionId)) return [];
  return enqueueBoardWork(projectRoot, sessionId, async () => {
    await boardEnsures.get(boardKey(projectRoot, sessionId))?.catch(() => null);
    if (isSessionBoardActive(projectRoot, sessionId)) return [];
    const candidates = (await listBoards(projectRoot)).filter(
      (board) => isOwnedSessionBoard(board.tags) && sessionIdFromTags(board.tags) === sessionId,
    );
    const removed = await Promise.all(
      candidates.map((board) => removeOwnedSessionBoardDirect(projectRoot, board.id, sessionId)),
    );
    const removedIds = removed.filter((boardId): boardId is string => Boolean(boardId));
    if (removedIds.length > 0) {
      notifySessionCleanedUp(projectRoot, sessionId);
    }
    return removedIds;
  });
}

export async function cleanupSessionKanbanBoardIfEmpty(
  projectRoot: string | undefined,
  sessionId: string,
): Promise<string[]> {
  if (!projectRoot || !sessionId || process.env[MIRROR_DISABLED_ENV] === '0') return [];
  if (isSessionBoardActive(projectRoot, sessionId)) return [];
  return enqueueBoardWork(projectRoot, sessionId, async () => {
    await boardEnsures.get(boardKey(projectRoot, sessionId))?.catch(() => null);
    if (isSessionBoardActive(projectRoot, sessionId)) return [];
    const candidates = (await listBoards(projectRoot)).filter(
      (board) =>
        board.taskCount === 0 &&
        isOwnedSessionBoard(board.tags) &&
        sessionIdFromTags(board.tags) === sessionId,
    );
    const removed = await Promise.all(
      candidates.map((board) => removeEmptySessionBoardDirect(projectRoot, board.id, sessionId)),
    );
    const removedIds = removed.filter((boardId): boardId is string => Boolean(boardId));
    if (removedIds.length > 0) {
      notifySessionCleanedUp(projectRoot, sessionId);
    }
    return removedIds;
  });
}

export async function cleanupEmptySessionKanbanBoards(
  projectRoot: string | undefined,
  activeSessionId = '',
): Promise<string[]> {
  if (!projectRoot || process.env[MIRROR_DISABLED_ENV] === '0') return [];
  const candidates = (await listBoards(projectRoot)).flatMap((board) => {
    const ownerSessionId = sessionIdFromTags(board.tags);
    return board.taskCount === 0 &&
      isOwnedSessionBoard(board.tags) &&
      ownerSessionId &&
      ownerSessionId !== activeSessionId &&
      !isSessionBoardActive(projectRoot, ownerSessionId)
      ? [{ boardId: board.id, sessionId: ownerSessionId }]
      : [];
  });
  const removed = await Promise.all(
    candidates.map(({ boardId, sessionId }) =>
      removeEmptySessionBoard(projectRoot, boardId, sessionId),
    ),
  );
  return removed.filter((boardId): boardId is string => Boolean(boardId));
}
