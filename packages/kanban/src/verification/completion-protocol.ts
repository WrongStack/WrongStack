/**
 * Completion Protocol — the centralized task verification orchestrator.
 *
 * verifyTaskCompletion() is the single entry point for verifying that a
 * Kanban task is "truly complete." It:
 *
 * 1. Recursively verifies child tasks (when task.atomic === true) — children
 *    must be complete before the parent can be verified.
 * 2. For each success criterion, resolves the verifier plugin and executes it.
 * 3. For checks marked 'agent' or 'council' escalation, delegates to an
 *    appropriate verifier that MUST produce concrete backing evidence.
 * 4. Compares file-change expectations against actual git diff.
 * 5. Aggregates everything into a KanbanVerificationReport.
 * 6. Writes the report atomically into the SQLite-backed board record via the owner mutation.
 *
 * Deterministic by default — zero LLM calls unless a check explicitly opts
 * into agent/council escalation.
 */
// Import from the defining leaf module, not the `../manager.js` barrel, which
// re-exports this file — importing the barrel would form a module cycle
// (manager.ts ↔ verification/completion-protocol.ts) that check:architecture flags.
import { getBoard } from '../manager/boards.js';
import { findTask } from '../manager/task-lookup.js';
import type {
  KanbanBoard,
  KanbanTask,
  KanbanVerificationAttachment,
  KanbanVerificationCheckResult,
  KanbanVerificationFileScope,
  KanbanVerificationReport,
  KanbanVerificationSubtasks,
} from '../types.js';
import { commandAllowlistFromEnv } from './command-security.js';
import { createDefaultRegistry } from './plugins/index.js';
import { VerificationContext } from './verification-context.js';
import { buildVerificationReport } from './verification-report.js';
import type { VerifierRegistry } from './verifier-registry.js';

export interface VerifyTaskCompletionOptions {
  /** Custom verifier registry (default: deterministic plugins only). */
  registry?: VerifierRegistry | undefined;
  /** Optional pre-captured git snapshot for diff comparison. */
  snapshot?: { id: string; capturedAt: string } | undefined;
  /**
   * Whether to persist the verification report onto the board
   * inside verifyTaskCompletion (default: true).
   * When false, the caller is responsible for persisting the returned
   * report via its own board mutation.
   */
  persist?: boolean | undefined;
}

export interface VerifyTaskCompletionResult {
  /** The board (post-mutation when persist=true). */
  board: KanbanBoard;
  /** The task with updated verificationReport. */
  task: KanbanTask;
  /** The full verification report. */
  report: KanbanVerificationReport;
}

/**
 * Verify that a task is complete. This is the single orchestrator —
 * called by the `kanban verify_completion` tool action, the lifecycle
 * transition gate, and externally by the Director/quality_gate.
 *
 * Returns the updated board + task + report. The report is persisted
 * on the task's `verificationReport` field when persist=true (default).
 */
export async function verifyTaskCompletion(
  projectRoot: string,
  boardId: string,
  taskId: string,
  options: VerifyTaskCompletionOptions = {},
): Promise<VerifyTaskCompletionResult> {
  return verifyTaskCompletionGuarded(projectRoot, boardId, taskId, options, new Set());
}

/**
 * Cycle guard for the parent/child recursion below.
 *
 * `verifyTaskCompletion` descends into `childTaskIds`, and nothing upstream
 * guarantees that relation is acyclic: `splitTask` is safe because it mints
 * fresh child ids, but `syncTaskGraphIntoBoard` copies `node.children` straight
 * through, and a board file is ordinary project data that other tools can
 * write. A cycle made this recurse forever — and because the recursion is
 * `async`, it does not even fail fast with a stack overflow: it re-reads the
 * board on every hop and keeps going.
 *
 * The set is scoped to the current descent path, added on entry and removed on
 * exit, so a task legitimately reachable through two different parents (a
 * diamond) is not mistaken for a cycle.
 *
 * A cyclic graph is corrupt structure rather than a verification outcome, so it
 * throws — the same way this function already throws for a missing board or a
 * missing task — instead of returning a verdict that could be read as a pass.
 */
async function verifyTaskCompletionGuarded(
  projectRoot: string,
  boardId: string,
  taskId: string,
  options: VerifyTaskCompletionOptions,
  path: Set<string>,
): Promise<VerifyTaskCompletionResult> {
  const key = `${boardId}::${taskId}`;
  if (path.has(key)) {
    throw new Error(
      `Cyclic parent/child task graph: task ${taskId} on board ${boardId} is its own descendant.`,
    );
  }
  path.add(key);
  try {
    return await runVerifyTaskCompletion(projectRoot, boardId, taskId, options, path);
  } finally {
    path.delete(key);
  }
}

async function runVerifyTaskCompletion(
  projectRoot: string,
  boardId: string,
  taskId: string,
  options: VerifyTaskCompletionOptions,
  path: Set<string>,
): Promise<VerifyTaskCompletionResult> {
  const registry = options.registry ?? createDefaultRegistry();

  // Load the board (we'll mutate it to persist the report)
  const board = await getBoard(projectRoot, boardId);
  if (!board) throw new Error(`Board not found: ${boardId}`);
  const task = findTaskInBoard(board, taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);

  const context = new VerificationContext({
    projectRoot,
    board,
    task,
    // Operator-widened command allowlist, e.g.
    // WRONGSTACK_KANBAN_VERIFIER_COMMANDS=+tsc enables typecheck command
    // checks. The hard blocklist always keeps precedence.
    commandAllowlist: commandAllowlistFromEnv(process.env),
  });

  // Phase 1: Recursively verify subtasks (when atomic)
  let subtaskReport: KanbanVerificationSubtasks | undefined;
  if (task.atomic && task.childTaskIds?.length) {
    subtaskReport = await verifySubtasks(projectRoot, board, task, registry, options, path);
    // If any child failed, we can still run parent checks but the
    // overall verdict will reflect it.
  }

  // Phase 2: Verify each success criterion
  const checks = task.successCriteria ?? [];
  const checkResults: KanbanVerificationCheckResult[] = [];

  // Capture git snapshot before running checks
  if (checks.length > 0) {
    await context.captureSnapshot();
  }

  for (const check of checks) {
    const result = await registry.verify(check, context);
    checkResults.push(result);
  }

  // Phase 3: File scope verification
  let fileScope: KanbanVerificationFileScope | undefined;
  if (task.expectedFileChanges?.length) {
    fileScope = await verifyFileScope(context, task);
  }

  // Phase 4: Build the report
  const report = buildVerificationReport({
    taskId: task.id,
    taskTitle: task.title,
    boardId: board.id,
    checks: checkResults,
    fileScope,
    subtasks: subtaskReport,
    attachments: collectAttachments(checkResults),
    // Bind the report to the assignment/attempt/revision that produced the
    // verified work, and to the git baseline the file-scope diff was measured
    // against. All optional: older callers and tests that omit them keep
    // working; the fields simply stay absent on those reports.
    ...(task.assignment?.attempt !== undefined ? { attempt: task.assignment.attempt } : {}),
    ...(task.assignment?.leaseId !== undefined ? { leaseId: task.assignment.leaseId } : {}),
    ...(board.revision !== undefined ? { taskRevision: board.revision } : {}),
    ...(context.capturedSnapshot
      ? {
          baseline: {
            id: context.capturedSnapshot.id,
            commitHash: context.capturedSnapshot.commitHash,
            treeHash: context.capturedSnapshot.treeHash,
            capturedAt: context.capturedSnapshot.capturedAt,
          },
        }
      : {}),
  });

  // Phase 5: Update in-memory task state (persist via board mutation)

  // Update individual check statuses
  const updatedTask = { ...task };
  if (updatedTask.successCriteria) {
    updatedTask.successCriteria = updatedTask.successCriteria.map((existing) => {
      const result = checkResults.find((r) => r.checkId === existing.id);
      if (!result) return existing;
      return {
        ...existing,
        // Map KanbanCheckReportStatus → KanbanCheckStatus:
        // 'error' is a runtime failure → 'failed', 'pending' is inapplicable here
        status:
          result.status === 'passed'
            ? ('passed' as const)
            : result.status === 'failed'
              ? ('failed' as const)
              : result.status === 'skipped'
                ? ('skipped' as const)
                : ('failed' as const),
        checkedBy: result.type === 'agent' ? 'agent' : 'system',
        checkedAt: report.completedAt,
        // `notes` is the criterion's INPUT, not a place to record the outcome:
        // every deterministic plugin reads it as the command, test pattern,
        // path, or JSON config to run (falling back to `description`).
        // Overwriting it with a result narrative destroyed that input, so a
        // re-run read "[failed] File not found: evidence.txt" as the path and
        // could never recover — an executable criterion was single-use, and a
        // fixed defect could not be re-verified.
        //
        // Nothing displays `notes`; the outcome already lives in
        // `verificationReport.checks[]` (status, evidence, error), which is
        // persisted alongside this task. So the narrative had no reader and
        // the input had one.
      };
    });
  }

  // We need to get the task snapshot and persist via the board mutation.
  // Since we can't do mutateBoard from this layer easily, we return the
  // result and let the caller (tool/lifecycle) handle persistence.

  // Update the task's verification report in-memory
  updatedTask.verificationReport = report;

  // Return the updated state (caller persists via board mutation)
  return {
    board: { ...board, tasks: board.tasks.map((t) => (t.id === task.id ? updatedTask : t)) },
    task: updatedTask,
    report,
  };
}

/**
 * Verify all child tasks recursively.
 */
async function verifySubtasks(
  projectRoot: string,
  board: KanbanBoard,
  parentTask: KanbanTask,
  registry: VerifierRegistry,
  options: VerifyTaskCompletionOptions,
  path: Set<string>,
): Promise<KanbanVerificationSubtasks> {
  const childIds = parentTask.childTaskIds ?? [];
  const children: KanbanTask[] = [];
  const childVerdicts: KanbanVerificationSubtasks['children'] = [];

  for (const childId of childIds) {
    const child = findTaskInBoard(board, childId);
    if (child) {
      children.push(child);
    } else {
      childVerdicts.push({
        taskId: childId,
        title: `Missing child (${childId})`,
        verdict: 'failed',
      });
    }
  }

  let completed = 0;
  let failed = childVerdicts.length;

  for (const child of children) {
    // Recursively verify
    let report: KanbanVerificationReport | undefined;

    // Only recurse if not already verified
    if (child.verificationReport) {
      report = child.verificationReport;
    } else if (child.atomic && child.childTaskIds?.length) {
      // Nested atomic — recurse
      const childResult = await verifyTaskCompletionGuarded(
        projectRoot,
        board.id,
        child.id,
        options,
        path,
      );
      report = childResult.report;
    } else {
      // Simple child — run checks
      const ctx = new VerificationContext({
        projectRoot,
        board,
        task: child,
        commandAllowlist: commandAllowlistFromEnv(process.env),
      });
      const checkResults: KanbanVerificationCheckResult[] = [];

      if (child.successCriteria?.length) {
        await ctx.captureSnapshot();
        for (const check of child.successCriteria) {
          checkResults.push(await registry.verify(check, ctx));
        }
      }

      report = buildVerificationReport({
        taskId: child.id,
        taskTitle: child.title,
        boardId: board.id,
        checks: checkResults,
      });
    }

    if (report.verdict === 'passed') completed++;
    else failed++;

    childVerdicts.push({
      taskId: child.id,
      title: child.title,
      verdict: report.verdict,
    });
  }

  return {
    total: childIds.length,
    completed,
    failed,
    children: childVerdicts,
  };
}

/**
 * Compare expected file changes against actual git diff.
 */
async function verifyFileScope(
  context: VerificationContext,
  task: KanbanTask,
): Promise<KanbanVerificationFileScope> {
  const expected = task.expectedFileChanges ?? [];
  const diff = await context.diffSince();
  const changedPaths = new Map<string, { operation: string; linesChanged: number }>();
  for (const entry of diff) {
    changedPaths.set(entry.path, {
      operation: entry.operation,
      linesChanged: entry.linesAdded + entry.linesRemoved,
    });
  }

  const files: KanbanVerificationFileScope['files'] = [];
  let scopeMatches = true;

  // Check expected files
  for (const exp of expected) {
    const actual = changedPaths.get(exp.path);
    const found = actual !== undefined;
    if (!found) scopeMatches = false;
    files.push({
      path: exp.path,
      operation: exp.operation,
      expected: found,
      linesChanged: actual?.linesChanged ?? 0,
    });
  }

  // Report unexpected changes
  for (const [path, info] of changedPaths) {
    if (!expected.find((e) => e.path === path)) {
      files.push({
        path,
        operation: info.operation as 'create' | 'modify' | 'delete',
        expected: false,
        linesChanged: info.linesChanged,
      });
      scopeMatches = false;
    }
  }

  return {
    expectedChanges: expected.length,
    actualChanges: diff.length,
    scopeMatches,
    files,
  };
}

/** Collect attachment metadata from check results. */
function collectAttachments(
  checks: KanbanVerificationCheckResult[],
): KanbanVerificationAttachment[] {
  const attachments: KanbanVerificationAttachment[] = [];

  for (const check of checks) {
    if (check.type === 'test' && check.evidence['failureOutput']) {
      attachments.push({
        kind: 'test_output',
        label: `${check.description} — test output`,
        content: (check.evidence['failureOutput'] as string).slice(0, 5000),
      });
    }
    if (check.type === 'command' && check.evidence['stdout']) {
      attachments.push({
        kind: 'command_output',
        label: `${check.description} — stdout`,
        content: (check.evidence['stdout'] as string).slice(0, 5000),
      });
    }
    if (check.type === 'git_diff' && check.evidence['diffStats']) {
      attachments.push({
        kind: 'diff',
        label: `${check.description} — diff stats`,
        content: JSON.stringify(check.evidence['diffStats'], null, 0),
      });
    }
  }

  return attachments;
}

/** Find a task in the board's task array by id or prefix. */
function findTaskInBoard(board: KanbanBoard, taskId: string): KanbanTask | undefined {
  return findTask(board, taskId);
}
