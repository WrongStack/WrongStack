import {
  addCheckToTask,
  addColumn,
  addDependency,
  addGoalMetricToTask,
  addNoteToTask,
  addTask,
  assignTask,
  claimReadyTask,
  copyTaskToBoard,
  createBoard,
  createBoardFromTaskGraph,
  duplicateBoard,
  exportBoardAsMarkdown,
  exportBoardToTaskGraph,
  createBoardFromText,
  getBoard,
  getKanbanOrchestrationSnapshot,
  getTask,
  getTaskChain,
  type KanbanTask,
  listReadyTasks,
  listBoards,
  mergeTasks,
  moveTask,
  parseLinesIntoTasks,
  removeBoard,
  removeColumn,
  removeTask,
  releaseTaskClaim,
  setTaskChain,
  splitTask,
  syncBoardFromTaskGraph,
  transferTaskToBoard,
  updateBoard as updateBoardManager,
  updateGoalMetricOnTask,
  updateTask,
  updateTaskAssignment,
} from '@wrongstack/kanban';
import { color } from '@wrongstack/core/utils';
import type { SlashCommand } from '@wrongstack/core/types';
import { TaskGraphStore } from '@wrongstack/sdd';
import { parseSubcommand, unknownSubcommand } from './helpers.js';
import type { SlashCommandContext } from './command-context.js';
import {
  DIM,
  formatBoardDetail,
  formatBoardList,
  formatDependencyChain,
  formatKanbanSnapshot,
  formatReadyTasks,
  formatTaskChain,
  formatTaskDetail,
  fmtAge,
  HEADING,
  LABEL,
} from './kanban-format.js';
import {
  buildKanbanAgentPrompt,
  parseKanbanAgentFlags,
  splitCsv,
} from './kanban-agent-helpers.js';
import { KANBAN_COMMAND_HELP } from './kanban-help.js';

// ── Command builder ─────────────────────────────────────────────────────

export function buildKanbanCommand(opts: SlashCommandContext): SlashCommand {
  const { projectRoot } = opts;

  return {
    name: 'kanban',
    category: 'Run',
    aliases: ['kb', 'board'],
    description: 'Multi-kanban board management. Create, view, edit, auto-generate boards.',
    help: KANBAN_COMMAND_HELP,
    async run(args: string) {
      const showHelp = () => ({ message: buildKanbanCommand(opts).help ?? '' });

      if (!projectRoot) {
        return { message: color.red('No project root available. Open a project first.') };
      }

      const { cmd, rest } = parseSubcommand(args ?? '');
      const restJoined = rest.join(' ').trim();

      // ── No args — list boards ──────────────────────────────────────
      if (!cmd) {
        const boards = await listBoards(projectRoot);
        return { message: formatBoardList(boards) };
      }

      // ── open TUI panel ─────────────────────────────────────────────
      if (cmd === 'open' || cmd === 'panel' || cmd === 'tui') {
        const opened = opts.onPanelOpen.current?.('toggleKanbanPanel') ?? false;
        return {
          message: opened
            ? color.green('Kanban panel opened.')
            : color.yellow('Kanban panel is only available in the TUI.'),
        };
      }

      // ── create ─────────────────────────────────────────────────────
      if (cmd === 'create') {
        if (!restJoined) return { message: color.red('Usage: /kanban create <title>') };
        const board = await createBoard(projectRoot, { title: restJoined });
        return {
          message: `${color.green('✅ Board created:')} ${color.bold(board.title)}\n  ${color.dim(board.id)}`,
        };
      }

      // ── duplicate ─────────────────────────────────────────────────
      if (cmd === 'duplicate' || cmd === 'copy-board') {
        const boardId = rest[0];
        if (!boardId) return { message: color.red('Usage: /kanban duplicate <boardId> [title]') };
        const board = await duplicateBoard(projectRoot, boardId, {
          ...(rest.length > 1 ? { title: rest.slice(1).join(' ') } : {}),
        });
        if (!board) return { message: color.red(`Board not found: ${boardId}`) };
        return {
          message: `${color.green('✅ Board duplicated:')} ${color.bold(board.title)}\n  ${color.dim(board.id)}`,
        };
      }

      // ── show ───────────────────────────────────────────────────────
      if (cmd === 'show') {
        if (!rest[0]) return showHelp();
        const board = await getBoard(projectRoot, rest[0]!);
        if (!board) return { message: color.red(`Board not found: ${rest[0]}`) };
        return { message: formatBoardDetail(board) };
      }

      // ── delete ─────────────────────────────────────────────────────
      if (cmd === 'delete' || cmd === 'rm') {
        if (!rest[0]) return { message: color.red('Usage: /kanban delete <boardId>') };
        const removed = await removeBoard(projectRoot, rest[0]!);
        return {
          message: removed
            ? color.green(`✅ Board deleted: ${rest[0]}`)
            : color.red(`Board not found: ${rest[0]}`),
        };
      }

      // ── prune ──────────────────────────────────────────────────────
      // Retention relief for run-mirror accumulation: every fleet/AutoPhase
      // run mirrors into a board and nothing deletes them, so long-lived
      // projects collect thousands. Dry-run by default; --yes applies.
      if (cmd === 'prune') {
        const flags = new Set(rest.filter((t) => t.startsWith('--') || t === '-y'));
        const positional = rest.filter((t) => !t.startsWith('--') && t !== '-y');
        const days = positional[0] ? Number(positional[0]) : 7;
        if (!Number.isFinite(days) || days < 0) {
          return { message: color.red('Usage: /kanban prune [days>=0] [--all] [--yes]') };
        }
        const includeUnfinished = flags.has('--all');
        const apply = flags.has('--yes') || flags.has('-y');
        const cutoff = Date.now() - days * 86_400_000;

        const boards = await listBoards(projectRoot);
        const stale = boards.filter((b) => {
          const updatedAt = Date.parse(b.updatedAt);
          if (!Number.isFinite(updatedAt) || updatedAt > cutoff) return false;
          if (includeUnfinished) return true;
          return b.taskCount === 0 || b.completedTaskCount === b.taskCount;
        });
        if (stale.length === 0) {
          return {
            message: color.green(
              `Nothing to prune: no ${includeUnfinished ? '' : 'finished/empty '}boards idle ≥ ${days}d (of ${boards.length} total).`,
            ),
          };
        }

        if (!apply) {
          const preview = stale
            .slice(0, 20)
            .map(
              (b) =>
                `  ${LABEL(b.id.slice(0, 8))}  ${b.title.slice(0, 48)}  ${DIM(`${b.taskCount} tasks · updated ${fmtAge(b.updatedAt)}`)}`,
            );
          if (stale.length > 20) preview.push(DIM(`  … and ${stale.length - 20} more`));
          return {
            message: [
              HEADING(
                `Would prune ${stale.length} of ${boards.length} boards (idle ≥ ${days}d${includeUnfinished ? ', including unfinished' : ', finished/empty only'})`,
              ),
              ...preview,
              '',
              DIM(`Run /kanban prune ${positional[0] ?? days}${includeUnfinished ? ' --all' : ''} --yes (or -y) to delete.`),
            ].join('\n'),
          };
        }

        let removed = 0;
        let failed = 0;
        for (const b of stale) {
          if (await removeBoard(projectRoot, b.id)) removed++;
          else failed++;
        }
        const parts = [
          `✅ Pruned ${removed} board${removed === 1 ? '' : 's'} (${boards.length - removed} remain).`,
        ];
        if (failed > 0) {
          parts.push(color.yellow(`${failed} board${failed === 1 ? '' : 's'} could not be deleted — check file permissions or HQ sync locks.`));
        }
        return { message: color.green(parts.join(' ')) };
      }

      // ── rename ──────────────────────────────────────────────────────
      if (cmd === 'rename') {
        if (rest.length < 2)
          return { message: color.red('Usage: /kanban rename <boardId> <title>') };
        const boardId = rest[0]!;
        const newTitle = rest.slice(1).join(' ');
        const updated = await updateBoardManager(projectRoot, boardId, { title: newTitle });
        if (!updated) return { message: color.red(`Board not found: ${boardId}`) };
        return { message: color.green(`✅ Board renamed to: ${newTitle}`) };
      }

      // ── generate ───────────────────────────────────────────────────
      if (cmd === 'generate') {
        if (!restJoined) return { message: color.red('Usage: /kanban generate <description>') };
        const genInput = createBoardFromText({ description: restJoined });
        const board = await createBoard(projectRoot, genInput);
        const tasks = parseLinesIntoTasks(restJoined, board.columns[0]?.id ?? 'backlog');
        for (const taskInput of tasks) {
          await addTask(projectRoot, board.id, taskInput);
        }
        return {
          message: `${color.green('✅ Board generated:')} ${color.bold(board.title)}\n  ${color.dim(board.id)}\n  ${board.tasks.length + tasks.length} tasks created`,
        };
      }

      // ── snapshot ───────────────────────────────────────────────────
      if (cmd === 'snapshot' || cmd === 'queue') {
        const snapshot = await getKanbanOrchestrationSnapshot(projectRoot, {
          ...(rest[0] ? { boardId: rest[0] } : {}),
        });
        return { message: formatKanbanSnapshot(snapshot) };
      }

      // ── export ─────────────────────────────────────────────────────
      if (cmd === 'export') {
        if (!rest[0]) return { message: color.red('Usage: /kanban export <boardId>') };
        const board = await getBoard(projectRoot, rest[0]!);
        if (!board) return { message: color.red(`Board not found: ${rest[0]}`) };
        return { message: exportBoardAsMarkdown(board) };
      }

      // ── graph bridge ───────────────────────────────────────────────
      if (cmd === 'graph' || cmd === 'taskgraph') {
        return handleGraphSubcommand(opts, projectRoot, rest, showHelp);
      }

      // ── deps / dependency chain ────────────────────────────────────
      if (cmd === 'deps' || cmd === 'dependencies') {
        if (rest.length < 2)
          return { message: color.red('Usage: /kanban deps <boardId> <taskId>') };
        const board = await getBoard(projectRoot, rest[0]!);
        if (!board) return { message: color.red(`Board not found: ${rest[0]}`) };
        return { message: formatDependencyChain(board, rest[1]!) };
      }

      // ── Subcommands: task / column ─────────────────────────────────
      if (cmd === 'task' || cmd === 't') {
        return handleTaskSubcommand(opts, projectRoot, rest, showHelp);
      }

      if (cmd === 'column' || cmd === 'col' || cmd === 'c') {
        return handleColumnSubcommand(projectRoot, rest, showHelp);
      }

      return {
        message: unknownSubcommand(
          cmd,
          [
            'open',
            'create',
            'duplicate',
            'show',
            'delete',
            'prune',
            'rename',
            'generate',
            'snapshot',
            'export',
            'graph',
            'deps',
            'task',
            'column',
          ],
          'kanban',
        ),
      };
    },
  };
}

// ── TaskGraph bridge subcommand handler ─────────────────────────────────

async function handleGraphSubcommand(
  opts: SlashCommandContext,
  projectRoot: string,
  args: string[],
  showHelp: () => { message: string },
) {
  const [sub, first, second] = args;
  if (!sub) return showHelp();
  if (!opts.paths?.projectTaskGraphs) {
    return { message: color.red('TaskGraph store path is not available in this session.') };
  }
  const store = new TaskGraphStore({ baseDir: opts.paths.projectTaskGraphs });

  if (sub === 'export') {
    const boardId = first;
    const graphId = second;
    if (!boardId) {
      return { message: color.red('Usage: /kanban graph export <boardId> [graphId]') };
    }
    const exported = await exportBoardToTaskGraph(projectRoot, boardId, {
      ...(graphId ? { graphId } : {}),
    });
    if (!exported) return { message: color.red(`Board not found: ${boardId}`) };
    await store.save(exported.graph);
    return {
      message: `${color.green('✅ TaskGraph exported:')} ${exported.graph.id}\n  ${exported.graph.nodes.size} node(s) saved from ${exported.board.title}`,
    };
  }

  if (sub === 'import') {
    const graphId = first;
    if (!graphId) return { message: color.red('Usage: /kanban graph import <graphId>') };
    const graph = await store.load(graphId);
    if (!graph) return { message: color.red(`TaskGraph not found: ${graphId}`) };
    const imported = await createBoardFromTaskGraph(projectRoot, graph, {
      sourceSystem: 'sdd',
      includeCompletedTasks: true,
    });
    return {
      message: `${color.green('✅ Kanban board imported:')} ${imported.board.title}\n  ${color.dim(imported.board.id)} · ${imported.board.tasks.length} task(s)`,
    };
  }

  if (sub === 'sync') {
    const boardId = first;
    const graphId = second;
    if (!boardId || !graphId) {
      return { message: color.red('Usage: /kanban graph sync <boardId> <graphId>') };
    }
    const graph = await store.load(graphId);
    if (!graph) return { message: color.red(`TaskGraph not found: ${graphId}`) };
    const result = await syncBoardFromTaskGraph(projectRoot, boardId, graph, {
      sourceSystem: 'sdd',
      includeCompletedTasks: true,
    });
    if (!result) return { message: color.red(`Board not found: ${boardId}`) };
    return {
      message: `${color.green('✅ Kanban board synced:')} ${result.board.title}\n  ${result.createdTaskIds.length} created · ${result.updatedTaskIds.length} updated · ${result.archivedTaskIds.length} archived`,
    };
  }

  return { message: color.red('Usage: /kanban graph export|import|sync ...') };
}

// ── Task subcommand handler ─────────────────────────────────────────────

async function handleTaskSubcommand(
  opts: SlashCommandContext,
  projectRoot: string,
  args: string[],
  showHelp: () => { message: string },
) {
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

  // ── List tasks on a board ──────────────────────────────────────────
  if (sub === 'list' || sub === 'ls' || sub === '') {
    const board = await getBoard(projectRoot, boardId);
    if (!board) return { message: color.red(`Board not found: ${boardId}`) };
    return { message: formatBoardDetail(board) };
  }

  const board = await getBoard(projectRoot, boardId);
  if (!board) return { message: color.red(`Board not found: ${boardId}`) };

  // ── Show task details ──────────────────────────────────────────────
  if (sub === 'show') {
    const taskId = rest[0];
    if (!taskId) return { message: color.red('Usage: /kanban task show <boardId> <taskId>') };
    const task = await getTask(projectRoot, boardId, taskId);
    if (!task) return { message: color.red(`Task not found: ${taskId}`) };
    return { message: formatTaskDetail(board, task) };
  }

  // ── Add task ───────────────────────────────────────────────────────
  if (sub === 'add') {
    const title = rest.join(' ');
    if (!title) return { message: color.red('Usage: /kanban task add <boardId> <title>') };
    const result = await addTask(projectRoot, boardId, {
      title,
      columnId: board.columns[0]?.id ?? 'backlog',
    });
    if (!result) return { message: color.red('Failed to add task') };
    return {
      message: `${color.green('✅ Task added:')} ${color.bold(result.task.title)}\n  ${color.dim(result.task.id)}`,
    };
  }

  // ── Move task to column ───────────────────────────────────────────
  if (sub === 'move') {
    const taskId = rest[0];
    const columnId = rest[1];
    if (!taskId || !columnId) {
      return { message: color.red('Usage: /kanban task move <boardId> <taskId> <columnId>') };
    }
    const updated = await moveTask(projectRoot, boardId, taskId, columnId);
    if (!updated)
      return { message: color.red('Failed to move task. Check board/task/column IDs.') };
    return { message: color.green('✅ Task moved.') };
  }

  // ── Mark done ──────────────────────────────────────────────────────
  if (sub === 'done') {
    const taskId = rest[0];
    if (!taskId) return { message: color.red('Usage: /kanban task done <boardId> <taskId>') };
    const completedCol = board.columns.find((c) =>
      ['done', 'completed', 'finished'].includes(c.id),
    );
    const updated = await updateTask(projectRoot, boardId, taskId, {
      status: 'completed',
      ...(completedCol?.id ? { columnId: completedCol.id } : {}),
    });
    if (!updated) return { message: color.red('Task not found') };
    return { message: color.green('✅ Task marked completed.') };
  }

  // ── Mark blocked ──────────────────────────────────────────────────
  if (sub === 'block') {
    const taskId = rest[0];
    if (!taskId) return { message: color.red('Usage: /kanban task block <boardId> <taskId>') };
    const updated = await updateTask(projectRoot, boardId, taskId, { status: 'blocked' });
    if (!updated) return { message: color.red('Task not found') };
    return { message: color.yellow('🚫 Task marked blocked.') };
  }

  // ── Remove task ────────────────────────────────────────────────────
  if (sub === 'remove' || sub === 'rm' || sub === 'delete') {
    const taskId = rest[0];
    if (!taskId) return { message: color.red('Usage: /kanban task remove <boardId> <taskId>') };
    const updated = await removeTask(projectRoot, boardId, taskId);
    if (!updated) return { message: color.red('Task not found') };
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

  // ── Split task into children ───────────────────────────────────────
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

  // ── Merge tasks ────────────────────────────────────────────────────
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

  // ── Ordered chain ──────────────────────────────────────────────────
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

  // ── Copy/transfer task across kanban boards ───────────────────────
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

  // ── Set priority ──────────────────────────────────────────────────
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

  // ── Assign agent ──────────────────────────────────────────────────
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

  // ── Dispatch task to an agent ─────────────────────────────────────
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
        // Carry the kanban identity into the spawned TaskSpec.context so the
        // tool-runtime boundary gate (`evaluateToolKanbanBoundary`) can resolve
        // the live board/task policy instead of failing open.
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

  // ── Add dependency ────────────────────────────────────────────────
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

  // ── Goal metric ────────────────────────────────────────────────────
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

  // ── Note ──────────────────────────────────────────────────────────
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

  // ── Check (success criteria) ──────────────────────────────────────
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

// ── Column subcommand handler ───────────────────────────────────────────

async function handleColumnSubcommand(
  projectRoot: string,
  args: string[],
  showHelp: () => { message: string },
) {
  const [sub, boardId, ...rest] = args;

  if (!sub || !boardId) return showHelp();

  // ── Add column ──────────────────────────────────────────────────────
  if (sub === 'add') {
    const title = rest.join(' ');
    if (!title) return { message: color.red('Usage: /kanban column add <boardId> <title>') };
    const result = await addColumn(projectRoot, boardId, { title });
    if (!result) return { message: color.red(`Board not found: ${boardId}`) };
    return { message: color.green(`✅ Column added: ${result.column.title}`) };
  }

  // ── Remove column ───────────────────────────────────────────────────
  if (sub === 'rm' || sub === 'remove' || sub === 'delete') {
    const colId = rest[0];
    if (!colId) return { message: color.red('Usage: /kanban column rm <boardId> <columnId>') };
    const updated = await removeColumn(projectRoot, boardId, colId, {
      moveTasksToColumnId: rest[1],
    });
    if (!updated) return { message: color.red(`Column not found: ${colId}`) };
    return { message: color.green(`✅ Column removed: ${colId}`) };
  }

  return showHelp();
}

function extractSpawnedSubagentId(summary: string): string | undefined {
  return summary.match(/Spawned subagent\s+([^\s]+)/)?.[1];
}
