import type { SlashCommand } from '@wrongstack/core/types';
import { color } from '@wrongstack/core/utils';
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
  createBoardFromText,
  decodeLifecycleIssues,
  duplicateBoard,
  exportBoardAsMarkdown,
  exportBoardToTaskGraph,
  getBoard,
  getKanbanOrchestrationSnapshot,
  getTask,
  getTaskChain,
  type KanbanBoard,
  type KanbanTask,
  listBoards,
  listReadyTasks,
  mergeTasks,
  moveTask,
  parseLinesIntoTasks,
  releaseTaskClaim,
  removeBoard,
  removeColumn,
  removeTask,
  setTaskChain,
  splitTask,
  syncBoardFromTaskGraph,
  transferTaskToBoard,
  transitionTask,
  updateBoard as updateBoardManager,
  updateGoalMetricOnTask,
  updateTask,
  updateTaskAssignment,
} from '@wrongstack/kanban';
import { TaskGraphStore } from '@wrongstack/sdd';
import type { SlashCommandContext } from './command-context.js';
import { parseSubcommand, unknownSubcommand } from './helpers.js';
import { buildKanbanAgentPrompt, parseKanbanAgentFlags, splitCsv } from './kanban-agent-helpers.js';
import {
  DIM,
  fmtAge,
  formatBoardDetail,
  formatBoardList,
  formatDependencyChain,
  formatKanbanSnapshot,
  formatReadyTasks,
  formatTaskChain,
  formatTaskDetail,
  HEADING,
  LABEL,
} from './kanban-format.js';
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
              DIM(
                `Run /kanban prune ${positional[0] ?? days}${includeUnfinished ? ' --all' : ''} --yes (or -y) to delete.`,
              ),
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
          parts.push(
            color.yellow(
              `${failed} board${failed === 1 ? '' : 's'} could not be deleted — check file permissions or HQ sync locks.`,
            ),
          );
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
    const requestedColumn = rest[1];
    if (!taskId || !requestedColumn) {
      return { message: color.red('Usage: /kanban task move <boardId> <taskId> <column>') };
    }
    // Accept both concrete column ids and the friendly aliases documented in
    // `formatLifecycleDiagnosis`. The lifecycle owner here is the board, so we
    // resolve against board.columns *and* the lifecycle stage names — a user
    // typing `move <board> <task> review` does not have to know the board
    // renamed its "Review" column to "in-review".
    const resolvedColumnId = resolveColumnReference(board, requestedColumn);
    if (!resolvedColumnId) {
      return {
        message:
          `❌ Column "${requestedColumn}" not found on this board. ` +
          `Available columns: ${board.columns.map((c) => c.id).join(', ')}, ` +
          `or use a stage alias: ${Object.keys(LIFECYCLE_STAGE_ALIASES).join(', ')}.`,
      };
    }
    // Forward optional reviewer evidence from CLI flags. The lifecycle
    // `validateReviewEvidence` gate requires an attachment URL when moving
    // into the review column; without it the move is rejected. We also
    // forward the caller's note as the audit comment so the lifecycle
    // ledger records what the worker actually did, and we surface
    // any warnings or positional leftovers from the parser so the user
    // sees typos up front instead of a silent stub.
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
    // Managed boards require the move to go through the lifecycle gate so
    // status, column, and the audit ledger move together. A free-form
    // moveTask call would either be rejected by the patch guard (for column
    // mutations) or silently desync status from the column.
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
          actor: 'kanban-slash',
          action: `Moved to ${resolvedColumnId} via /kanban task move`,
          comment: moveNote
            ? `${moveNote} (move → ${resolvedColumnId})`
            : `/kanban task move ${resolvedColumnId} (was ${taskId} on board ${boardId})`,
          // Reviewers require a non-empty attachment URL to advance into review.
          // Forward the caller's `--attachment`; if missing, the move must fail at
          // `validateReviewEvidence` so the audit ledger never records a fabricated
          // stub as a real reviewer attachment.
          attachment: moveAttachment
            ? {
                url: moveAttachment,
                type: 'url' as const,
                title: 'Reviewer evidence (kanban-slash)',
              }
            : undefined,
        });
        if (!result) return { message: color.red('Task not found') };
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
    return { message: color.green('✅ Task moved.') };
  }

  // ── Mark done ──────────────────────────────────────────────────────
  if (sub === 'done') {
    const taskId = rest[0];
    if (!taskId) {
      return {
        message: color.red(
          'Usage: /kanban task done <boardId> <taskId> [--attachment <url>] [--note <text>]',
        ),
      };
    }
    // Parse optional evidence flags. Managed boards' Done gate requires both
    // an attachment (URL) and a non-blank action text on the transition; the
    // optional `--note` lets the operator pass a short reviewer note as the
    // action, and `--attachment` provides the evidence URL.
    const { attachment, note, positional, warnings } = parseTaskEvidenceFlags(rest.slice(1));
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
    // Managed boards own the lifecycle; updateTask would silently strip the
    // patch guard and skip every evidence check. Route through transitionTask
    // so the column/status/lifecycle ledger move atomically, and surface a
    // readable diagnosis if the guard rejects us (missing assignee, criteria
    // not met, missing evidence attachment, etc.).
    if (board.lifecycle?.mode === 'managed') {
      // The lifecycle gate is adjacent-only: a card parked in `todo`,
      // `running`, or even `backlog` cannot jump straight to `done`. Walk
      // the column graph one hop at a time so each gate (running ownership,
      // review evidence, done evidence) runs as designed and surfaces its
      // own actionable diagnostic instead of a generic "transition skipped".
      const stageToColumn = board.lifecycle?.columns ?? {};
      const currentColumnId = board.tasks.find((t) => t.id === taskId)?.columnId;
      const currentStage = Object.entries(stageToColumn).find(
        ([, columnId]) => columnId === currentColumnId,
      )?.[0];
      // Adjacent-only gate: each lifecycle stage can only hop to the next
      // owner. `backlog → done` is rejected, so the path must walk
      // `backlog → todo → running → review → done` (4 hops) instead of
      // jumping straight to `running`. `todo` skips its own origin and
      // walks `running → review → done` (3 hops).
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
      // Preflight every stage's evidence gate in one pass before mutating
      // the board: lifecycle transitions commit independently, so a partial
      // path leaves the card stuck mid-flow and a corrupt audit history.
      // Mirrors the rules in `validateRunningOwnership`,
      // `validateReviewEvidence`, and `validateDoneEvidence` so the user
      // sees one readable diagnostic instead of a half-applied transition.
      const preflightIssues: string[] = [];
      const needsRunningEvidence = path.includes('running');
      const needsReviewEvidence = path.includes('review');
      const needsDoneEvidence = path.includes('done');
      const currentTask = board.tasks.find((t) => t.id === taskId);
      if (!currentTask) {
        return { message: color.red('Task not found') };
      }
      if (needsRunningEvidence) {
        const assignment = currentTask.assignment;
        const hasLease =
          assignment?.status === 'running' &&
          [
            assignment.leaseId,
            assignment.claimedAt,
            assignment.heartbeatAt,
            assignment.leaseExpiresAt,
          ].every((value) => typeof value === 'string' && value.trim().length > 0);
        if (!hasLease) {
          preflightIssues.push(
            'The /kanban task done path needs the card to already be Running with lease metadata; move it into Running first via /kanban task assign or /kanban task dispatch.',
          );
        }
      }
      if (needsReviewEvidence && !attachment) {
        preflightIssues.push(
          'Review evidence requires --attachment <url>; re-run `/kanban task done <boardId> <taskId> --attachment https://example.test/review --note "..."`.',
        );
      } else if (needsReviewEvidence && !currentTask.assignment?.lastResult) {
        preflightIssues.push(
          'Review evidence requires the card to carry an assignment.lastResult; dispatch the worker through the agentic supervisor so it records implementation output.',
        );
      }
      if (needsDoneEvidence) {
        if (!attachment) {
          preflightIssues.push(
            'Done requires --attachment <url>; re-run with --attachment https://example.test/review --note "verified".',
          );
        }
        const criteria = currentTask.successCriteria ?? [];
        if (criteria.length === 0 || criteria.some((check) => check.status !== 'passed')) {
          preflightIssues.push(
            'Done requires every acceptance criterion to be explicitly passed; update them on the card before re-running.',
          );
        }
        if (currentTask.atomic && currentTask.verificationReport?.verdict !== 'passed') {
          preflightIssues.push(
            'Atomic tasks require a passed verification report; run `kanban.verify_completion` on the task before `/kanban task done`.',
          );
        }
        if (currentTask.atomic && currentTask.childTaskIds && currentTask.childTaskIds.length > 0) {
          const childTasks = board.tasks.filter((entry) =>
            currentTask.childTaskIds!.includes(entry.id),
          );
          const missingChildren = currentTask.childTaskIds.filter(
            (childId) => !childTasks.some((entry) => entry.id === childId),
          );
          if (missingChildren.length > 0) {
            preflightIssues.push(
              `Atomic parent references unresolved children (${missingChildren.join(', ')}); resolve them via the kanban tool before retrying.`,
            );
          }
          const incompleteChildren = childTasks.filter((child) => child.status !== 'completed');
          if (incompleteChildren.length > 0) {
            const ids = incompleteChildren.map((child) => child.id).join(', ');
            preflightIssues.push(
              `Atomic parent's children must be completed before the parent can advance to Done (pending: ${ids}).`,
            );
          }
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
            actor: 'kanban-slash',
            action: note ?? `Marked done via /kanban task done (${to})`,
            comment: note ?? `Marked done via /kanban task done (${to})`,
            ...(attachment
              ? {
                  attachment: {
                    url: attachment,
                    type: 'url' as const,
                    title: 'Reviewer evidence (kanban-slash)',
                  },
                }
              : {}),
          });
        }
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
    return {
      message: color.green('✅ Task marked completed.'),
    };
  }

  // ── Mark blocked ──────────────────────────────────────────────────
  if (sub === 'block') {
    const taskId = rest[0];
    if (!taskId) return { message: color.red('Usage: /kanban task block <boardId> <taskId>') };
    // "blocked" is a card status but NOT a managed lifecycle stage. On a
    // managed board the lifecycle owns column/status/audit moves, and there
    // is no "blocked" column in the Backlog→Todo→Running→Review→Done chain.
    // We surface a clear diagnosis instead of letting `updateTask` fail with
    // a generic "Task not found" — that's the original symptom.
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

/**
 * Translate a managed-lifecycle guard failure into a user-readable diagnosis.
 *
 * Managed boards refuse lifecycle mutations that would skip a stage, skip
 * evidence, or leave required card details (description / assignee /
 * acceptance criteria, plus childTaskIds on an atomic parent) empty. Without
 * translation, the raw
 * `KanbanLifecycleError.issues[0].message` is technically truthful but reads
 * like a stack trace to a `/kanban` operator.
 *
 * The `action` parameter names the slash subcommand the user just invoked
 * (e.g. "done"), so the diagnosis can say what they tried and what they
 * should do instead. Issues that map to known recovery commands get a
 * specific suggestion; everything else falls back to the lifecycle message
 * with the issue field for context.
 */
function formatLifecycleDiagnosis(err: unknown, action: string): string {
  // Recover structured issues whether the error is the typed class (in-process
  // tests) or a plain Error whose message carries the IPC-encoded payload.
  const issues = decodeLifecycleIssues(err);
  const message = err instanceof Error ? err.message : String(err);
  const issue = issues[0];
  if (!issue) return `❌ /kanban task ${action} rejected: ${message}`;
  const field = issue.field ?? 'lifecycle';
  switch (issue.code) {
    case 'task-detail-missing':
      if (field === 'description') {
        return (
          `❌ /kanban task ${action} needs a task description first. ` +
          `Add one via the \`kanban.update_task\` tool action (patch.description = "...").`
        );
      }
      if (field === 'assignee') {
        return (
          `❌ /kanban task ${action} needs an assignee. ` +
          `Run \`/kanban task assign <boardId> <taskId> <agent>\` first.`
        );
      }
      // `dueDate` and `labels` had branches here. Neither
      // `validateRequiredCardDetails` nor the queue classifier emits those
      // fields any more, so both were unreachable — and keeping them alive
      // taught operators to satisfy a gate that no longer exists.
      if (field === 'childTaskIds') {
        return (
          `❌ /kanban task ${action} is an atomic parent with no persisted children. ` +
          `Decompose it via the kanban tool (\`split_atomic\`) before moving it forward.`
        );
      }
      if (field === 'successCriteria') {
        return (
          `❌ /kanban task ${action} needs explicit acceptance criteria. ` +
          `Add at least one via \`/kanban task check add <boardId> <taskId> <description>\`.`
        );
      }
      if (field === 'actor' || field === 'comment') {
        return (
          `❌ /kanban task ${action} was rejected by the lifecycle guard with an internal ` +
          `audit requirement (${field}). This is a wrongstack-cli bug — please report it ` +
          `along with the exact command you ran.`
        );
      }
      break;
    case 'review-evidence-missing':
      if (action === 'done' && issue.field === 'verificationReport') {
        // Atomic tasks gate Done on a passed verification report — the slash
        // command cannot synthesise one, so the user must invoke the tool.
        return (
          `❌ /kanban task done requires a passing verification report for atomic tasks. ` +
          `Run the kanban tool's \`verify_completion\` action \`<boardId> <taskId>\` first; ` +
          `only an atomic task whose verdict is "passed" can advance to Done.`
        );
      }
      if (action === 'done') {
        // Non-atomic tasks gate Done on reviewer evidence the slash command
        // already accepts; the user just needs to attach it.
        return (
          `❌ /kanban task done needs reviewer action text + an evidence attachment. ` +
          `Re-run with \`/kanban task done <boardId> <taskId> --attachment <url> --note <text>\`; ` +
          `the slash command forwards those flags to the transition.`
        );
      }
      if (issue.field === 'verificationReport') {
        return (
          `❌ /kanban task ${action} requires a passing verification report. ` +
          `Run the kanban tool's \`verify_completion\` action \`<boardId> <taskId>\` ` +
          `before retrying; only an atomic task with verdict 'passed' can advance.`
        );
      }
      return (
        `❌ /kanban task ${action} needs a persisted implementation result + evidence attachment. ` +
        `Run the kanban tool's \`verify_completion\` action \`<boardId> <taskId>\` before moving the card forward.`
      );
    case 'transition-skipped':
      return (
        `❌ /kanban task ${action} skipped a managed lifecycle stage. ` +
        `Cards on managed boards must move exactly one column at a time ` +
        `(Backlog → Todo → Running → Review → Done). Use the transition UI or the ` +
        `kanban tool's transition_task action instead of jumping columns.`
      );
    case 'parent-child-incomplete':
      return `❌ /kanban task ${action} blocked by incomplete children: ${issue.message}`;
    case 'stage-mismatch':
      return (
        `❌ /kanban task ${action} hit a stage mismatch. The card's column and its ` +
        `lifecycle.currentStage disagree. Run the kanban tool's ` +
        `\`repair_managed_task_projection\` action \`<boardId> <taskId>\` to reconcile.`
      );
    case 'managed-policy-invalid':
      return (
        `❌ /kanban task ${action} cannot run on this board: ${issue.message}. ` +
        `Managed lifecycle requires columns named exactly Backlog, Todo, In-Progress, Review, Done.`
      );
    case 'acceptance-criteria-incomplete':
      return `❌ /kanban task ${action} has unpassed acceptance criteria: ${issue.message}`;
  }
  return `❌ /kanban task ${action} rejected by lifecycle guard (${issue.code}, ${field}): ${issue.message}`;
}

/**
 * Friendly aliases for the managed lifecycle stages. The slash operator does
 * not have to remember the exact column id the board adopted; typing `move
 * <board> <task> review` works as long as the board has any column mapped to
 * the Review stage. Keys are normalised to lowercase before lookup.
 */
const LIFECYCLE_STAGE_ALIASES: Record<string, string> = {
  backlog: 'backlog',
  todo: 'todo',
  running: 'running',
  'in-progress': 'running',
  inprogress: 'running',
  review: 'review',
  done: 'done',
  completed: 'done',
};

/**
 * Resolve a user-supplied column reference against (a) the board's actual
 * columns and (b) the managed-lifecycle stage aliases. Returns the real
 * columnId the move target must use, or null if no match exists.
 *
 * Aliases are only consulted as a fallback — a board column whose id happens
 * to be "review" wins over the lifecycle alias so the behaviour is stable on
 * plain boards too.
 */
function resolveColumnReference(board: KanbanBoard, requested: string): string | null {
  const lower = requested.trim().toLowerCase();
  const exact = board.columns.find((column) => column.id === requested);
  if (exact) return exact.id;
  const caseInsensitive = board.columns.find((column) => column.id.toLowerCase() === lower);
  if (caseInsensitive) return caseInsensitive.id;
  if (board.lifecycle?.mode === 'managed') {
    const aliasStage = LIFECYCLE_STAGE_ALIASES[lower];
    if (aliasStage) {
      const mapped = board.lifecycle?.columns[aliasStage as keyof typeof board.lifecycle.columns] as
        | string
        | undefined;
      if (mapped) return mapped;
    }
  }
  return null;
}

interface TaskEvidenceFlags {
  attachment?: string | undefined;
  note?: string | undefined;
  positional: string[];
  /** Flags dropped because their value was missing or because the line ended. */
  warnings: string[];
}

/**
 * Parse the optional evidence flags that follow `<taskId>` on `/kanban task
 * done`. Returns the first attachment URL and first note if present, plus
 * any positional leftovers so the caller can flag a usage error.
 *
 * Recognised flags (and their aliases):
 *   --attachment <url> | --evidence <url> | --link <url>
 *   --note <text>      | --comment <text>  | --action <text>
 *
 * Anything else is treated as positional. Flags may use `--key=value` or
 * `--key value`; quotes are not interpreted (shell already tokenised the
 * command line before it reached us).
 */
function parseTaskEvidenceFlags(tokens: readonly string[]): TaskEvidenceFlags {
  let attachment: string | undefined;
  let note: string | undefined;
  const positional: string[] = [];
  const warnings: string[] = [];
  const ATTACHMENT_KEYS = new Set(['--attachment', '--evidence', '--link']);
  const NOTE_KEYS = new Set(['--note', '--comment', '--action']);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const eq = token.indexOf('=');
    const inline =
      eq > 0 && (ATTACHMENT_KEYS.has(token.slice(0, eq)) || NOTE_KEYS.has(token.slice(0, eq)));
    const key = inline ? token.slice(0, eq) : token;
    if (ATTACHMENT_KEYS.has(key)) {
      const value = inline ? token.slice(eq + 1) : tokens[i + 1];
      if (!value?.trim()) {
        warnings.push(`${key} expects a URL but none was provided`);
        i = inline ? i : i + 1;
        continue;
      }
      // If the next token is itself a flag (e.g. `--attachment --note …`),
      // treat it as a missing value rather than swallowing the next flag.
      if (!inline && value.startsWith('-')) {
        warnings.push(`${key} expects a URL but none was provided`);
        i++;
        continue;
      }
      if (!inline) i++;
      attachment = value;
      continue;
    }
    if (NOTE_KEYS.has(key)) {
      // Inline form (`--note=text`) or single non-flag value when the next
      // token is missing/positional. Multi-word notes pass as separate tokens
      // after the flag, joined up to the next flag/positional boundary so
      // shell-split descriptions like "task done b t --note ran all unit tests
      // locally" survive intact.
      const inlineValue = inline ? token.slice(eq + 1) : undefined;
      if (inlineValue !== undefined) {
        if (!inlineValue.trim()) {
          warnings.push(`${key} expects text but none was provided`);
        } else {
          note = inlineValue;
        }
        continue;
      }
      const collected: string[] = [];
      for (let j = i + 1; j < tokens.length; j++) {
        const next = tokens[j];
        if (next === undefined) break;
        if (next.startsWith('--') || next === '-') break;
        collected.push(next);
      }
      if (collected.length === 0) {
        warnings.push(`${key} expects text but none was provided`);
        continue;
      }
      i += collected.length;
      note = collected.join(' ');
      continue;
    }
    positional.push(token);
  }
  return { attachment, note, positional, warnings };
}
