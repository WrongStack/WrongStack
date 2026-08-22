import { readBoard, summarizeBoard } from '../storage.js';
import type { KanbanBoard, KanbanTaskPriority } from '../types.js';
import type {
  CreateKanbanBoardInput,
  CreateKanbanTaskInput,
  KanbanGenerationInput,
  KanbanSearchInput,
  KanbanSearchResult,
} from '../types-operations.js';
import { matchesKanbanSearch } from './_internal.js';
import { listBoards } from './boards.js';

/**
 * @deprecated Renamed to `createBoardFromText` for clarity (no AI involved).
 * Scheduled for removal in the next major version.
 */
export const generateBoardFromDescription = createBoardFromText;

export function createBoardFromText(input: KanbanGenerationInput): CreateKanbanBoardInput {
  const title =
    input.title ??
    `Kanban: ${input.description.slice(0, 60)}${input.description.length > 60 ? '...' : ''}`;
  // Columns are locked to the 5 standard columns. The former column-count /
  // column-title derivation (which also had a bug: `columnCount ?? 4` dropped
  // the "done" column) is gone — every generated board gets the full set.
  return {
    title,
    description: input.context
      ? `${input.description}\n\nContext: ${input.context}`
      : input.description,
    tasks: [],
  };
}

export function parseLinesIntoTasks(
  description: string,
  targetColumnId = 'backlog',
): CreateKanbanTaskInput[] {
  return description
    .split('\n')
    .map((line) => line.replace(/^\s*[-*#]\s*/, '').trim())
    .filter(Boolean)
    .map((title) => ({
      title,
      columnId: targetColumnId,
      priority: 'medium' as KanbanTaskPriority,
    }));
}

export async function searchKanban(
  projectRoot: string,
  input: KanbanSearchInput = {},
): Promise<KanbanSearchResult[]> {
  const boardIds = input.boardId
    ? [input.boardId]
    : (await listBoards(projectRoot)).map((b) => b.id);
  const results: KanbanSearchResult[] = [];
  for (const boardId of boardIds) {
    const board = await readBoard(projectRoot, boardId);
    if (!board) continue;
    for (const task of board.tasks) {
      if (!matchesKanbanSearch(board, task, input)) continue;
      results.push({ board: summarizeBoard(board), task });
    }
  }
  return results;
}

export function exportBoardAsMarkdown(board: KanbanBoard): string {
  const lines: string[] = [`# ${board.title}`];
  if (board.description) lines.push('', board.description);
  if (board.tags?.length) lines.push('', `Tags: ${board.tags.map((tag) => `#${tag}`).join(' ')}`);
  if (board.contractGraph) {
    lines.push('', `## Contract Graph (${board.contractGraph.enforcement})`, '');
    if (board.contractGraph.nodes.length === 0) {
      lines.push('_No contract nodes_');
    } else {
      for (const node of board.contractGraph.nodes) {
        const owner = board.tasks.find((task) => task.id === node.taskId);
        lines.push(
          `- **${node.kind}** ${node.title} — ${node.state} / ${node.enforcement}` +
            `${owner ? ` (task: ${owner.title})` : ''}`,
        );
      }
      for (const edge of board.contractGraph.edges) {
        lines.push(`  - ${edge.from} --${edge.type}--> ${edge.to} [${edge.enforcement}]`);
      }
    }
  }
  for (const column of [...board.columns].sort((a, b) => a.order - b.order)) {
    lines.push('', `## ${column.title}`, '');
    const tasks = board.tasks
      .filter((task) => task.columnId === column.id)
      .sort((a, b) => a.order - b.order);
    if (!tasks.length) {
      lines.push('_Empty_');
      continue;
    }
    for (const task of tasks) {
      const checked = task.status === 'completed' ? 'x' : ' ';
      const assignee = task.assignedAgent ? ` @${task.assignedAgent}` : '';
      const priority = task.priority !== 'medium' ? ` !${task.priority}` : '';
      lines.push(`- [${checked}] ${task.title}${assignee}${priority}`);
      if (task.description) lines.push(`  ${task.description}`);
      if (task.assignment?.provider || task.assignment?.model || task.assignment?.fallbackProfile) {
        lines.push(
          `  agent: ${[
            task.assignment.provider,
            task.assignment.model,
            task.assignment.fallbackProfile ? `fallback=${task.assignment.fallbackProfile}` : '',
          ]
            .filter(Boolean)
            .join(' / ')}`,
        );
      }
      for (const check of task.successCriteria ?? []) {
        lines.push(`  - [${check.status === 'passed' ? 'x' : ' '}] ${check.description}`);
      }
    }
  }
  lines.push('', `---`, `Exported from WrongStack Kanban: ${board.id}`);
  return lines.join('\n');
}

export async function exportBoardMarkdown(
  projectRoot: string,
  boardId: string,
): Promise<string | null> {
  const board = await readBoard(projectRoot, boardId);
  return board ? exportBoardAsMarkdown(board) : null;
}
