import { color } from '@wrongstack/core/utils';
import {
  addCheckToTask,
  addDependency,
  addGoalMetricToTask,
  addNoteToTask,
  addTask,
  assignTask,
  claimReadyTask,
  copyTaskToBoard,
  decodeLifecycleIssues,
  getBoard,
  getTask,
  getTaskChain,
  type KanbanTask,
  listReadyTasks,
  mergeTasks,
  moveTask,
  releaseTaskClaim,
  removeTask,
  setTaskChain,
  splitTask,
  transferTaskToBoard,
  transitionTask,
  updateGoalMetricOnTask,
  updateTask,
  updateTaskAssignment,
} from '@wrongstack/kanban';
import { preflightManagedTransition } from '@wrongstack/kanban/manager/lifecycle';
import { applySessionKanbanTaskToSource } from '@wrongstack/tools/session-kanban';
import type { SlashCommandContext } from './command-context.js';
import { buildKanbanAgentPrompt, parseKanbanAgentFlags, splitCsv } from './kanban-agent-helpers.js';
import {
  formatBoardDetail,
  formatReadyTasks,
  formatTaskChain,
  formatTaskDetail,
} from './kanban-format.js';
import {
  formatLifecycleDiagnosis,
  LIFECYCLE_STAGE_ALIASES,
  parseTaskEvidenceFlags,
  resolveColumnReference,
} from './kanban-lifecycle-diagnostics.js';

export function extractSpawnedSubagentId(summary: string): string | undefined {
  return summary.match(/Spawned subagent\s+([^\s]+)/)?.[1];
}

async function syncTaskToContext(
  opts: SlashCommandContext,
  task: KanbanTask | undefined,
  options: { remove?: boolean } = {},
): Promise<void> {
  const ctx = opts.context;
  if (!ctx?.state || !task) return;
  try {
    await applySessionKanbanTaskToSource(ctx, task, options);
  } catch {
    // best-effort
  }
}

export async function handleTaskSubcommand(
  opts: SlashCommandContext,
  projectRoot: string,
  args: string[],
  showHelp: () => { message: string },
): Promise<{ message: string }> {
  const [sub, boardId, ...rest] = args;

  if (!sub) {
    return showHelp();
  }

  if (sub === 'ready') {
    const results = await listReadyTasks(projectRoot, {
      ...(boardId ? { boardId } : {}),
      limit: 50,
    });
    return { message: formatReadyTasks(results) };
  }

  if (sub === 'claim') {
    const scopedBoardId = rest.length > 0 ? boardId : undefined;
    const agentId = rest.length > 0 ? rest[0] : boardId;
    if (!agentId) {
      return { message: color.red('Usage: /kanban task claim [boardId] <agentId>') };
    }
    const result = await claimReadyTask(projectRoot, {
      ...(scopedBoardId ? { boardId: scopedBoardId } : {}),
      agentId,
      status: 'queued',
    });
    if (!result) return { message: color.yellow('No ready kanban task matched the claim.') };
    return {
      message: `${color.green('✅ Task claimed:')} ${result.task.title}\n  ${color.dim(`${result.board.id}:${result.task.id}`)}`,
    };
  }

  if (!boardId) return showHelp();

  if (sub === 'list' || sub === 'ls' || sub === '') {
    const board = await getBoard(projectRoot, boardId);
    if (!board) return { message: color.red(`Board not found: ${boardId}`) };
    return { message: formatBoardDetail(board) };
  }

  const board = await getBoard(projectRoot, boardId);
  if (!board) return { message: color.red(`Board not found: ${boardId}`) };

  if (sub === 'show') {
    const taskId = rest[0];
    if (!taskId) return { message: color.red('Usage: /kanban task show <boardId> <taskId>') };
    const task = await getTask(projectRoot, boardId, taskId);
    if (!task) return { message: color.red(`Task not found: ${taskId}`) };
    return { message: formatTaskDetail(board, task) };
  }

  if (sub === 'add') {
    const title = rest.join(' ');
    if (!title) return { message: color.red('Usage: /kanban task add <boardId> <title>') };
    const result = await addTask(projectRoot, boardId, {
      title,
      columnId: board.columns[0]?.id ?? 'backlog',
    });
    if (!result) return { message: color.red('Failed to add task') };
    await syncTaskToContext(opts, result.task);
    return {
      message: `${color.green('✅ Task added:')} ${color.bold(result.task.title)}\n  ${color.dim(result.task.id)}`,
    };
  }

  if (sub === 'move') {
    const taskId = rest[0];
    const requestedColumn = rest[1];
    if (!taskId || !requestedColumn) {
      return { message: color.red('Usage: /kanban task move <boardId> <taskId> <column>') };
    }
    const resolvedColumnId = resolveColumnReference(board, requestedColumn);
    if (!resolvedColumnId) {
      return {
        message:
          `❌ Column "${requestedColumn}" not found on this board. ` +
          `Available columns: ${board.columns.map((c) => c.id).join(', ')}, ` +
          `or use a stage alias: ${Object.keys(LIFECYCLE_STAGE_ALIASES).join(', ')}.`,
      };
    }
    const {
      attachment: moveAttachment,
      note: moveNote,
      positional: movePositionals,
      warnings: moveWarnings,
    } = parseTaskEvidenceFlags(rest.slice(2));
    if (movePositionals.length > 0 || moveWarnings.length > 0) {
      const prefix =
        movePositionals.length > 0
          ? `Unrecognized positioned arguments after task/column: ${movePositionals.join(' ')}. `
          : '';
      const warnTail = moveWarnings.length > 0 ? `Ignored flags: ${moveWarnings.join('; ')}` : '';
      return {
        message: color.red(
          `❌ /kanban task move ${boardId} ${taskId} ${resolvedColumnId}: ${prefix}${warnTail}`,
        ),
      };
    }
    if (board.lifecycle?.mode === 'managed') {
      const policy = board.lifecycle.columns;
      const stageEntry = (Object.entries(policy) as Array<[string, string]>).find(
        ([, col]) => col === resolvedColumnId,
      );
      if (!stageEntry) {
        return {
          message:
            `❌ Column "${resolvedColumnId}" is not part of the managed lifecycle. ` +
            `Allowed columns: ${Object.values(policy).join(', ')}. ` +
            `Run \`/kanban show ${boardId}\` to inspect the board's lifecycle mapping.`,
        };
      }
      const [to] = stageEntry;
      try {
        const result = await transitionTask(projectRoot, boardId, taskId, {
          to: to as 'backlog' | 'todo' | 'running' | 'review' | 'done',
          actor: 'kanban-slash:move',
          action: moveNote
            ? `${moveNote} (move → ${resolvedColumnId})`
            : `Moved to ${resolvedColumnId} via /kanban task move`,
          comment: moveNote
            ? `${moveNote} (move → ${resolvedColumnId})`
            : `Moved to ${resolvedColumnId} via /kanban task move (board=${boardId}, task=${taskId})`,
          attachment: moveAttachment
            ? {
                url: moveAttachment,
                type: 'url' as const,
                title: 'Reviewer evidence (kanban-slash)',
              }
            : undefined,
        });
        if (!result) return { message: color.red('Task not found') };
        await syncTaskToContext(opts, result.task);
        return { message: color.green(`✅ Task moved to column ${resolvedColumnId}.`) };
      } catch (err) {
        if (decodeLifecycleIssues(err).length > 0) {
          return { message: formatLifecycleDiagnosis(err, 'move') };
        }
        throw err;
      }
    }
    const updated = await moveTask(projectRoot, boardId, taskId, resolvedColumnId);
    if (!updated)
      return { message: color.red('Failed to move task. Check board/task/column IDs.') };
    await syncTaskToContext(opts, updated.tasks.find((t) => t.id === taskId));
    return { message: color.green('✅ Task moved.') };
  }

  if (sub === 'done') {
    const taskId = rest[0];
    if (!taskId) {
      return {
        message: color.red(
          'Usage: /kanban task done <boardId> <taskId> [--attachment <url>] [--note <text>]',
        ),
      };
    }
    const { attachment, note, tickChecks, positional, warnings } = parseTaskEvidenceFlags(rest.slice(1));
    if (positional.length > 0) {
      return {
        message: color.red(
          'Usage: /kanban task done <boardId> <taskId> [--attachment <url>] [--note <text>]',
        ),
      };
    }
    if (warnings.length > 0) {
      return {
        message: color.yellow(
          '⚠️  /kanban task done flag parse warnings:\n' +
            warnings.map((w) => `  - ${w}`).join('\n') +
            '\nRe-run with the flags positioned correctly before the board/task ids.',
        ),
      };
    }
    if (board.lifecycle?.mode === 'managed') {
      const stageToColumn = board.lifecycle?.columns ?? {};
      const currentColumnId = board.tasks.find((t) => t.id === taskId)?.columnId;
      const currentStage = Object.entries(stageToColumn).find(
        ([, columnId]) => columnId === currentColumnId,
      )?.[0];
      const path: readonly ('backlog' | 'todo' | 'running' | 'review' | 'done')[] | null =
        currentStage === 'backlog'
          ? (['todo', 'running', 'review', 'done'] as const)
          : currentStage === 'todo'
            ? (['running', 'review', 'done'] as const)
            : currentStage === 'running'
              ? (['review', 'done'] as const)
              : currentStage === 'review'
                ? (['done'] as const)
                : null;
      if (path === null) {
        return {
          message: color.red(
            `❌ /kanban task done could not derive a sequential path for the card's current stage (\`${currentStage ?? 'unknown'}\`). The card may be in an unrecognized lifecycle column; move it to \`review\` with \`/kanban task move\` and retry.`,
          ),
        };
      }
      const currentTask = board.tasks.find((t) => t.id === taskId);
      if (!currentTask) {
        return { message: color.red('Task not found') };
      }
      const preflightIssues: string[] = [];
      if (!note?.trim()) {
        return {
          message: color.red(
            `Refusing /kanban task ${currentStage ?? 'unknown'} → done without a reviewer note. ` +
              `Re-run with --note "<what proves the work is ready>".`,
          ),
        };
      }
      const noteText = note.trim();
      const sharedAttachment = attachment
        ? {
            url: attachment,
            type: 'url' as const,
            title: 'Reviewer evidence (kanban-slash:done)',
          }
        : undefined;
      for (const to of path) {
        const transitionInput = {
          to,
          actor: 'kanban-slash:done',
          action: `${noteText} (${to})`,
          comment: `${noteText} (${to})`,
          ...(sharedAttachment ? { attachment: sharedAttachment } : {}),
          ...(tickChecks ? { tickChecks } : {}),
        };
        const issues = preflightManagedTransition(board, currentTask, transitionInput);
        for (const issue of issues) {
          preflightIssues.push(issue.message);
        }
      }
      if (preflightIssues.length > 0) {
        return {
          message: color.red(
            `❌ /kanban task ${currentStage ?? 'unknown'} → done needs attention:\n` +
              preflightIssues.map((issue) => `  - ${issue}`).join('\n'),
          ),
        };
      }
      try {
        for (const to of path) {
          await transitionTask(projectRoot, boardId, taskId, {
            to: to as 'backlog' | 'todo' | 'running' | 'review' | 'done',
            actor: 'kanban-slash:done',
            action: noteText ? `${noteText} (${to})` : '',
            comment: noteText ? `${noteText} (${to})` : '',
            ...(attachment
              ? {
                  attachment: {
                    url: attachment,
                    type: 'url' as const,
                    title: 'Reviewer evidence (kanban-slash:done)',
                  },
                }
              : {}),
            ...(tickChecks.length > 0 ? { tickChecks } : {}),
          });
        }
        const finalBoard = await getBoard(projectRoot, boardId);
        await syncTaskToContext(opts, finalBoard?.tasks.find((t) => t.id === taskId));
        return { message: color.green('✅ Task marked completed.') };
      } catch (err) {
        if (decodeLifecycleIssues(err).length > 0) {
          return { message: formatLifecycleDiagnosis(err, 'done') };
        }
        throw err;
      }
    }
    const completedCol = board.columns.find((c) =>
      ['done', 'completed', 'finished'].includes(c.id),
    );
    const updated = await updateTask(projectRoot, boardId, taskId, {
      status: 'completed',
      ...(completedCol?.id ? { columnId: completedCol.id } : {}),
    });
    if (!updated) return { message: color.red('Task not found') };
    await syncTaskToContext(opts, updated.tasks.find((t) => t.id === taskId));
    return {
      message: color.green('✅ Task marked completed.'),
    };
  }

  if (sub === 'block') {
    const taskId = rest[0];
    if (!taskId) return { message: color.red('Usage: /kanban task block <boardId> <taskId>') };
    if (board.lifecycle?.mode === 'managed') {
      return {
        message:
          `❌ /kanban task block is not supported on managed boards. ` +
          `Managed lifecycle only knows the stages Backlog, Todo, Running, Review, Done. ` +
          `To pause work without losing audit context, free the active assignment first ` +
          `(\`/kanban task release <boardId> <taskId>\`) — releases the worker assignment but ` +
          `keeps the card in its current stage; transition it back to \`todo\` with ` +
          `\`/kanban task move <boardId> <taskId> todo\` if you want a different worker to pick it up. ` +
          `If work is genuinely stuck, add a note explaining the ` +
          `blocker (\`/kanban task note <boardId> <taskId> <reason>\`) so reviewers see the context.`,
      };
    }
    const updated = await updateTask(projectRoot, boardId, taskId, { status: 'blocked' });
    if (!updated) return { message: color.red('Task not found') };
    await syncTaskToContext(opts, updated.tasks.find((t) => t.id === taskId));
    return { message: color.yellow('🚫 Task marked blocked.') };
  }

  if (sub === 'remove' || sub === 'rm' || sub === 'delete') {
    const taskId = rest[0];
    if (!taskId) return { message: color.red('Usage: /kanban task remove <boardId> <taskId>') };
    const taskToDelete = board.tasks.find((t) => t.id === taskId);
    const updated = await removeTask(projectRoot, boardId, taskId);
    if (!updated) return { message: color.red('Task not found') };
    if (taskToDelete) {
      await syncTaskToContext(opts, taskToDelete, { remove: true });
    }
    return { message: color.green('✅ Task removed.') };
  }

  if (sub === 'release') {
    const taskId = rest[0];
    if (!taskId) return { message: color.red('Usage: /kanban task release <boardId> <taskId>') };
    const updated = await releaseTaskClaim(projectRoot, boardId, taskId, {
      reason: rest.slice(1).join(' ') || 'released from slash command',
    });
    if (!updated) return { message: color.red('Task not found') };
    return { message: color.green('✅ Task claim released.') };
  }

  if (sub === 'split') {
    const taskId = rest[0];
    const titleText = rest.slice(1).join(' ');
    const titles = titleText
      .split('|')
      .map((title) => title.trim())
      .filter(Boolean);
    if (!taskId || titles.length === 0) {
      return {
        message: color.red(
          'Usage: /kanban task split <boardId> <taskId> <child title> | <child title>',
        ),
      };
    }
    const result = await splitTask(projectRoot, boardId, taskId, {
      titles,
      chainChildren: true,
      rewireDependents: true,
    });
    if (!result) return { message: color.red('Board or task not found') };
    return {
      message: `${color.green('✅ Task split into children:')}\n${result.children
        .map((task, index) => `  ${index + 1}. ${task.title} ${color.dim(task.id.slice(0, 8))}`)
        .join('\n')}`,
    };
  }

  if (sub === 'merge') {
    const taskIds = splitCsv(rest[0] ?? '');
    const title = rest.slice(1).join(' ');
    if (taskIds.length < 2 || !title) {
      return {
        message: color.red('Usage: /kanban task merge <boardId> <taskA,taskB> <merged title>'),
      };
    }
    const result = await mergeTasks(projectRoot, boardId, {
      taskIds,
      title,
      closeSourceTasks: true,
    });
    if (!result) return { message: color.red('Board or task not found') };
    return {
      message: `${color.green('✅ Tasks merged:')} ${result.task.title}\n  ${color.dim(result.task.id)}`,
    };
  }

  if (sub === 'chain') {
    const chainSub = rest[0];
    if (chainSub === 'show') {
      const taskOrChainId = rest[1];
      if (!taskOrChainId) {
        return { message: color.red('Usage: /kanban task chain <boardId> show <taskId|chainId>') };
      }
      const result = await getTaskChain(projectRoot, boardId, taskOrChainId);
      if (!result) return { message: color.red('Chain not found') };
      return { message: formatTaskChain(result.tasks) };
    }
    const taskIds = rest;
    if (taskIds.length < 2) {
      return {
        message: color.red('Usage: /kanban task chain <boardId> <taskA> <taskB> [...]'),
      };
    }
    const result = await setTaskChain(projectRoot, boardId, {
      taskIds,
      enforceDependencies: true,
    });
    if (!result) return { message: color.red('Board or task not found') };
    return {
      message: `${color.green('✅ Chain set:')} ${result.chainId}\n${formatTaskChain(result.tasks)}`,
    };
  }

  if (sub === 'copy' || sub === 'transfer' || sub === 'move-board') {
    const taskId = rest[0];
    const targetBoardId = rest[1];
    const targetColumnId = rest[2];
    if (!taskId || !targetBoardId) {
      const action = sub === 'copy' ? 'copy' : 'transfer';
      return {
        message: color.red(
          `Usage: /kanban task ${action} <fromBoard> <taskId> <toBoard> [columnId]`,
        ),
      };
    }
    const result =
      sub === 'copy'
        ? await copyTaskToBoard(projectRoot, boardId, taskId, targetBoardId, {
            ...(targetColumnId ? { targetColumnId } : {}),
          })
        : await transferTaskToBoard(projectRoot, boardId, taskId, targetBoardId, {
            ...(targetColumnId ? { targetColumnId } : {}),
          });
    if (!result) return { message: color.red('Board or task not found') };
    return {
      message: color.green(
        `✅ Task ${sub === 'copy' ? 'copied' : 'transferred'} to ${result.targetBoard.title}: ${result.task.title}`,
      ),
    };
  }

  if (sub === 'priority' || sub === 'prio') {
    const taskId = rest[0];
    const priority = rest[1];
    if (!taskId || !priority) {
      return {
        message: color.red(
          'Usage: /kanban task priority <boardId> <taskId> <critical|high|medium|low>',
        ),
      };
    }
    const valid = ['critical', 'high', 'medium', 'low'];
    if (!valid.includes(priority)) {
      return { message: color.red(`Invalid priority. Valid: ${valid.join(', ')}`) };
    }
    const updated = await updateTask(projectRoot, boardId, taskId, {
      priority: priority as KanbanTask['priority'],
    });
    if (!updated) return { message: color.red('Task not found') };
    return { message: color.green(`✅ Priority set to ${priority}.`) };
  }

  if (sub === 'assign' || sub === 'agent') {
    const taskId = rest[0];
    const parsed = parseKanbanAgentFlags(rest.slice(1));
    const agentId = parsed.target;
    if (!taskId || !agentId) {
      return {
        message: color.red(
          'Usage: /kanban task assign <boardId> <taskId> <agentId> [--provider=p --model=m --fallback=f]',
        ),
      };
    }
    const updated = await assignTask(projectRoot, boardId, taskId, {
      agentId,
      name: parsed.flags.name,
      role: parsed.flags.role,
      provider: parsed.flags.provider,
      model: parsed.flags.model,
      fallbackProfile: parsed.flags.fallbackProfile,
      fallbackModels: parsed.flags.fallbackModels,
      tools: parsed.flags.tools,
      allowedCapabilities: parsed.flags.allowedCapabilities,
    });
    if (!updated) return { message: color.red('Task not found') };
    return {
      message: color.green(
        `✅ Assigned to ${agentId}${parsed.flags.provider || parsed.flags.model ? ` (${[parsed.flags.provider, parsed.flags.model].filter(Boolean).join(' / ')})` : ''}.`,
      ),
    };
  }

  if (sub === 'dispatch' || sub === 'run') {
    const taskId = rest[0];
    if (!taskId) {
      return {
        message: color.red(
          'Usage: /kanban task dispatch <boardId> <taskId> [--provider=p --model=m --name=n]',
        ),
      };
    }
    if (!opts.onSpawn) return { message: color.red('Multi-agent is not enabled in this session.') };
    const parsed = parseKanbanAgentFlags(rest.slice(1));
    const task = await getTask(projectRoot, boardId, taskId);
    if (!task) return { message: color.red('Task not found') };
    const freshBoard = await getBoard(projectRoot, boardId);
    if (!freshBoard) return { message: color.red(`Board not found: ${boardId}`) };
    const assignment = {
      agentId: parsed.target ?? task.assignment?.agentId ?? task.assignedAgent,
      name: parsed.flags.name ?? task.assignment?.name ?? task.assignedAgent,
      role: parsed.flags.role ?? task.assignment?.role,
      provider: parsed.flags.provider ?? task.assignment?.provider,
      model: parsed.flags.model ?? task.assignment?.model,
      fallbackProfile: parsed.flags.fallbackProfile ?? task.assignment?.fallbackProfile,
      fallbackModels: parsed.flags.fallbackModels ?? task.assignment?.fallbackModels,
      tools: parsed.flags.tools ?? task.assignment?.tools,
      allowedCapabilities: parsed.flags.allowedCapabilities ?? task.assignment?.allowedCapabilities,
      status: 'queued' as const,
      dispatchedAt: new Date().toISOString(),
    };
    await assignTask(projectRoot, boardId, taskId, assignment);
    try {
      const prompt = buildKanbanAgentPrompt(freshBoard, task, assignment);
      const summary = await opts.onSpawn(prompt, {
        ...(assignment.provider ? { provider: assignment.provider } : {}),
        ...(assignment.model ? { model: assignment.model } : {}),
        ...(assignment.fallbackModels ? { fallbackModels: assignment.fallbackModels } : {}),
        ...(assignment.tools ? { tools: assignment.tools } : {}),
        ...(assignment.name ? { name: assignment.name } : {}),
        ...(assignment.allowedCapabilities
          ? { allowedCapabilities: assignment.allowedCapabilities }
          : {}),
        context: { kanban: { boardId, taskId, projectRoot } },
      });
      const subagentId = extractSpawnedSubagentId(summary);
      await updateTaskAssignment(projectRoot, boardId, taskId, {
        ...assignment,
        status: 'running',
        ...(subagentId ? { subagentId } : {}),
        lastResult: summary,
      });
      return { message: `${color.green('✅ Kanban task dispatched.')}\n${summary}` };
    } catch (err) {
      await updateTaskAssignment(projectRoot, boardId, taskId, {
        ...assignment,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        message: color.red(`Dispatch failed: ${err instanceof Error ? err.message : String(err)}`),
      };
    }
  }

  if (sub === 'depend' || sub === 'dep') {
    const taskId = rest[0];
    const depId = rest[1];
    if (!taskId || !depId) {
      return { message: color.red('Usage: /kanban task depend <boardId> <taskId> <depTaskId>') };
    }
    const task = await getTask(projectRoot, boardId, taskId);
    if (!task) return { message: color.red('Task not found') };
    const updated = await addDependency(projectRoot, boardId, taskId, depId);
    if (!updated) return { message: color.red('Failed to add dependency') };
    return { message: color.green(`✅ Dependency added: ${task.title} → ${depId}`) };
  }

  if (sub === 'metric') {
    const metricSub = rest[0];
    const taskId = rest[1];
    if (metricSub === 'add') {
      const name = rest[2];
      const target = rest[3];
      const unit = rest[4];
      if (!taskId || !name) {
        return {
          message: color.red(
            'Usage: /kanban task metric add <boardId> <taskId> <name> [target] [unit]',
          ),
        };
      }
      const updated = await addGoalMetricToTask(projectRoot, boardId, taskId, {
        name,
        ...(target !== undefined ? { target } : {}),
        ...(unit !== undefined ? { unit } : {}),
      });
      if (!updated) return { message: color.red('Task not found') };
      return { message: color.green(`✅ Metric added: ${name}`) };
    }
    if (metricSub === 'set' || metricSub === 'update') {
      const metricId = rest[2];
      const current = rest[3];
      const status = rest[4];
      const validStatuses = ['pending', 'met', 'missed', 'waived'];
      if (!taskId || !metricId || current === undefined) {
        return {
          message: color.red(
            'Usage: /kanban task metric set <boardId> <taskId> <metricId> <current> [met|missed|waived|pending]',
          ),
        };
      }
      if (status && !validStatuses.includes(status)) {
        return { message: color.red(`Invalid metric status. Valid: ${validStatuses.join(', ')}`) };
      }
      const updated = await updateGoalMetricOnTask(projectRoot, boardId, taskId, metricId, {
        current,
        ...(status ? { status: status as 'pending' | 'met' | 'missed' | 'waived' } : {}),
      });
      if (!updated) return { message: color.red('Metric not found') };
      return { message: color.green('✅ Metric updated.') };
    }
    return {
      message: color.red('Usage: /kanban task metric add|set <boardId> <taskId> ...'),
    };
  }

  if (sub === 'note') {
    const taskId = rest[0];
    const content = rest.slice(1).join(' ');
    if (!taskId || !content) {
      return { message: color.red('Usage: /kanban task note <boardId> <taskId> <text>') };
    }
    const updated = await addNoteToTask(projectRoot, boardId, taskId, {
      author: 'user',
      content,
    });
    if (!updated) return { message: color.red('Task not found') };
    return { message: color.green('✅ Note added.') };
  }

  if (sub === 'check') {
    const checkSub = rest[0];
    const taskId = rest[1];
    if (checkSub === 'add' && taskId && rest.slice(2).join(' ')) {
      const desc = rest.slice(2).join(' ');
      const updated = await addCheckToTask(projectRoot, boardId, taskId, {
        description: desc,
        type: 'manual',
      });
      if (!updated) return { message: color.red('Task not found') };
      return { message: color.green(`✅ Check added to task: ${desc}`) };
    }
    return { message: color.red('Usage: /kanban task check add <boardId> <taskId> <description>') };
  }

  return showHelp();
}
