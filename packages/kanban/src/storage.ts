import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { requireSessionId } from '@wrongstack/primitives';
import { normalizeKanbanBoundaryPolicy } from './boundary.js';
import { STALE_WRITE_PREFIX, StaleWriteError } from './manager/lifecycle-error.js';
import { getProductionKanbanStorage } from './server/remote-storage.js';
import { getInstalledKanbanStorageBackend } from './storage-backend.js';
import { isInProcessTestMode } from './test-mode.js';
import type {
  KanbanBoard,
  KanbanBoardHistoryEntry,
  KanbanBoardKind,
  KanbanBoardMeta,
  KanbanBoardSummary,
  KanbanEvent,
} from './types.js';
import { CURRENT_KANBAN_VERSION, DEFAULT_COLUMNS } from './types-operations.js';
import { atomicWrite, withFileLock } from './utils/atomic-write.js';

const KANBANS_DIR = 'kanbans';
const BOARD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const testMetadata = new Map<string, string>();

function runtimeStorage(projectRoot: string) {
  const installed = getInstalledKanbanStorageBackend(projectRoot);
  if (installed) return installed;
  // Unit tests intentionally exercise the legacy file codec and locking
  // implementation in-process. Real IPC tests opt in explicitly.
  if (isInProcessTestMode()) {
    return undefined;
  }
  return getProductionKanbanStorage(projectRoot);
}

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
  return BOARD_ID_RE.test(boardId);
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

// On Windows, opening a board file while another process is mid-rename over it
// (atomicWrite's tmp→target replace) fails with EPERM/EBUSY even though the
// file is healthy. Readers are lockless by design, so tolerate that window
// with a short retry before surfacing the error.
const TRANSIENT_READ_CODES = new Set(['EPERM', 'EBUSY']);
const READ_RETRY_DELAYS_MS = [15, 40, 100, 250];

async function readFileWithRetry(filePath: string): Promise<string> {
  let attempt = 0;
  for (;;) {
    try {
      return await fs.readFile(filePath, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (
        process.platform !== 'win32' ||
        code === undefined ||
        !TRANSIENT_READ_CODES.has(code) ||
        attempt === READ_RETRY_DELAYS_MS.length
      ) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, READ_RETRY_DELAYS_MS[attempt]));
      attempt++;
    }
  }
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
  const backend = runtimeStorage(projectRoot);
  if (backend) return backend.listBoardIds();
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
  const backend = runtimeStorage(projectRoot);
  if (backend) return backend.readBoard(boardRef);
  const boardId = await resolveBoardRef(projectRoot, boardRef);
  if (!boardId) return null;
  try {
    const raw = await readFileWithRetry(getKanbanPath(projectRoot, boardId));
    return normalizeBoard(JSON.parse(raw) as KanbanBoard);
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

export async function writeBoard(projectRoot: string, board: KanbanBoard): Promise<void> {
  const backend = runtimeStorage(projectRoot);
  if (backend) return backend.writeBoard(board);
  const normalized = normalizeBoard(board);
  const filePath = getKanbanPath(projectRoot, normalized.id);
  await withFileLock(filePath, async () => {
    await writeBoardUnlocked(filePath, normalized);
  });
}

/**
 * Maximum number of event log entries before rotation is triggered.
 * After reaching this threshold, the oldest entries are pruned to
 * EVENT_LOG_TRIM_TO to prevent unbounded file growth.
 */
export const EVENT_LOG_MAX_ENTRIES = 10_000;

/**
 * Target entry count after a rotation trim. Keeps the most recent
 * entries so recent audit history is always available.
 */
export const EVENT_LOG_TRIM_TO = 5_000;

/**
 * Board size at which the subsystem starts complaining, in bytes of serialized
 * JSON.
 *
 * Nothing enforces it — a board over this size still reads and writes normally.
 * It exists because the next ceiling above it is silent and lossy: the HQ wire
 * codec rejects any single board record over 750 KB
 * (`MAX_HQ_KANBAN_BOARD_BYTES` in core), so a board that grows past it simply
 * stops appearing in HQ. This threshold sits below that one so a board announces
 * itself while there is still room to archive cards or compact a mirror.
 */
export const KANBAN_BOARD_SOFT_MAX_BYTES = 512 * 1024;

interface KanbanEventLogState {
  size: number;
  lineCount?: number;
}

const eventLogState = new Map<string, KanbanEventLogState>();

/**
 * Upper bound on how many distinct event-file cache entries the module-global
 * map retains. Long-lived CLI processes bound to multiple project roots would
 * otherwise accumulate one entry per (project, board) forever. Eviction runs
 * opportunistically inside `trimKanbanEventLog` and drops entries whose backing
 * events file no longer exists on disk.
 */
export const EVENT_LOG_MAX_CACHE_ENTRIES = 128;

/**
 * Record event-log state, keeping the cache bounded by least-recent use.
 *
 * This replaces an eviction pass that dropped only entries whose backing file
 * had been deleted. That could not achieve what it was written for: boards are
 * created roughly one per session and nothing removes them, so in the ordinary
 * case every cached file still exists, nothing was evictable, and the map grew
 * without limit anyway. Worse, the sweep ran on *every* event append once the
 * map passed the limit, and it `stat`ed every entry sequentially while the
 * cross-process file lock was held — measured at 14 ms for 256 cached boards,
 * 51 ms for 1024, evicting nothing each time.
 *
 * A `Map` iterates in insertion order, so re-inserting on write makes that order
 * a recency order and eviction becomes a bounded drop from the front. No
 * filesystem work at all, and the bound now actually holds. Dropping a live
 * entry is harmless: the next append for that board simply recomputes its line
 * count the same way a cold process would.
 */
/**
 * Test-only view of the event-log cache size, so the bound below can be
 * asserted directly. `index.ts` exports storage by explicit name, so this stays
 * out of the package's public API.
 */
export function eventLogCacheSizeForTests(): number {
  return eventLogState.size;
}

function rememberEventLogState(filePath: string, state: KanbanEventLogState): void {
  eventLogState.delete(filePath);
  eventLogState.set(filePath, state);
  while (eventLogState.size > EVENT_LOG_MAX_CACHE_ENTRIES) {
    const oldest = eventLogState.keys().next();
    if (oldest.done) break;
    eventLogState.delete(oldest.value);
  }
}

export async function appendKanbanEvent(
  projectRoot: string,
  boardId: string,
  event: KanbanEvent,
): Promise<void> {
  requireSessionId(event.sessionId, `kanban event ${event.type}`);
  const backend = runtimeStorage(projectRoot);
  if (backend) return backend.appendEvent(boardId, event);
  const filePath = getKanbanEventsPath(projectRoot, boardId);
  await withFileLock(filePath, async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const line = `${JSON.stringify(event)}\n`;
    // WS-035: board events carry task content; create owner-only (0600)
    // rather than inheriting the umask default of 0644.
    await fs.appendFile(filePath, line, { encoding: 'utf8', mode: 0o600 });
    // Trim the event log to prevent unbounded growth (best-effort).
    await trimKanbanEventLog(filePath, Buffer.byteLength(line));
  });
}

/**
 * Best-effort: read the events file, prune old entries if the count
 * exceeds EVENT_LOG_MAX_ENTRIES, and rewrite with only the most recent
 * EVENT_LOG_TRIM_TO entries. A failure here must never break event
 * recording — the catch handler ensures that.
 */
async function trimKanbanEventLog(filePath: string, appendedBytes: number): Promise<void> {
  try {
    const stat = await fs.stat(filePath);
    const cached = eventLogState.get(filePath);
    let lines: string[] | undefined;
    let lineCount: number | undefined;
    if (cached?.lineCount !== undefined && stat.size === cached.size + appendedBytes) {
      lineCount = cached.lineCount + 1;
    } else if (stat.size >= 512_000) {
      const raw = await fs.readFile(filePath, 'utf8');
      lines = raw.split(/\r?\n/).filter(Boolean);
      lineCount = lines.length;
    }

    if (lineCount === undefined || lineCount <= EVENT_LOG_MAX_ENTRIES) {
      rememberEventLogState(filePath, {
        size: stat.size,
        ...(lineCount !== undefined ? { lineCount } : {}),
      });
      return;
    }
    if (!lines) {
      const raw = await fs.readFile(filePath, 'utf8');
      lines = raw.split(/\r?\n/).filter(Boolean);
    }
    const trimmed = lines.slice(-EVENT_LOG_TRIM_TO);
    const body = `${trimmed.join('\n')}\n`;
    await atomicWrite(filePath, body, { encoding: 'utf8' });
    rememberEventLogState(filePath, {
      size: Buffer.byteLength(body),
      lineCount: trimmed.length,
    });
  } catch (error) {
    eventLogState.delete(filePath);
    // Best-effort only: log-space management must never interrupt event
    // recording. But a persistent failure here (disk full, permissions) means
    // the event log grows without bound and the operator gets zero signal —
    // so emit a namespaced warning (mirroring the WRONGSTACK_KANBAN_* code
    // convention from sqlite-storage.ts) rather than swallowing it silently.
    // The cache-entry delete above means the next append retries trimming from
    // scratch, so this fires once per failed trim, not once per append.
    const msg = error instanceof Error ? error.message : String(error);
    process.emitWarning(`Kanban event log trim failed for ${filePath}: ${msg}`, {
      code: 'WRONGSTACK_KANBAN_EVENT_LOG_TRIM_FAILED',
    });
  }
}

export async function readKanbanEvents(
  projectRoot: string,
  boardRef: string,
): Promise<KanbanEvent[]> {
  const backend = runtimeStorage(projectRoot);
  if (backend) return backend.readEvents(boardRef);
  const boardId = await resolveBoardRef(projectRoot, boardRef);
  if (!boardId) return [];
  try {
    const raw = await readFileWithRetry(getKanbanEventsPath(projectRoot, boardId));
    return raw
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as KanbanEvent);
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }
}

// ── Board history (global, survives board deletion) ───────────────────

/**
 * Path to the global board-history log. The leading `_` makes it an invalid
 * board id (BOARD_ID_RE requires an alphanumeric first char), so it never
 * collides with per-board files and is never picked up by `listBoardIds` or
 * the legacy migration pass.
 */
function getBoardHistoryPath(projectRoot: string): string {
  return path.join(getKanbanDir(projectRoot), '_board_history.jsonl');
}

export async function appendBoardHistory(
  projectRoot: string,
  entry: KanbanBoardHistoryEntry,
): Promise<void> {
  const backend = runtimeStorage(projectRoot);
  if (backend) return backend.appendBoardHistory(entry);
  const filePath = getBoardHistoryPath(projectRoot);
  await withFileLock(filePath, async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const line = `${JSON.stringify(entry)}\n`;
    await fs.appendFile(filePath, line, { encoding: 'utf8', mode: 0o600 });
    await trimKanbanEventLog(filePath, Buffer.byteLength(line));
  });
}

export async function readBoardHistory(
  projectRoot: string,
  boardId?: string,
): Promise<KanbanBoardHistoryEntry[]> {
  const backend = runtimeStorage(projectRoot);
  if (backend) return backend.readBoardHistory(boardId);
  try {
    const raw = await readFileWithRetry(getBoardHistoryPath(projectRoot));
    const entries = raw
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as KanbanBoardHistoryEntry);
    return boardId ? entries.filter((e) => e.boardId === boardId) : entries;
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }
}

export async function deleteBoard(projectRoot: string, boardRef: string): Promise<boolean> {
  const backend = runtimeStorage(projectRoot);
  if (backend) return backend.deleteBoard(boardRef);
  const boardId = await resolveBoardRef(projectRoot, boardRef);
  if (!boardId) return false;
  const filePath = getKanbanPath(projectRoot, boardId);
  return withFileLock(filePath, async () => {
    try {
      await fs.unlink(filePath);
      const eventsPath = getKanbanEventsPath(projectRoot, boardId);
      // Clear the cache entry unconditionally: the board file is already gone,
      // so even if the events-file unlink fails the cached state is stale.
      eventLogState.delete(eventsPath);
      try {
        await fs.unlink(eventsPath);
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

export async function readKanbanMetadata(projectRoot: string, key: string): Promise<string | null> {
  const backend = runtimeStorage(projectRoot);
  if (!backend) return testMetadata.get(`${projectRoot}\0${key}`) ?? null;
  return backend.readMetadata(key);
}

export async function writeKanbanMetadata(
  projectRoot: string,
  key: string,
  value: string,
): Promise<void> {
  const backend = runtimeStorage(projectRoot);
  if (!backend) {
    testMetadata.set(`${projectRoot}\0${key}`, value);
    return;
  }
  await backend.writeMetadata(key, value);
}

export async function mutateBoard<T>(
  projectRoot: string,
  boardRef: string,
  mutator: (board: KanbanBoard) => T | Promise<T>,
): Promise<{ board: KanbanBoard; result: T } | null> {
  const backend = runtimeStorage(projectRoot);
  if (backend) return backend.mutateBoard(boardRef, mutator);
  const boardId = await resolveBoardRef(projectRoot, boardRef);
  if (!boardId) return null;
  const filePath = getKanbanPath(projectRoot, boardId);
  return withFileLock(filePath, async () => {
    let board: KanbanBoard;
    try {
      const raw = await readFileWithRetry(filePath);
      board = normalizeBoard(JSON.parse(raw) as KanbanBoard);
    } catch (err) {
      if (isEnoent(err)) return null;
      throw err;
    }
    const readRevision = board.revision ?? 0;
    // Many high-frequency callers (notably the Kanban supervisor) use a
    // mutator that returns `null` when there is nothing to repair. Previously
    // even those no-op passes bumped the revision and rewrote the whole board.
    // Besides needless disk churn, each write wakes every directory watcher
    // and can create a self-sustaining render/lock workload in long-lived CLI
    // processes. Compare the canonical board payload so only real mutations
    // reach the filesystem; the mutator's result is still returned unchanged.
    // Fingerprint rather than retain: the serialized form is only ever used for
    // an equality test, but the "before" value has to survive `await mutator`.
    // Holding both full board strings kept two copies of the board alive for
    // the whole mutation and put both on the heap at once; the digest keeps the
    // same exact-equality semantics for 32 bytes, and each transient string is
    // collectable as soon as its hash is computed. Boards here run ~5-100KB, so
    // this bounds a per-mutation spike rather than removing a large leak.
    const beforeMutation = boardFingerprint(board);
    const result = await mutator(board);
    const afterMutation = boardFingerprint(board);
    // Stale-write detection: re-read the on-disk revision under the same file
    // lock to catch cross-process modifications since our initial read. If the
    // revision changed, another agent or process mutated the board while we
    // were computing, and our mutation is based on stale state. This check
    // runs for both no-op and mutating paths so a silent no-op cannot mask a
    // concurrent write that happened during the mutator's async execution.
    const currentRaw = await readFileWithRetry(filePath);
    const currentBoard = JSON.parse(currentRaw) as KanbanBoard;
    const currentRevision = currentBoard.revision ?? 0;
    if (currentRevision !== readRevision) {
      throw new StaleWriteError(
        `${STALE_WRITE_PREFIX} for board "${boardId}": on-disk revision ${currentRevision} ` +
          `does not match read revision ${readRevision}. The board was modified ` +
          'by another process since it was loaded. Rerun the operation.',
      );
    }
    if (afterMutation === beforeMutation) {
      // Genuine no-op: revision is still current but the mutator produced no
      // change. Skip the revision bump and the write entirely — every write
      // wakes directory watchers and creates churn for long-lived processes.
      return { board, result };
    }
    board.revision = (board.revision ?? 0) + 1;
    await writeBoardUnlocked(filePath, normalizeBoard(board));
    return { board, result };
  });
}

/**
 * Exact-equality fingerprint of a board's canonical JSON payload.
 *
 * Callers use this purely to decide whether a mutator actually changed
 * anything, so any collision-resistant digest of the same bytes `JSON.stringify`
 * would produce is equivalent to comparing the strings themselves — without
 * keeping those strings alive across the mutation.
 */
function boardFingerprint(board: KanbanBoard): string {
  return createHash('sha256').update(JSON.stringify(board)).digest('hex');
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
    ...(board.kind !== undefined ? { kind: board.kind } : {}),
    ...(board.retention !== undefined ? { retention: board.retention } : {}),
    ...(board.presence !== undefined
      ? { presence: board.presence.map((entry) => ({ ...entry })) }
      : {}),
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
    ...(summary.kind !== undefined ? { kind: summary.kind } : {}),
    ...(summary.retention !== undefined ? { retention: summary.retention } : {}),
    ...(summary.presence !== undefined
      ? { presence: summary.presence.map((entry) => ({ ...entry })) }
      : {}),
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
  lifecycle?: KanbanBoard['lifecycle'] | undefined;
  boundary?: KanbanBoard['boundary'] | undefined;
  atomicity?: KanbanBoard['atomicity'] | undefined;
  completionGate?: KanbanBoard['completionGate'] | undefined;
  kind?: KanbanBoard['kind'] | undefined;
  retention?: KanbanBoard['retention'] | undefined;
}

export function createBoardObject(opts: CreateBoardObjectOptions): KanbanBoard {
  const now = new Date().toISOString();
  const board: KanbanBoard = {
    id: randomUUID(),
    title: opts.title,
    columns: opts.columns?.length
      ? opts.columns.map((column, index) => ({ ...column, order: column.order ?? index }))
      : DEFAULT_COLUMNS.map((column) => ({ ...column })),
    tasks: [],
    createdAt: now,
    updatedAt: now,
    version: CURRENT_KANBAN_VERSION,
    revision: 0,
    ...(opts.description !== undefined ? { description: opts.description } : {}),
    ...(opts.tags !== undefined ? { tags: opts.tags } : {}),
    ...(opts.generatedBy !== undefined ? { generatedBy: opts.generatedBy } : {}),
    ...(opts.supervisor !== undefined ? { supervisor: { ...opts.supervisor } } : {}),
    ...(opts.lifecycle !== undefined
      ? { lifecycle: { ...opts.lifecycle, columns: { ...opts.lifecycle.columns } } }
      : {}),
    ...(opts.boundary !== undefined
      ? { boundary: normalizeKanbanBoundaryPolicy(opts.boundary) }
      : {}),
    ...(opts.atomicity !== undefined
      ? {
          atomicity: {
            ...opts.atomicity,
            ...(opts.atomicity.config ? { config: { ...opts.atomicity.config } } : {}),
          },
        }
      : {}),
    ...(opts.completionGate !== undefined ? { completionGate: { ...opts.completionGate } } : {}),
    ...(opts.kind !== undefined ? { kind: opts.kind } : {}),
    ...(opts.retention !== undefined ? { retention: { ...opts.retention } } : {}),
  };
  // Apply kind inference so the returned object always has a kind, even
  // before the board is read back from disk (where normalizeBoard runs).
  board.kind = normalizeBoardKind(board);
  return board;
}

export async function listBoardSummaries(projectRoot: string): Promise<KanbanBoardSummary[]> {
  const ids = await listBoardIds(projectRoot);
  const boards = await Promise.all(ids.map((id) => readBoard(projectRoot, id)));
  const summaries: KanbanBoardSummary[] = [];
  for (const board of boards) {
    if (board) summaries.push(summarizeBoard(board));
  }
  return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function normalizeBoard(board: KanbanBoard): KanbanBoard {
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
    revision: board.revision ?? 0,
    createdAt: board.createdAt ?? now,
    updatedAt: board.updatedAt ?? now,
    // Default kind to 'project' for legacy boards. Detect session mirrors from
    // tags so old boards created before kind existed are still classified.
    kind: normalizeBoardKind(board),
    columns,
    tasks,
    ...(board.contractGraph
      ? { contractGraph: normalizeContractGraph(board.contractGraph, now) }
      : {}),
  };
}

function normalizeContractGraph(
  graph: NonNullable<KanbanBoard['contractGraph']>,
  now: string,
): NonNullable<KanbanBoard['contractGraph']> {
  const enforcement = ['off', 'advisory', 'strict'].includes(graph.enforcement)
    ? graph.enforcement
    : 'advisory';
  return {
    version: 1,
    enforcement,
    nodes: (Array.isArray(graph.nodes) ? graph.nodes : []).map((node) => ({
      ...node,
      enforcement: node.enforcement ?? 'blocking',
      state: node.state ?? 'unknown',
      createdAt: node.createdAt ?? now,
      updatedAt: node.updatedAt ?? now,
      ...(node.waiver ? { waiver: { ...node.waiver } } : {}),
      ...(node.metadata ? { metadata: { ...node.metadata } } : {}),
    })),
    edges: (Array.isArray(graph.edges) ? graph.edges : []).map((edge) => ({
      ...edge,
      enforcement: edge.enforcement ?? 'informational',
      createdAt: edge.createdAt ?? now,
    })),
    updatedAt: graph.updatedAt ?? now,
  };
}

/**
 * Infer board kind from tags when the explicit `kind` field is absent.
 * Boards tagged `session-work` are classified as `session_mirror`.
 * Boards created by `createBoardFromTaskGraph` with `generatedBy` containing
 * `session-kanban:` are also classified as `session_mirror`.
 * Boards with `generatedBy` containing `sdd` are classified as `sdd_mirror`.
 * Everything else defaults to `project`.
 */
function normalizeBoardKind(board: KanbanBoard): KanbanBoardKind {
  if (board.kind) return board.kind;
  const tags = board.tags ?? [];
  const generatedBy = board.generatedBy ?? '';
  if (tags.includes('session-work') || tags.some((tag) => tag.startsWith('session:'))) {
    return 'session_mirror';
  }
  if (generatedBy.startsWith('session-kanban:')) {
    return 'session_mirror';
  }
  if (generatedBy.includes('sdd') || tags.includes('sdd')) {
    return 'sdd_mirror';
  }
  return 'project';
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
