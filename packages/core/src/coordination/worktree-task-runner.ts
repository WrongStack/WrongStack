import type { FleetConfig } from '@wrongstack/contracts/types/config';
import type {
  SubagentConfig,
  SubagentRunContext,
  SubagentRunner,
  SubagentRunOutcome,
  TaskSpec,
} from '@wrongstack/contracts/types/multi-agent';
import { ToolCapabilities } from '../security/capabilities.js';
import { toErrorMessage } from '../utils/error.js';
import type { WorktreeHandle, WorktreeManager } from '../worktree/worktree-manager.js';
import { isExternalAgentProvider } from './external-agent-provider.js';

export type FleetWorktreePolicy = NonNullable<FleetConfig['worktrees']>;

export type WorktreeIsolationDecision = 'off' | 'optional' | 'required';

export interface WorktreeTaskStateUpdate {
  taskId: string;
  subagentId: string;
  handleId: string;
  dir: string;
  branch: string;
  baseBranch: string;
  status:
    | 'allocated'
    | 'fallback'
    | 'committed'
    | 'merged'
    | 'kept'
    | 'released'
    | 'conflict'
    | 'failed';
  commitSha?: string | undefined;
  conflictFiles?: string[] | undefined;
  error?: string | undefined;
}

export interface WorktreeTaskRunnerOptions {
  runner: SubagentRunner;
  worktrees?: WorktreeManager | undefined;
  policy?: FleetWorktreePolicy | undefined;
  conflictResolver?:
    | ((info: {
        task: TaskSpec;
        config: SubagentConfig;
        conflictFiles: string[];
        cwd: string;
      }) => Promise<boolean>)
    | undefined;
  onUpdate?: ((update: WorktreeTaskStateUpdate) => void) | undefined;
}

export class WorktreeIntegrationError extends Error {
  readonly taskId: string;
  readonly subagentId: string;
  readonly branch?: string | undefined;
  readonly conflictFiles?: string[] | undefined;

  constructor(
    message: string,
    opts: {
      taskId: string;
      subagentId: string;
      branch?: string | undefined;
      conflictFiles?: string[] | undefined;
    },
  ) {
    super(message);
    this.name = 'WorktreeIntegrationError';
    this.taskId = opts.taskId;
    this.subagentId = opts.subagentId;
    this.branch = opts.branch;
    this.conflictFiles = opts.conflictFiles;
  }
}

const MUTATING_TOOL_NAMES = new Set([
  'write',
  'edit',
  'replace',
  'patch',
  'task',
  'plan',
  'design',
  'document',
  'scaffold',
  'bash',
  'exec',
  'lint',
  'format',
  'typecheck',
  'test',
  'install',
]);

const MUTATING_CAPABILITIES = new Set<string>([
  ToolCapabilities.FS_WRITE,
  ToolCapabilities.FS_WRITE_OUTSIDE_PROJECT,
  ToolCapabilities.SHELL_ARBITRARY,
  ToolCapabilities.SHELL_RESTRICTED,
  ToolCapabilities.SHELL_EXEC,
  ToolCapabilities.PACKAGE_INSTALL,
]);

export function subagentNeedsWorktree(config: SubagentConfig): boolean {
  if (isExternalAgentProvider(config.provider)) return false;
  if (config.tools?.some((tool) => MUTATING_TOOL_NAMES.has(tool))) return true;
  if (config.allowedCapabilities?.some((cap) => MUTATING_CAPABILITIES.has(cap))) return true;
  return !config.tools && !config.allowedCapabilities;
}

export function resolveSubagentWorktreeDecision(
  config: SubagentConfig,
  policy?: FleetWorktreePolicy | undefined,
): WorktreeIsolationDecision {
  if (policy?.enabled === false || policy?.mode === 'off') return 'off';
  if (config.worktree === false || config.worktree === 'off') return 'off';
  if (config.worktree === true || config.worktree === 'required') return 'required';

  const needsIsolation = subagentNeedsWorktree(config);
  if (!needsIsolation) return 'off';
  return policy?.mode === 'required' ? 'required' : 'optional';
}

export function wrapSubagentRunnerWithWorktrees(opts: WorktreeTaskRunnerOptions): SubagentRunner {
  return async (task, ctx) => {
    const decision = resolveSubagentWorktreeDecision(ctx.config, opts.policy);
    if (decision === 'off') return opts.runner(task, ctx);
    if (!opts.worktrees) {
      if (decision === 'required') {
        throw new WorktreeIntegrationError(
          'worktree isolation is required but no WorktreeManager is configured',
          {
            taskId: task.id,
            subagentId: ctx.subagentId,
          },
        );
      }
      return opts.runner(task, ctx);
    }

    const handle = await opts.worktrees.allocate(task.id, {
      slugHint: worktreeSlugHint(task, ctx.config),
      ownerLabel: worktreeOwnerLabel(task, ctx.config),
    });

    if (handle.status !== 'active') {
      emitUpdate(opts, task, ctx, handle, {
        status: 'fallback',
        error: handle.lastError ?? 'worktree allocation failed',
      });
      if (decision === 'required') {
        throw new WorktreeIntegrationError(
          `worktree allocation failed: ${handle.lastError ?? 'unknown error'}`,
          {
            taskId: task.id,
            subagentId: ctx.subagentId,
            branch: handle.branch,
          },
        );
      }
      return opts.runner(task, ctx);
    }

    emitUpdate(opts, task, ctx, handle, { status: 'allocated' });

    const isolatedConfig: SubagentConfig = { ...ctx.config, cwd: handle.dir };
    const isolatedCtx: SubagentRunContext = { ...ctx, config: isolatedConfig };

    let outcome: SubagentRunOutcome;
    try {
      outcome = await opts.runner(task, isolatedCtx);
    } catch (err) {
      await parkFailedWorktree(opts, task, ctx, handle, err);
      throw err;
    }

    await integrateSuccessfulWorktree(opts, task, ctx, isolatedConfig, handle);
    return outcome;
  };
}

async function integrateSuccessfulWorktree(
  opts: WorktreeTaskRunnerOptions,
  task: TaskSpec,
  ctx: SubagentRunContext,
  config: SubagentConfig,
  handle: WorktreeHandle,
): Promise<void> {
  const committed = await opts.worktrees!.commitAll(
    handle,
    `subagent(${config.role ?? config.name}): ${task.id}`,
  );
  if (committed.error) {
    // The commit was refused (pre-commit hook, locked index): the work exists
    // only as uncommitted edits in the checkout. Keep it and fail the task —
    // reporting "no changes" here would silently drop the subagent's work.
    await opts.worktrees!.release(handle, { keep: true }).catch(() => undefined);
    emitUpdate(opts, task, ctx, handle, { status: 'failed', error: committed.error });
    throw new WorktreeIntegrationError(
      `worktree commit failed (work kept in ${handle.dir}): ${committed.error.trim()}`,
      { taskId: task.id, subagentId: ctx.subagentId, branch: handle.branch },
    );
  }
  if (!committed.committed) {
    await opts.worktrees!.release(handle, { keep: false });
    emitUpdate(opts, task, ctx, handle, { status: 'released' });
    return;
  }

  emitUpdate(opts, task, ctx, handle, { status: 'committed', commitSha: handle.sha });

  if (opts.policy?.autoMerge === false) {
    await opts.worktrees!.release(handle, { keep: true });
    emitUpdate(opts, task, ctx, handle, { status: 'kept', commitSha: handle.sha });
    return;
  }

  const merged = await opts.worktrees!.merge(handle, {
    squash: true,
    message: `merge subagent ${ctx.subagentId} task ${task.id} (squash)`,
    ...(opts.conflictResolver
      ? {
          resolve: (info: { conflictFiles: string[]; cwd: string }) =>
            opts.conflictResolver!({
              task,
              config,
              conflictFiles: info.conflictFiles,
              cwd: info.cwd,
            }),
        }
      : {}),
  });

  if (!merged.ok) {
    await opts.worktrees!.release(handle, { keep: true }).catch(() => undefined);
    const conflictFiles = merged.conflictFiles ?? [];
    emitUpdate(opts, task, ctx, handle, {
      status: merged.conflict ? 'conflict' : 'failed',
      commitSha: handle.sha,
      conflictFiles,
      error: merged.stderr || (merged.conflict ? 'merge conflict' : 'worktree merge failed'),
    });
    throw new WorktreeIntegrationError(
      merged.conflict
        ? `worktree merge conflict${conflictFiles.length ? `: ${conflictFiles.join(', ')}` : ''}`
        : `worktree merge failed: ${merged.stderr ?? 'unknown error'}`,
      {
        taskId: task.id,
        subagentId: ctx.subagentId,
        branch: handle.branch,
        conflictFiles,
      },
    );
  }

  await opts.worktrees!.release(handle, { keep: false });
  emitUpdate(opts, task, ctx, handle, { status: 'merged', commitSha: handle.sha });
}

async function parkFailedWorktree(
  opts: WorktreeTaskRunnerOptions,
  task: TaskSpec,
  ctx: SubagentRunContext,
  handle: WorktreeHandle,
  err: unknown,
): Promise<void> {
  let hasWork = false;
  try {
    const res = await opts.worktrees!.commitAll(
      handle,
      `subagent(${ctx.config.role ?? ctx.config.name}) failed: ${task.id}`,
    );
    // A refused commit still leaves the partial work in the checkout.
    hasWork = res.committed || Boolean(res.error);
  } catch {
    hasWork = false;
  }

  const keep = (opts.policy?.keepFailed ?? true) && hasWork;
  await opts.worktrees!.release(handle, { keep }).catch(() => undefined);
  // release() keeps a failed handle regardless of `keep`; report what is on disk.
  const kept = opts.worktrees!.get(handle.ownerId) === handle;
  emitUpdate(opts, task, ctx, handle, {
    status: kept ? 'kept' : 'released',
    commitSha: handle.sha,
    error: toErrorMessage(err),
  });
}

function emitUpdate(
  opts: WorktreeTaskRunnerOptions,
  task: TaskSpec,
  ctx: SubagentRunContext,
  handle: WorktreeHandle,
  patch: Omit<
    WorktreeTaskStateUpdate,
    'taskId' | 'subagentId' | 'handleId' | 'dir' | 'branch' | 'baseBranch'
  >,
): void {
  opts.onUpdate?.({
    taskId: task.id,
    subagentId: ctx.subagentId,
    handleId: handle.id,
    dir: handle.dir,
    branch: handle.branch,
    baseBranch: handle.baseBranch,
    ...patch,
  });
}

function worktreeSlugHint(task: TaskSpec, config: SubagentConfig): string {
  return `${config.role ?? config.name ?? 'subagent'}-${task.id}`;
}

function worktreeOwnerLabel(task: TaskSpec, config: SubagentConfig): string {
  const who = config.name || config.role || 'Subagent';
  const brief = task.description.trim().replace(/\s+/g, ' ').slice(0, 80);
  return brief ? `${who}: ${brief}` : who;
}
