/**
 * Worktree integration for phases: commit, dependency-ordered squash-merge back
 * into the base branch, conflict arbitration, and the failure bookkeeping that
 * keeps the graph honest when a merge does not land.
 *
 * Split out of `phase-orchestrator.ts`. The orchestrator passes an
 * {@link IntegrationContext} holding the state these steps read and mutate —
 * the same fields the private methods reached through `this`.
 *
 * @module goal/phase-orchestrator-integration
 */
import type { Logger } from '../types/logger.js';
import { toErrorMessage } from '../utils/error.js';
import type { WorktreeHandle, WorktreeManager } from '../worktree/worktree-manager.js';
import { setIntegrationMetadata } from './phase-orchestrator-queries.js';
import type {
  PhaseEventMap,
  PhaseEventName,
  PhaseExecutionContext,
  PhaseGraph,
  PhaseNode,
  PhaseStatus,
} from './types.js';

/** Orchestrator state the integration steps operate on. */
export interface IntegrationContext {
  graph: PhaseGraph;
  ctx: PhaseExecutionContext;
  logger: Logger;
  worktrees: WorktreeManager | undefined;
  /** phaseId → allocated worktree handle. */
  phaseWorktrees: Map<string, WorktreeHandle>;
  /** phaseId → promise settling when that phase's merge finished. */
  phaseMergePromise: Map<string, Promise<void>>;
  runningPhases: Set<string>;
  /** Global serialization chain — read and replaced by `commitAndEnqueueMerge`. */
  getMergeQueue: () => Promise<void>;
  setMergeQueue: (queue: Promise<void>) => void;
  emit: <E extends PhaseEventName>(event: E, payload: PhaseEventMap[E]) => void;
  updatePhaseStatus: (phase: PhaseNode, status: PhaseStatus) => void;
}

export function worktreeEnv(
  int: IntegrationContext,
  phase: PhaseNode,
): { cwd?: string | undefined; branch?: string | undefined } | undefined {
  const handle = int.phaseWorktrees.get(phase.id);
  return handle ? { cwd: handle.dir, branch: handle.branch } : undefined;
}

/** Shared failure bookkeeping for a phase whose tasks ran but the phase failed. */
export async function failPhaseAfterTasks(
  int: IntegrationContext,
  phase: PhaseNode,
  error: string,
): Promise<void> {
  int.updatePhaseStatus(phase, 'failed');
  phase.completedAt = Date.now();
  phase.actualDurationMs = Date.now() - (phase.startedAt ?? Date.now());
  int.runningPhases.delete(phase.id);
  int.graph.activePhaseIds = int.graph.activePhaseIds.filter((id) => id !== phase.id);
  if (!int.graph.failedPhaseIds.includes(phase.id)) int.graph.failedPhaseIds.push(phase.id);
  int.emit('phase.failed', { phaseId: phase.id, name: phase.name, error });
  int.ctx.onPhaseFail?.(phase, new Error(error));
  await keepWorktreeForReview(int, phase);
}

/**
 * A phase whose tasks all succeeded was marked `completed` and queued for
 * merge, but the merge back into the base branch failed. Its work is NOT
 * integrated, so correct the graph: move the phase out of `completedPhaseIds`
 * into `failedPhaseIds` and flip its status to `failed`. Without this the
 * persisted graph (and the board) would claim the phase succeeded while a
 * `phase.failed` event fired — an inconsistency that hides un-merged work.
 * Idempotent: safe to call more than once for the same phase.
 */
export function markPhaseMergeFailed(
  int: IntegrationContext,
  phase: PhaseNode,
  error: string,
): void {
  if (phase.status !== 'failed') {
    int.graph.completedPhaseIds = int.graph.completedPhaseIds.filter((id) => id !== phase.id);
    int.updatePhaseStatus(phase, 'failed');
  }
  if (!int.graph.failedPhaseIds.includes(phase.id)) int.graph.failedPhaseIds.push(phase.id);
  int.emit('phase.failed', { phaseId: phase.id, name: phase.name, error });
  int.ctx.onPhaseFail?.(phase, new Error(error));
}

/**
 * Commit the phase's worktree changes, then enqueue the merge back into the
 * base branch. Merges run dependency-ordered (a phase merges only after its
 * `dependsOn` phases) and globally serialized (one at a time) to avoid
 * concurrent writes to the base tree.
 */
export async function commitAndEnqueueMerge(
  int: IntegrationContext,
  phase: PhaseNode,
): Promise<void> {
  const handle = int.phaseWorktrees.get(phase.id);
  if (!int.worktrees || !handle) return;

  try {
    await int.worktrees.commitAll(handle, `goal(${phase.name}): ${phase.id}`);
  } catch {
    // commit failure is non-fatal; the merge step will report a clean tree.
  }

  const depPromises = phase.dependsOn
    .map((d) => int.phaseMergePromise.get(d))
    .filter((p): p is Promise<void> => Boolean(p));

  const merged = (async () => {
    await Promise.allSettled(depPromises); // dependency-ordered
    // Chain onto the global queue so only one merge touches base at a time.
    int.setMergeQueue(
      int
        .getMergeQueue()
        .then(() => mergeOne(int, phase, handle))
        .catch((err) => {
          // Defensive backstop: mergeOne handles its own errors, so this only
          // fires if it throws unexpectedly. Keep the queue alive (a failed
          // merge must not poison the chain) and correct the graph state.
          const msg = toErrorMessage(err);
          int.logger.error(msg, { event: 'orchestrator.merge_failed', phaseId: phase.id });
          markPhaseMergeFailed(int, phase, msg);
        }),
    );
    await int.getMergeQueue();
  })();
  int.phaseMergePromise.set(phase.id, merged);
}

/**
 * Squash-merge one phase. When a `resolveConflict` callback is wired, a merge
 * conflict is handed to it (a resolver subagent) before giving up; only if
 * that fails does the worktree fall to needs-review and the run continues.
 */
async function mergeOne(
  int: IntegrationContext,
  phase: PhaseNode,
  handle: WorktreeHandle,
): Promise<void> {
  if (!int.worktrees) return;
  try {
    const resolve = int.ctx.resolveConflict
      ? async (info: { conflictFiles: string[]; cwd: string }) => {
          const shouldResolve = await shouldAttemptConflictResolution(int, phase, info);
          if (!shouldResolve) return false;
          int.emit('phase.conflictResolving', {
            phaseId: phase.id,
            name: phase.name,
            files: info.conflictFiles,
          });
          const resolved = await int.ctx.resolveConflict?.(phase, info);
          return resolved ?? false;
        }
      : undefined;
    const mergeOpts: {
      squash: true;
      resolve?: (info: { conflictFiles: string[]; cwd: string }) => Promise<boolean>;
    } = {
      squash: true,
    };
    if (resolve !== undefined) mergeOpts.resolve = resolve;
    const result = await int.worktrees.merge(handle, mergeOpts);
    if (result.resolved) {
      int.emit('phase.conflictResolved', { phaseId: phase.id, name: phase.name });
    }
    setIntegrationMetadata(int.graph, phase, result.ok ? 'merged' : 'needs_review', {
      branch: handle.branch,
      worktreeDir: handle.dir,
      conflictFiles: result.conflictFiles,
    });
    // merge() already emitted worktree.merged / worktree.conflict and set status.
    // Clean (or resolved) merge → remove the worktree; conflict → release(keep).
    await int.worktrees.release(handle, { keep: !result.ok });
  } catch (err) {
    setIntegrationMetadata(int.graph, phase, 'merge_failed', {
      branch: handle.branch,
      worktreeDir: handle.dir,
      error: toErrorMessage(err),
    });
    // The merge failed → the phase's work never reached base. Reflect that in
    // the graph, not just in metadata + a stray event (see markPhaseMergeFailed).
    markPhaseMergeFailed(int, phase, `worktree merge failed: ${toErrorMessage(err)}`);
  }
}

async function shouldAttemptConflictResolution(
  int: IntegrationContext,
  phase: PhaseNode,
  info: { conflictFiles: string[]; cwd: string },
): Promise<boolean> {
  if (!int.ctx.brain) return true;

  const decision = await int.ctx.brain.decide({
    id: `goal-conflict-${phase.id}`,
    source: 'goal',
    question: `Should Goal try to resolve merge conflicts for phase "${phase.name}" automatically?`,
    context: [
      `Phase id: ${phase.id}`,
      `Conflicted files: ${info.conflictFiles.join(', ') || '(unknown)'}`,
      `Base working tree: ${info.cwd}`,
    ].join('\n'),
    // 'critical', not 'high': choosing `resolve` lets a resolver agent EDIT
    // FILES IN THE BASE WORKING TREE. That is the one Brain decision in the
    // system whose wrong answer is not recoverable by simply continuing —
    // unlike a budget grant (bounded, capped) or a goal-done verdict (the
    // run can be restarted).
    //
    // Consequences of the level, both intended:
    //   - it is at or above the council floor, so a multi-LLM panel decides
    //     it whenever one can convene;
    //   - with no council (a single-model install resolves the autonomy
    //     ceiling to 'high'), it exceeds the ceiling and never reaches an
    //     unchecked single model. The policy tier's `ask_human` then routes
    //     to the terminal policy, which refuses a recommended option at
    //     critical risk and denies — i.e. the worktree is kept for human
    //     review, which is exactly the safe outcome.
    risk: 'critical',
    fallback: 'ask_human',
    options: [
      {
        id: 'resolve',
        label: 'Try the configured conflict resolver',
        consequence: 'A resolver agent may edit conflicted files in the base working tree.',
        risk: 'critical',
      },
      {
        id: 'review',
        label: 'Keep the worktree for human review',
        consequence: 'No automatic conflict resolution is attempted.',
        risk: 'low',
        recommended: true,
      },
    ],
  });

  phase.metadata = {
    ...phase.metadata,
    brainConflictDecision: decision.type,
    brainConflictDecisionAt: Date.now(),
  };

  if (decision.type !== 'answer') return false;
  // Control-plane check: automatic conflict resolution runs ONLY on the
  // exact option id. Prose mentioning "resolve" is not authorization.
  return decision.optionId === 'resolve';
}

/** A failed phase keeps its worktree on disk for inspection (no merge). */
export async function keepWorktreeForReview(
  int: IntegrationContext,
  phase: PhaseNode,
): Promise<void> {
  const handle = int.phaseWorktrees.get(phase.id);
  if (!int.worktrees || !handle) return;
  try {
    await int.worktrees.commitAll(handle, `goal(${phase.name}) [failed]: ${phase.id}`);
  } catch {
    // best effort
  }
  setIntegrationMetadata(int.graph, phase, 'not_merged_failed_phase', {
    branch: handle.branch,
    worktreeDir: handle.dir,
  });
  await int.worktrees.release(handle, { keep: true }).catch(() => {});
}
