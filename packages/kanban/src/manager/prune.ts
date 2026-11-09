import { deleteBoard, listBoardSummaries, mutateBoard, readBoard, writeBoard } from '../storage.js';
import type { KanbanTask } from '../types.js';
import { nowIso, stampAtomicityAssessment } from './_internal.js';

/** Persisted policy values must authorize a positive, finite retention window. */
function isRetentionDuration(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

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
    const affectedTasks = new Set<KanbanTask>();
    for (const task of board.tasks) {
      let taskChanged = false;
      if (task.dependsOn?.length) {
        const beforeLen = task.dependsOn.length;
        task.dependsOn = task.dependsOn.filter((id) => !dropped.has(id));
        if (task.dependsOn.length !== beforeLen) taskChanged = true;
        if (task.dependsOn.length === 0) delete task.dependsOn;
      }
      if (task.childTaskIds?.length) {
        const beforeLen = task.childTaskIds.length;
        task.childTaskIds = task.childTaskIds.filter((id) => !dropped.has(id));
        if (task.childTaskIds.length !== beforeLen) taskChanged = true;
        if (task.childTaskIds.length === 0) delete task.childTaskIds;
      }
      if (task.parentTaskId && dropped.has(task.parentTaskId)) {
        delete task.parentTaskId;
        taskChanged = true;
      }
      if (task.mergedIntoTaskId && dropped.has(task.mergedIntoTaskId)) {
        delete task.mergedIntoTaskId;
        taskChanged = true;
      }
      if (task.mergedFromTaskIds?.length) {
        const beforeLen = task.mergedFromTaskIds.length;
        task.mergedFromTaskIds = task.mergedFromTaskIds.filter((id) => !dropped.has(id));
        if (task.mergedFromTaskIds.length !== beforeLen) taskChanged = true;
        if (task.mergedFromTaskIds.length === 0) delete task.mergedFromTaskIds;
      }
      if (task.chain?.previousTaskId && dropped.has(task.chain.previousTaskId)) {
        delete task.chain.previousTaskId;
        taskChanged = true;
      }
      if (task.chain?.nextTaskId && dropped.has(task.chain.nextTaskId)) {
        delete task.chain.nextTaskId;
        taskChanged = true;
      }
      if (taskChanged) affectedTasks.add(task);
    }
    const now = nowIso();
    for (const task of affectedTasks) {
      // Re-stamp only. The atomicity assessment is a pure function of the
      // card's own shape (childCount, dependencyCount, successCriteriaCount,
      // …), so recomputing it after the card lost a reference keeps a DERIVED
      // value honest.
      //
      // Do NOT flip `blocked` -> `ready` here. `affectedTasks` only means "this
      // card lost a reference to something dropped" — which says nothing about
      // why the card is blocked. A card an operator blocked, or one held by a
      // park or a review, satisfies `areDependenciesMet` (it simply has no
      // unmet dependsOn), so the old branch rewrote it to 'ready' and moved it
      // out of the blocked column — and since isTaskReadyForWork accepts
      // ['pending','ready'], deliberately blocked work became claimable again
      // as a side effect of a size-bounding sweep, with nothing recording why.
      //
      // The branch also cannot serve the case it appears written for: a blocked
      // card's `dependsOn` entries are protected from dropping by
      // `retainedDependencies` above, so the drop never edits a blocked card's
      // dependsOn and a dependency-resolved card never even reaches this loop.
      stampAtomicityAssessment(board, task);
      task.updatedAt = now;
    }
    board.updatedAt = now;
    removedTaskIds.push(...dropped);
    return removedTaskIds.length;
  });
  // mutateBoard resolves to { board, result } even when the mutator bailed
  // out with null (non-mirror, managed, or already within the limit): that
  // is "nothing compacted", which this function's null return exists to say.
  if (!updated || updated.result === null) return null;
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
  // Fail closed on an unparseable clock: every elapsed check below compares
  // against nowMs, and a NaN comparison is always false, which reads as
  // "window elapsed" and would delete boards inside their purge window.
  if (!Number.isFinite(nowMs)) {
    throw new Error(`pruneSessionBoards: invalid now timestamp: ${JSON.stringify(now)}`);
  }
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
      if (!archived?.archivedAt || !isRetentionDuration(archived.purgeAfterArchiveMs)) {
        // No purge opted in: keep it, but say so.
        if (archived?.archivedAt) result.archivedRetained.push(summary.id);
        else result.skipped.push(summary.id);
        continue;
      }
      const archivedAtMs = Date.parse(archived.archivedAt);
      if (!Number.isFinite(archivedAtMs) || nowMs - archivedAtMs < archived.purgeAfterArchiveMs) {
        // An unparseable archivedAt cannot show the purge window elapsed.
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
    if (!retention || retention.mode === 'keep' || !isRetentionDuration(retention.ttlMs)) {
      result.skipped.push(summary.id);
      continue;
    }

    // Already archived but still carrying `session_mirror` — a board written
    // before the kind rewrite existed. Treated the same as the branch above.
    if (retention.archivedAt) {
      const archivedAtMs = Date.parse(retention.archivedAt);
      if (
        isRetentionDuration(retention.purgeAfterArchiveMs) &&
        Number.isFinite(archivedAtMs) &&
        nowMs - archivedAtMs >= retention.purgeAfterArchiveMs
      ) {
        await deleteBoard(projectRoot, summary.id);
        result.deleted.push(summary.id);
      } else {
        result.archivedRetained.push(summary.id);
      }
      continue;
    }

    const updatedAtMs = Date.parse(summary.updatedAt);
    if (!Number.isFinite(updatedAtMs)) {
      // Age is unknowable; a NaN age would read as "TTL elapsed" below.
      result.skipped.push(summary.id);
      continue;
    }
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
      if (!retention || retention.mode === 'keep' || !isRetentionDuration(retention.ttlMs))
        continue;
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
