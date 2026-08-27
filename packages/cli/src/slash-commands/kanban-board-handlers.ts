import { color } from '@wrongstack/core/utils';
import type { KanbanEventContext } from '@wrongstack/kanban';
import {
  addTask,
  createBoard,
  createBoardFromTaskGraph,
  createBoardFromText,
  exportBoardToTaskGraph,
  listBoards,
  parseLinesIntoTasks,
  removeBoard,
  syncBoardFromTaskGraph,
} from '@wrongstack/kanban';
import { TaskGraphStore } from '@wrongstack/sdd';
import type { SlashCommandContext } from './command-context.js';
import { DIM, fmtAge, HEADING, LABEL } from './kanban-format.js';

export async function handlePruneSubcommand(
  projectRoot: string,
  rest: string[],
): Promise<{ message: string }> {
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

export async function handleGraphSubcommand(
  opts: SlashCommandContext,
  projectRoot: string,
  args: string[],
  showHelp: () => { message: string },
): Promise<{ message: string }> {
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

export async function handleBoardGenerate(
  projectRoot: string,
  restJoined: string,
  eventContext: KanbanEventContext,
): Promise<{ message: string }> {
  if (!restJoined) return { message: color.red('Usage: /kanban generate <description>') };
  const genInput = createBoardFromText({ description: restJoined });
  const board = await createBoard(projectRoot, genInput);
  const tasks = parseLinesIntoTasks(restJoined, board.columns[0]?.id ?? 'backlog');
  for (const taskInput of tasks) {
    await addTask(projectRoot, board.id, taskInput, eventContext);
  }
  return {
    message: `${color.green('✅ Board generated:')} ${color.bold(board.title)}\n  ${color.dim(board.id)}\n  ${board.tasks.length + tasks.length} tasks created`,
  };
}
