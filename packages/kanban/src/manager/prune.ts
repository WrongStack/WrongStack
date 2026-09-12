import { deleteBoard, listBoardSummaries, mutateBoard, readBoard, writeBoard } from '../storage.js';

/**
 * Cards kept on a live session mirror once they reach a terminal state.
 *
 * A session board is written in full on every mutation, so its card count is
 * a direct cost on every todo update — an hours-long session that cycles
 * through many todo lists accumulates archived and completed cards forever
 * and each update gets slower. Terminal cards past this window carry no
 * remaining decision value: the durable record lives in the session journal.
 */
export const SESSION_MIRROR_TERMINAL_TASK_LIMIT = 200;

export interface CompactSessionMirrorResult {
  removedTaskIds: string[];
  remainingTaskCount: number;
}

/**
 * Bound the card count of a live session mirror board.
 *
 * Drops the oldest terminal (archived / completed) cards beyond
 * `limit`, keeping every card that still carries open work. Only boards of
 * kind `session_mirror` are touched — a project or managed board is a durable
 * record and is never compacted. Cards referenced as a dependency of a
 * retained card are also kept, so readiness stays computable.
 */
export async function compactSessionMirrorBoard(
  projectRoot: string,
  boardId: string,
  options: { limit?: number | undefined } = {},
): Promise<CompactSessionMirrorResult | null> {
  const limit = options.limit ?? SESSION_MIRROR_TERMINAL_TASK_LIMIT;
  const removedTaskIds: string[] = [];
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    if ((board.kind ?? 'project') !== 'session_mirror') return null;
    if (board.lifecycle?.mode === 'managed') return null;

    const isTerminal = (status: string): boolean => status === 'archived' || status === 'completed';
    const terminal = board.tasks.filter((task) => isTerminal(task.status));
    if (terminal.length <= limit) return null;

    // Never drop a card another retained card still points at: readiness and
    // the dependency graph must stay resolvable after compaction.
    const retainedDependencies = new Set(
      board.tasks
        .filter((task) => !isTerminal(task.status))
        .flatMap((task) => task.dependsOn ?? []),
    );
    const droppable = terminal
      .filter((task) => !retainedDependencies.has(task.id))
      .sort(
        (left, right) =>
          left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id),
      );
    const dropCount = Math.min(droppable.length, terminal.length - limit);
    if (dropCount <= 0) return null;

    const dropped = new Set(droppable.slice(0, dropCount).map((task) => task.id));
    board.tasks = board.tasks.filter((task) => !dropped.has(task.id));
    for (const task of board.tasks) {
      if (task.dependsOn?.length) {
        task.dependsOn = task.dependsOn.filter((id) => !dropped.has(id));
        if (task.dependsOn.length === 0) delete task.dependsOn;
      }
      if (task.childTaskIds?.length) {
        task.childTaskIds = task.childTaskIds.filter((id) => !dropped.has(id));
        if (task.childTaskIds.length === 0) delete task.childTaskIds;
      }
      if (task.parentTaskId && dropped.has(task.parentTaskId)) {
        delete task.parentTaskId;
      }
      if (task.mergedIntoTaskId && dropped.has(task.mergedIntoTaskId)) {
        delete task.mergedIntoTaskId;
      }
      if (task.mergedFromTaskIds?.length) {
        task.mergedFromTaskIds = task.mergedFromTaskIds.filter((id) => !dropped.has(id));
        if (task.mergedFromTaskIds.length === 0) delete task.mergedFromTaskIds;
      }
      if (task.chain?.previousTaskId && dropped.has(task.chain.previousTaskId)) {
        delete task.chain.previousTaskId;
      }
      if (task.chain?.nextTaskId && dropped.has(task.chain.nextTaskId)) {
        delete task.chain.nextTaskId;
      }
    }
    removedTaskIds.push(...dropped);
    return removedTaskIds.length;
  });
  if (!updated) return null;
  return { removedTaskIds, remainingTaskCount: updated.board.tasks.length };
}

/**
 * Result of a prune operation.
 */
export interface PruneSessionBoardsResult {
  archived: string[];
  deleted: string[];
  skipped: string[];
  /**
   * Boards sitting in the terminal `archive` state. Reported so the count is
   * visible to a caller (and to `/kanban`) rather than growing silently —
   * these are only removed when a board opts in with `purgeAfterArchiveMs`.
   */
  archivedRetained: string[];
}

/**
 * Prune session mirror boards whose retention TTL has elapsed.
 *
 * Boards with `kind: 'session_mirror'` and a retention policy of
 * `archive_after_ttl` or `delete_after_ttl` are evaluated. If the TTL
 * has elapsed since `updatedAt`, the board is either:
 * - `archive_after_ttl`: board `kind` changed to `'archive'` and
 *   `retention.archivedAt` stamped. The board is hidden from default
 *   queries by the board-kind filter.
 * - `delete_after_ttl`: board permanently deleted via `deleteBoard`.
 *
 * Boards with `retention.mode: 'keep'` or no TTL set are always skipped.
 * Non-session boards are never touched.
 *
 * ## The second stage
 *
 * Archiving used to be terminal. A board that archived became
 * `kind: 'archive'`, which failed the `session_mirror` guard below, and it
 * also carried `retention.archivedAt`, which failed the "already archived"
 * guard — so nothing ever looked at it again. Archives accumulated with no
 * ceiling, and a board configured `delete_after_ttl` could never actually be
 * deleted once it had archived first.
 *
 * `retention.purgeAfterArchiveMs` is the missing second hop: when set, an
 * archived board is deleted that long after `archivedAt`. It is deliberately
 * opt-in with no default — an archive exists so history survives, and turning
 * on silent deletion of the user's task history is their call, not ours.
 * Without it the behaviour is exactly as before, except the retained archives
 * are now counted in the result instead of being invisible.
 */
export async function pruneSessionBoards(
  projectRoot: string,
  options: { now?: string } = {},
): Promise<PruneSessionBoardsResult> {
  const now = options.now ?? new Date().toISOString();
  const nowMs = Date.parse(now);
  const summaries = await listBoardSummaries(projectRoot);

  const result: PruneSessionBoardsResult = {
    archived: [],
    deleted: [],
    skipped: [],
    archivedRetained: [],
  };

  for (const summary of summaries) {
    const kind = summary.kind ?? 'project';

    // Second stage: an already-archived board. Handled before the
    // `session_mirror` guard below, because archiving rewrites `kind` to
    // 'archive' — checking the guard first is what made this state terminal.
    if (kind === 'archive') {
      const archived = summary.retention;
      if (!archived?.archivedAt || !archived.purgeAfterArchiveMs) {
        // No purge opted in: keep it, but say so.
        if (archived?.archivedAt) result.archivedRetained.push(summary.id);
        else result.skipped.push(summary.id);
        continue;
      }
      if (nowMs - Date.parse(archived.archivedAt) < archived.purgeAfterArchiveMs) {
        result.archivedRetained.push(summary.id);
        continue;
      }
      await deleteBoard(projectRoot, summary.id);
      result.deleted.push(summary.id);
      continue;
    }

    if (kind !== 'session_mirror') {
      result.skipped.push(summary.id);
      continue;
    }

    const retention = summary.retention;
    if (!retention || retention.mode === 'keep' || !retention.ttlMs) {
      result.skipped.push(summary.id);
      continue;
    }

    // Already archived but still carrying `session_mirror` — a board written
    // before the kind rewrite existed. Treated the same as the branch above.
    if (retention.archivedAt) {
      if (
        retention.purgeAfterArchiveMs &&
        nowMs - Date.parse(retention.archivedAt) >= retention.purgeAfterArchiveMs
      ) {
        await deleteBoard(projectRoot, summary.id);
        result.deleted.push(summary.id);
      } else {
        result.archivedRetained.push(summary.id);
      }
      continue;
    }

    const updatedAtMs = Date.parse(summary.updatedAt);
    const ageMs = nowMs - updatedAtMs;
    if (ageMs < retention.ttlMs) {
      result.skipped.push(summary.id);
      continue;
    }

    if (retention.mode === 'delete_after_ttl') {
      await deleteBoard(projectRoot, summary.id);
      result.deleted.push(summary.id);
    } else {
      // archive_after_ttl: load the full board, mark as archived, persist.
      const board = await readBoard(projectRoot, summary.id);
      if (!board) {
        result.skipped.push(summary.id);
        continue;
      }
      const retention = board.retention;
      if (!retention || retention.mode === 'keep' || !retention.ttlMs) continue;
      board.kind = 'archive';
      board.retention = {
        mode: retention.mode,
        ttlMs: retention.ttlMs,
        // Carried through: dropping it here would strip the board's own purge
        // policy at the exact moment it enters the state that policy governs.
        ...(retention.purgeAfterArchiveMs !== undefined
          ? { purgeAfterArchiveMs: retention.purgeAfterArchiveMs }
          : {}),
        archivedAt: now,
      };
      board.updatedAt = now;
      await writeBoard(projectRoot, board);
      result.archived.push(summary.id);
    }
  }

  return result;
}
