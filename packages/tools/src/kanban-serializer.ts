import type { KanbanToolOutput } from './kanban-tool-types.js';

/**
 * How many serialized bytes a `board` may occupy in the transcript before a
 * mutation result swaps it for a compact summary. Read actions whose purpose
 * IS the board (`get_board`, exports) always keep the full payload.
 */
const KANBAN_BOARD_TRANSCRIPT_BYTE_CAP = 16_384;

/** Actions whose whole point is returning the full board — never trimmed. */
const KANBAN_FULL_BOARD_ACTIONS = new Set<string>([
  'get_board',
  'export_markdown',
  'export_task_graph',
]);

/**
 * Transcript serializer for kanban results. Every mutation returns the full
 * board so programmatic consumers (todo mirror, gates, tests) can chain off it,
 * but replaying that board into the LLM transcript on EVERY add_note /
 * transition_task turns a busy board into thousands of repeated tokens.
 * When the serialized board exceeds the cap and the action is not a
 * board-reading one, the transcript payload carries a compact summary
 * ({column → task count}, totalTasks) plus the affected `task` and `message`.
 * `execute()`'s return shape is unchanged — this only affects the transcript.
 */
export function serializeKanbanOutput(output: KanbanToolOutput, input: unknown): string {
  const action =
    input && typeof input === 'object' ? (input as { action?: unknown }).action : undefined;
  const board = output.board;
  if (board) {
    const keepFull = typeof action === 'string' && KANBAN_FULL_BOARD_ACTIONS.has(action);
    let boardBytes = 0;
    if (!keepFull) {
      try {
        boardBytes = Buffer.byteLength(JSON.stringify(board), 'utf8');
      } catch {
        boardBytes = 0;
      }
    }
    if (!keepFull && boardBytes > KANBAN_BOARD_TRANSCRIPT_BYTE_CAP) {
      const columns: Record<string, number> = {};
      for (const column of board.columns) {
        columns[column.title || column.id] = board.tasks.filter(
          (task) => task.columnId === column.id,
        ).length;
      }
      const compact = {
        ...output,
        board: {
          id: board.id,
          title: board.title,
          columns,
          totalTasks: board.tasks.length,
          note: `Full board (${boardBytes} bytes) omitted from the transcript; use get_board to load it.`,
        },
      };
      return JSON.stringify(compact, null, 2);
    }
  }
  return JSON.stringify(output, null, 2);
}
