import { realpath } from 'node:fs/promises';
import * as path from 'node:path';
import type { KanbanBoundaryEvaluation, KanbanContractReadinessIssue } from '@wrongstack/kanban';
import { kanbanGovernance } from './kanban-governance-port.js';
import type { Context } from '../core/context.js';
import type { Tool } from '../types/tool.js';

export interface ToolKanbanBoundaryEvaluation extends KanbanBoundaryEvaluation {
  boardId?: string | undefined;
  taskId?: string | undefined;
  /** Machine-readable readiness failures; `reason` remains the human fallback. */
  readinessIssues?: KanbanContractReadinessIssue[] | undefined;
}

export interface ToolKanbanGovernanceOptions {
  /** Require every product mutation to run inside a ready, running Kanban card. */
  requireGovernance?: boolean | undefined;
}

const GOVERNANCE_CONTROL_TOOLS = new Set(['kanban', 'plan', 'task', 'todo', 'nextsteps']);

const PATH_KEYS = new Set([
  'path',
  'paths',
  'file',
  'files',
  'directory',
  'dir',
  'cwd',
  'root',
  'baseDir',
  'out',
  'outputPath',
  'sourcePath',
  'targetPath',
  'destinationPath',
  'fromPath',
  'toPath',
  'worktreePath',
]);

const TOOL_PATH_KEYS: Readonly<Record<string, readonly string[]>> = {
  // `target` is an identifier in tools such as plan/task/document, but a
  // filesystem target in language_info. Keep ambiguous names tool-specific.
  language_info: ['target'],
};

/** Resolve the live board/task policy and gate one tool invocation. */
export async function evaluateToolKanbanBoundary(
  tool: Tool,
  input: Record<string, unknown>,
  ctx: Context,
  options: ToolKanbanGovernanceOptions = {},
): Promise<ToolKanbanBoundaryEvaluation> {
  // The Kanban control plane must remain reachable so an agent can record
  // evidence or start the next card. Contract maps stay advisory unless an
  // operator explicitly configured strict enforcement.
  if (tool.name === 'kanban') return { decision: 'allow' };
  const identity = resolveKanbanIdentity(ctx);
  const governanceRequired = options.requireGovernance && isGovernedMutation(tool, input);
  if (!identity.boardId) {
    return governanceRequired
      ? {
          decision: 'block',
          reason:
            'Kanban governance is mandatory before product mutation. Create a managed card, add its required details and executable acceptance criteria, then call kanban start_task to bind it to this run.',
        }
      : { decision: 'allow' };
  }
  const board = await kanbanGovernance().readBoard(
    identity.policyRoot ?? ctx.projectRoot,
    identity.boardId,
  );
  if (!board) {
    return governanceRequired
      ? {
          decision: 'block',
          reason: `Active Kanban board not found: ${identity.boardId}. Recreate or select a valid managed card before mutation.`,
          boardId: identity.boardId,
          ...(identity.taskId ? { taskId: identity.taskId } : {}),
        }
      : { decision: 'allow' };
  }
  const task = identity.taskId
    ? board.tasks.find((candidate) => candidate.id === identity.taskId)
    : undefined;

  // Governance is a property of the board, not merely of "some board being
  // bound". Only a managed board can satisfy the checks below: it is the only
  // kind with a lifecycle, a contract graph, and a running assignment. An
  // observational board — a session mirror, an SDD mirror, a plain import —
  // structurally cannot, and task-graph sync explicitly refuses to make one
  // managed. Demanding governance from such a board produced an inescapable
  // deadlock: every mutating tool blocked, with the only stated remedy
  // (put the board in managed mode) unreachable by construction. Those boards
  // still fall through to the boundary layers below, which is where their
  // real, path-scoped policy lives.
  if (governanceRequired && board.lifecycle?.mode === 'managed') {
    if (!identity.taskId) {
      return {
        decision: 'block',
        reason:
          'Kanban governance requires an active task, not only a board. Complete the card details and call kanban start_task before mutation.',
        boardId: board.id,
      };
    }
    if (!task) {
      return {
        decision: 'block',
        reason: `Active Kanban task not found: ${identity.taskId}. Call kanban start_task with a valid card.`,
        boardId: board.id,
        taskId: identity.taskId,
      };
    }
    const readiness = kanbanGovernance().evaluateContractGraphReadiness(board, task.id);
    if (!readiness.ready) {
      // K-01 observability: the prior message ("not implementation-ready:
      // <issues>") was opaque to operators because it never named WHICH
      // gate fired. Lead the block message with the *category* so an
      // operator knows immediately that the contract graph (not the
      // lifecycle or assignment) is the cause, and emit one line per
      // failing readiness issue so the message is grep-able in logs.
      const issueLines = readiness.issues
        .map((issue, index) => `  ${index + 1}. ${issue.message}`)
        .join('\n');
      return {
        decision: 'block',
        reason:
          `Active card failed contract-readiness check (${readiness.issues.length} issue(s)):\n` +
          issueLines +
          `\nResolve the readiness issues, then call kanban start_task to retry.`,
        boardId: board.id,
        taskId: task.id,
        readinessIssues: readiness.issues,
      };
    }
    // K-01 + race-condition observability: previously the message was
    // "(lifecycle: X; assignment: Y)" regardless of which check fired.
    // That made the automated-reassessment case (K-01 root cause) look
    // like a never-started card. Branch on the actual cause and name
    // it. The reassessment case is called out specifically because
    // operators hit it most often and the previous wording sent them
    // looking for the wrong fix.
    const lifecycleStage = task.lifecycle?.currentStage;
    const assignmentStatus = task.assignment?.status;
    const lifecycleOk = lifecycleStage === 'running';
    const assignmentOk = assignmentStatus === 'running';
    if (!lifecycleOk || !assignmentOk) {
      const failed: string[] = [];
      let reassessmentNote = '';
      if (!lifecycleOk) {
        failed.push(`lifecycle.currentStage (got: ${lifecycleStage ?? 'missing'}; want: 'running')`);
      }
      if (!assignmentOk) {
        failed.push(`assignment.status (got: ${assignmentStatus ?? 'missing'}; want: 'running')`);
        // Reassessment-cleared case: lifecycle says running, but
        // assignment was cleared back to 'queued' (or unset) by the
        // automated kanban reassessment agent. The leader still owns
        // the card; the binding was lost. Tell the operator so they
        // don't re-issue start_task needlessly.
        if (lifecycleOk && (assignmentStatus === 'queued' || assignmentStatus === undefined || assignmentStatus === null)) {
          reassessmentNote =
            '\nNote: lifecycle is still "running" but the assignment was cleared — ' +
            'the automated kanban reassessment agent likely reset the binding. ' +
            'Re-issue kanban start_task to re-bind the leader to this card.';
        }
      }
      return {
        decision: 'block',
        reason:
          `Active card failed ${failed.length} governance check(s) before product mutation:\n` +
          failed.map((line, index) => `  ${index + 1}. ${line}`).join('\n') +
          reassessmentNote,
        boardId: board.id,
        taskId: task.id,
      };
    }
  }

  // Lease ownership check: when the subagent was dispatched with a frozen
  // leaseId, verify the task's current assignment still matches. A mismatch
  // means recover_stale reclaimed and reassigned this task — the subagent is
  // stale and must not perform filesystem writes (except the kanban tool,
  // which has its own expectedLeaseId fence in the assignment handlers).
  if (identity.leaseId && task?.assignment) {
    const caps = tool.capabilities ?? [];
    const isWrite =
      caps.includes('fs.write') ||
      caps.includes('fs.write.outside-project') ||
      caps.some((c) => c.startsWith('shell.'));
    if (isWrite && tool.name !== 'kanban' && task.assignment.leaseId !== identity.leaseId) {
      return {
        decision: 'block',
        reason:
          `Task ${task.id} lease mismatch: the current worker's lease (${identity.leaseId}) ` +
          `does not match the active lease on the board (${task.assignment.leaseId}). ` +
          `This task was likely recovered and reassigned to another worker. ` +
          `File modifications from a stale worker are blocked. ` +
          `Use kanban mark_assignment with expectedLeaseId to resolve, or use ` +
          `kanban get_board to reassess the current state.`,
        boardId: board.id,
        taskId: task.id,
      };
    }
  }

  const layers = kanbanGovernance().resolveKanbanBoundaryLayers(board, task);
  if (layers.length === 0) return { decision: 'allow' };

  const caps = tool.capabilities ?? [];
  const access =
    caps.includes('fs.write') || caps.includes('fs.write.outside-project')
      ? 'write'
      : caps.includes('fs.read')
        ? 'read'
        : undefined;
  const shellLike = caps.some((capability) => capability.startsWith('shell.'));
  const candidates = access ? await extractCandidatePaths(tool.name, input, ctx) : [];

  let evaluation: KanbanBoundaryEvaluation;
  if (shellLike || (access && candidates.length === 0)) {
    evaluation = kanbanGovernance().evaluateKanbanBoundaryOpaque(layers, tool.name);
  } else if (access) {
    const results = candidates.map((candidate) =>
      kanbanGovernance().evaluateKanbanBoundaryPath(layers, candidate, access),
    );
    evaluation = results.find((result) => result.decision === 'block') ??
      results.find((result) => result.decision === 'confirm') ?? { decision: 'allow' };
  } else {
    evaluation = { decision: 'allow' };
  }
  return {
    ...evaluation,
    boardId: board.id,
    ...(task ? { taskId: task.id } : {}),
  };
}

function isGovernedMutation(tool: Tool, input: Record<string, unknown>): boolean {
  if (!tool.mutating || GOVERNANCE_CONTROL_TOOLS.has(tool.name)) return false;
  if (tool.capabilities?.includes('tool.meta')) return false;
  if (tool.name === 'git') {
    const command = input['command'];
    if (command === 'status' || command === 'log' || command === 'diff') return false;
    if (command === 'worktree' && input['worktreeAction'] === 'list') return false;
  }
  const capabilities = tool.capabilities ?? [];
  return capabilities.some(
    (capability) =>
      capability === 'fs.write' ||
      capability === 'fs.write.outside-project' ||
      capability === 'package.install' ||
      capability === 'tool.mutate.any' ||
      capability.startsWith('shell.') ||
      capability === 'net.outbound',
  );
}

function resolveKanbanIdentity(ctx: Context): {
  boardId?: string;
  taskId?: string;
  policyRoot?: string;
  leaseId?: string;
} {
  const metaKanban = ctx.meta['kanban'];
  const record =
    metaKanban && typeof metaKanban === 'object'
      ? (metaKanban as Record<string, unknown>)
      : undefined;
  const boardId =
    ctx.currentKanbanBoardId ??
    (typeof record?.['boardId'] === 'string' ? record['boardId'] : undefined);
  const taskId =
    ctx.currentKanbanTaskId ??
    (typeof record?.['taskId'] === 'string' ? record['taskId'] : undefined);
  const policyRoot =
    typeof record?.['projectRoot'] === 'string' ? record['projectRoot'] : undefined;
  const leaseId = typeof record?.['leaseId'] === 'string' ? record['leaseId'] : undefined;
  return {
    ...(boardId ? { boardId } : {}),
    ...(taskId ? { taskId } : {}),
    ...(policyRoot ? { policyRoot } : {}),
    ...(leaseId ? { leaseId } : {}),
  };
}

async function extractCandidatePaths(
  toolName: string,
  input: Record<string, unknown>,
  ctx: Context,
): Promise<string[]> {
  if (toolName === 'patch' && typeof input['patch'] === 'string') {
    const directoryInput = stringValue(input['directory']) ?? ctx.workingDir;
    const directory = path.isAbsolute(directoryInput)
      ? directoryInput
      : path.resolve(ctx.workingDir, directoryInput);
    const strip = Math.max(1, numericValue(input['strip']) ?? 1);
    const targets = extractPatchTargets(input['patch'], strip).map((target) =>
      relativeToProject(path.resolve(directory, target), ctx.projectRoot),
    );
    return Promise.all(targets.map((target) => canonicalizeCandidatePath(target, ctx)));
  }

  const values: string[] = [];
  const pathKeys = new Set(PATH_KEYS);
  for (const key of TOOL_PATH_KEYS[toolName] ?? []) pathKeys.add(key);
  collectPathValues(input, values, pathKeys);
  if (toolName === 'scaffold' && typeof input['name'] === 'string') {
    const cwd = stringValue(input['cwd']) ?? ctx.workingDir;
    values.push(path.join(cwd, input['name']));
  }
  const candidates = [
    ...new Set(values.flatMap(splitPathList).map((value) => resolveInputPath(value, ctx))),
  ];
  return Promise.all(candidates.map((candidate) => canonicalizeCandidatePath(candidate, ctx)));
}

async function canonicalizeCandidatePath(candidate: string, ctx: Context): Promise<string> {
  if (path.isAbsolute(candidate)) return candidate;
  const absolute = path.resolve(ctx.projectRoot, candidate);
  const canonicalRoot = await realpath(ctx.projectRoot).catch(() => ctx.projectRoot);
  let probe = absolute;
  const missingSegments: string[] = [];
  while (true) {
    try {
      const canonical = path.join(await realpath(probe), ...missingSegments);
      return relativeToProject(canonical, canonicalRoot);
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return absolute;
      const parent = path.dirname(probe);
      if (parent === probe) return absolute;
      missingSegments.unshift(path.basename(probe));
      probe = parent;
    }
  }
}

function collectPathValues(
  value: unknown,
  output: string[],
  pathKeys: ReadonlySet<string>,
  key?: string,
): void {
  if (typeof value === 'string') {
    if (key && pathKeys.has(key)) output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPathValues(item, output, pathKeys, key);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
    collectPathValues(child, output, pathKeys, childKey);
  }
}

function splitPathList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function resolveInputPath(value: string, ctx: Context): string {
  const absolute = path.isAbsolute(value) ? value : path.resolve(ctx.workingDir, value);
  return relativeToProject(absolute, ctx.projectRoot);
}

function relativeToProject(absolute: string, projectRoot: string): string {
  const relative = path.relative(projectRoot, absolute).replace(/\\/g, '/');
  return relative.startsWith('../') || path.isAbsolute(relative) ? absolute : relative || '.';
}

function extractPatchTargets(patchText: string, strip: number): string[] {
  const targets: string[] = [];
  for (const match of patchText.matchAll(/^\+\+\+\s+([^\t\r\n]+)/gm)) {
    const raw = match[1]?.trim();
    if (!raw || raw === '/dev/null') continue;
    const parts = raw
      .replace(/\\/g, '/')
      .split('/')
      .filter((part) => part && part !== '.');
    if (parts.length > strip) targets.push(parts.slice(strip).join('/'));
  }
  return targets;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function numericValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
