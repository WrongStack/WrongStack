import type { SlashCommand } from '@wrongstack/core/types';
import { color } from '@wrongstack/core/utils';
import {
  createBoard,
  duplicateBoard,
  exportBoardAsMarkdown,
  getBoard,
  getKanbanOrchestrationSnapshot,
  listBoards,
  removeBoard,
  updateBoard as updateBoardManager,
} from '@wrongstack/kanban';
import { requireSessionId } from '@wrongstack/primitives';
import type { SlashCommandContext } from './command-context.js';
import { parseSubcommand, unknownSubcommand } from './helpers.js';
import {
  handleBoardGenerate,
  handleGraphSubcommand,
  handlePruneSubcommand,
} from './kanban-board-handlers.js';
import {
  formatBoardDetail,
  formatBoardList,
  formatDependencyChain,
  formatKanbanSnapshot,
} from './kanban-format.js';
import { KANBAN_COMMAND_HELP } from './kanban-help.js';
import { handleTaskSubcommand } from './kanban-task-subcommands.js';

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
      if (cmd === 'prune') {
        return handlePruneSubcommand(projectRoot, rest);
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
        return handleBoardGenerate(projectRoot, restJoined, {
          sessionId: requireSessionId(opts.context?.eventSessionId(), 'kanban slash command'),
          actor: 'cli-operator',
        });
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
