import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { atomicWrite, withFileLock } from './utils/atomic-write.js';
import {
  CURRENT_KANBAN_VERSION,
  DEFAULT_COLUMNS,
  type KanbanBoard,
  type KanbanBoardMeta,
  type KanbanBoardSummary,
  type KanbanEvent,
} from './types.js';

const KANBANS_DIR = 'kanbans';
const BOARD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function getKanbanDir(projectRoot: string): string {
  return path.join(projectRoot, '.wrongstack', KANBANS_DIR);
}

export function getKanbanPath(projectRoot: string, boardId: string): string {
  assertValidBoardId(boardId);
  const dir = path.resolve(getKanbanDir(projectRoot));
  const resolved = path.resolve(dir, `${boardId}.json`);
  const rel = path.relative(dir, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw invalidBoardId(boardId);
  }
  return resolved;
}

export function getKanbanEventsPath(projectRoot: string, boardId: string): string {
  assertValidBoardId(boardId);
  const dir = path.resolve(getKanbanDir(projectRoot));
  const resolved = path.resolve(dir, `${boardId}.events.jsonl`);
  const rel = path.relative(dir, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw invalidBoardId(boardId);
  }
  return resolved;
}

export function isValidBoardId(boardId: string): boolean {
  return BOARD_ID_RE.test(boardId) && !boardId.includes('..');
}

export function assertValidBoardId(boardId: string): void {
  if (!isValidBoardId(boardId)) throw invalidBoardId(boardId);
}

function invalidBoardId(boardId: string): Error {
  return new Error(`Invalid kanban board id: ${boardId}`);
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch (err) {
    if (isEnoent(err)) return false;
    throw err;
  }
}

export async function listBoardIds(projectRoot: string): Promise<string[]> {
  const dir = getKanbanDir(projectRoot);
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name.slice(0, -5))
      .filter(isValidBoardId)
      .sort();
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }
}

/**
 * Resolve either a full board id or a unique id prefix.
 */
export async function resolveBoardRef(
  projectRoot: string,
  boardRef: string,
): Promise<string | null> {
  assertValidBoardId(boardRef);
  if (await pathExists(getKanbanPath(projectRoot, boardRef))) return boardRef;

  const matches = (await listBoardIds(projectRoot)).filter((id) => id.startsWith(boardRef));
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new Error(`Ambiguous kanban board id "${boardRef}": ${matches.slice(0, 5).join(', ')}`);
  }
  return matches[0] ?? null;
}

export async function readBoard(
  projectRoot: string,
  boardRef: string,
): Promise<KanbanBoard | null> {
  const boardId = await resolveBoardRef(projectRoot, boardRef);
  if (!boardId) return null;
  try {
    const raw = await fs.readFile(getKanbanPath(projectRoot, boardId), 'utf8');
    return normalizeBoard(JSON.parse(raw) as KanbanBoard);
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

export async function writeBoard(projectRoot: string, board: KanbanBoard): Promise<void> {
  const normalized = normalizeBoard(board);
  const filePath = getKanbanPath(projectRoot, normalized.id);
  await withFileLock(filePath, async () => {
    await writeBoardUnlocked(filePath, normalized);
  });
}

export async function appendKanbanEvent(
  projectRoot: string,
  boardId: string,
  event: KanbanEvent,
): Promise<void> {
  const filePath = getKanbanEventsPath(projectRoot, boardId);
  await withFileLock(filePath, async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.appendFile(filePath, `${JSON.stringify(event)}\n`, 'utf8');
  });
}

export async function readKanbanEvents(
  projectRoot: string,
  boardRef: string,
): Promise<KanbanEvent[]> {
  const boardId = await resolveBoardRef(projectRoot, boardRef);
  if (!boardId) return [];
  try {
    const raw = await fs.readFile(getKanbanEventsPath(projectRoot, boardId), 'utf8');
    return raw
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as KanbanEvent);
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }
}

export async function deleteBoard(projectRoot: string, boardRef: string): Promise<boolean> {
  const boardId = await resolveBoardRef(projectRoot, boardRef);
  if (!boardId) return false;
  const filePath = getKanbanPath(projectRoot, boardId);
  return withFileLock(filePath, async () => {
    try {
      await fs.unlink(filePath);
      try {
        await fs.unlink(getKanbanEventsPath(projectRoot, boardId));
      } catch (eventsErr) {
        if (!isEnoent(eventsErr)) throw eventsErr;
      }
      return true;
    } catch (err) {
      if (isEnoent(err)) return false;
      throw err;
    }
  });
}

export async function mutateBoard<T>(
  projectRoot: string,
  boardRef: string,
  mutator: (board: KanbanBoard) => T | Promise<T>,
): Promise<{ board: KanbanBoard; result: T } | null> {
  const boardId = await resolveBoardRef(projectRoot, boardRef);
  if (!boardId) return null;
  const filePath = getKanbanPath(projectRoot, boardId);
  return withFileLock(filePath, async () => {
    let board: KanbanBoard;
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      board = normalizeBoard(JSON.parse(raw) as KanbanBoard);
    } catch (err) {
      if (isEnoent(err)) return null;
      throw err;
    }
    const result = await mutator(board);
    await writeBoardUnlocked(filePath, normalizeBoard(board));
    return { board, result };
  });
}

export function summarizeBoard(board: KanbanBoard): KanbanBoardSummary {
  const total = board.tasks.length;
  const completed = board.tasks.filter((task) => task.status === 'completed').length;
  const lastActivity = latestActivity(board);
  return {
    id: board.id,
    title: board.title,
    createdAt: board.createdAt,
    updatedAt: board.updatedAt,
    columnCount: board.columns.length,
    taskCount: total,
    completedTaskCount: completed,
    ...(board.description !== undefined ? { description: board.description } : {}),
    ...(board.tags !== undefined ? { tags: board.tags } : {}),
    ...(lastActivity !== undefined ? { lastActivity } : {}),
  };
}

export function boardMeta(board: KanbanBoard): KanbanBoardMeta {
  const summary = summarizeBoard(board);
  return {
    id: summary.id,
    title: summary.title,
    columnCount: summary.columnCount,
    taskCount: summary.taskCount,
    completedTaskCount: summary.completedTaskCount,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    ...(summary.description !== undefined ? { description: summary.description } : {}),
    ...(summary.tags !== undefined ? { tags: summary.tags } : {}),
    ...(summary.lastActivity !== undefined ? { lastActivity: summary.lastActivity } : {}),
  };
}

export interface CreateBoardObjectOptions {
  title: string;
  description?: string | undefined;
  tags?: string[] | undefined;
  columns?: KanbanBoard['columns'] | undefined;
  generatedBy?: string | undefined;
  supervisor?: KanbanBoard['supervisor'] | undefined;
}

export function createBoardObject(opts: CreateBoardObjectOptions): KanbanBoard {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    title: opts.title,
    columns: opts.columns?.length
      ? opts.columns.map((column, index) => ({ ...column, order: column.order ?? index }))
      : DEFAULT_COLUMNS.map((column) => ({ ...column })),
    tasks: [],
    createdAt: now,
    updatedAt: now,
    version: CURRENT_KANBAN_VERSION,
    ...(opts.description !== undefined ? { description: opts.description } : {}),
    ...(opts.tags !== undefined ? { tags: opts.tags } : {}),
    ...(opts.generatedBy !== undefined ? { generatedBy: opts.generatedBy } : {}),
    ...(opts.supervisor !== undefined ? { supervisor: { ...opts.supervisor } } : {}),
  };
}

export async function listBoardSummaries(projectRoot: string): Promise<KanbanBoardSummary[]> {
  const summaries: KanbanBoardSummary[] = [];
  for (const id of await listBoardIds(projectRoot)) {
    const board = await readBoard(projectRoot, id);
    if (board) summaries.push(summarizeBoard(board));
  }
  return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function normalizeBoard(board: KanbanBoard): KanbanBoard {
  const now = new Date().toISOString();
  const columns = [...(board.columns?.length ? board.columns : DEFAULT_COLUMNS)]
    .map((column, index) => ({
      ...column,
      order: column.order ?? index,
    }))
    .sort((a, b) => a.order - b.order)
    .map((column, index) => ({ ...column, order: index }));
  const columnIds = new Set(columns.map((column) => column.id));
  const fallbackColumnId = columns[0]?.id ?? 'backlog';
  const tasks = normalizeTaskOrders(
    (board.tasks ?? []).map((task, index) => ({
      ...task,
      columnId: columnIds.has(task.columnId) ? task.columnId : fallbackColumnId,
      order: task.order ?? index,
      priority: task.priority ?? 'medium',
      status: task.status ?? 'pending',
      createdAt: task.createdAt ?? now,
      updatedAt: task.updatedAt ?? now,
    })),
  );
  return {
    ...board,
    version: board.version ?? CURRENT_KANBAN_VERSION,
    createdAt: board.createdAt ?? now,
    updatedAt: board.updatedAt ?? now,
    columns,
    tasks,
  };
}

function latestActivity(board: KanbanBoard): string | undefined {
  return [board.updatedAt, ...board.tasks.map((task) => task.updatedAt)]
    .filter(Boolean)
    .sort()
    .reverse()[0];
}

async function writeBoardUnlocked(filePath: string, board: KanbanBoard): Promise<void> {
  await atomicWrite(filePath, `${JSON.stringify(board, null, 2)}\n`, { encoding: 'utf8' });
}

function normalizeTaskOrders(tasks: KanbanBoard['tasks']): KanbanBoard['tasks'] {
  const byColumn = new Map<string, KanbanBoard['tasks']>();
  for (const task of tasks) {
    const columnTasks = byColumn.get(task.columnId) ?? [];
    columnTasks.push(task);
    byColumn.set(task.columnId, columnTasks);
  }
  for (const columnTasks of byColumn.values()) {
    columnTasks
      .sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt))
      .forEach((task, index) => {
        task.order = index;
      });
  }
  return tasks;
}
