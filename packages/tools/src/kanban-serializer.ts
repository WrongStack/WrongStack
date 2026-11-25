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

/** Max items of a list-shaped field replayed into the transcript. */
export const KANBAN_TRANSCRIPT_ITEM_CAP = 100;

/**
 * List fields bounded by item count. `tail` keeps the most recent entries
 * (events are append-ordered); everything else keeps the head.
 */
const KANBAN_LIST_FIELDS: ReadonlyArray<{ field: keyof KanbanToolOutput; tail?: boolean }> = [
  { field: 'events', tail: true },
  { field: 'history', tail: true },
  { field: 'tasks' },
  { field: 'boards' },
  { field: 'recoveredTasks' },
  { field: 'chain' },
  { field: 'children' },
];

/** Byte cap for object-shaped payloads that are not the action's primary output. */
const KANBAN_OBJECT_TRANSCRIPT_BYTE_CAP = 65_536;
/** Byte cap for the object an action exists to return (snapshot → snapshot, …). */
const KANBAN_PRIMARY_OBJECT_TRANSCRIPT_BYTE_CAP = 262_144;

const KANBAN_OBJECT_FIELDS: ReadonlyArray<{
  field: 'snapshot' | 'workbench' | 'taskGraph';
  primaryFor: string;
}> = [
  { field: 'snapshot', primaryFor: 'snapshot' },
  { field: 'workbench', primaryFor: 'workbench' },
  { field: 'taskGraph', primaryFor: 'export_task_graph' },
];

function byteLength(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
  } catch {
    return 0;
  }
}

function objectSummary(field: string, value: unknown): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (Array.isArray(entry)) summary[`${key}Count`] = entry.length;
      else if (typeof entry === 'number' || typeof entry === 'string') summary[key] = entry;
    }
    if (field === 'workbench') {
      const totals = (value as { totals?: unknown }).totals;
      if (totals && typeof totals === 'object') summary['totals'] = totals;
    }
  }
  return summary;
}

/**
 * Transcript serializer for kanban results. Every mutation returns the full
 * board so programmatic consumers (todo mirror, gates, tests) can chain off it,
 * but replaying that board into the LLM transcript on EVERY add_note /
 * transition_task turns a busy board into thousands of repeated tokens.
 * When the serialized board exceeds the cap and the action is not a
 * board-reading one, the transcript payload carries a compact summary
 * ({column → task count}, totalTasks) plus the affected `task` and `message`.
 *
 * List fields (events, tasks, boards, …) are bounded to
 * KANBAN_TRANSCRIPT_ITEM_CAP items and large object payloads (snapshot,
 * workbench, taskGraph) are replaced by a count summary past their byte cap;
 * every cut is recorded under `truncated` / an inline note so the model knows
 * to narrow the query. `execute()`'s return shape is unchanged — this only
 * affects the transcript.
 */
export function serializeKanbanOutput(output: KanbanToolOutput, input: unknown): string {
  const action =
    input && typeof input === 'object' ? (input as { action?: unknown }).action : undefined;
  const actionName = typeof action === 'string' ? action : '';
  const compact: Record<string, unknown> = { ...output };
  const truncated: Record<string, { shown: number; total: number }> = { ...output.truncated };

  const board = output.board;
  if (board && !KANBAN_FULL_BOARD_ACTIONS.has(actionName)) {
    const boardBytes = byteLength(board);
    if (boardBytes > KANBAN_BOARD_TRANSCRIPT_BYTE_CAP) {
      const columns: Record<string, number> = {};
      for (const column of board.columns) {
        Object.defineProperty(columns, column.title || column.id, {
          value: board.tasks.filter((task) => task.columnId === column.id).length,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      compact['board'] = {
        id: board.id,
        title: board.title,
        columns,
        totalTasks: board.tasks.length,
        note: `Full board (${boardBytes} bytes) omitted from the transcript; use get_board to load it.`,
      };
    }
  }

  for (const { field, tail } of KANBAN_LIST_FIELDS) {
    const list = output[field];
    if (!Array.isArray(list) || list.length <= KANBAN_TRANSCRIPT_ITEM_CAP) continue;
    compact[field] = tail
      ? list.slice(-KANBAN_TRANSCRIPT_ITEM_CAP)
      : list.slice(0, KANBAN_TRANSCRIPT_ITEM_CAP);
    truncated[field] = { shown: KANBAN_TRANSCRIPT_ITEM_CAP, total: list.length };
  }

  for (const { field, primaryFor } of KANBAN_OBJECT_FIELDS) {
    const value = output[field];
    if (value === undefined || value === null) continue;
    const cap =
      actionName === primaryFor
        ? KANBAN_PRIMARY_OBJECT_TRANSCRIPT_BYTE_CAP
        : KANBAN_OBJECT_TRANSCRIPT_BYTE_CAP;
    const bytes = byteLength(value);
    if (bytes <= cap) continue;
    compact[field] = {
      ...objectSummary(field, value),
      note: `${field} (${bytes} bytes) omitted from the transcript; narrow it with boardId, query, or limit.`,
    };
  }

  if (Object.keys(truncated).length > 0) compact['truncated'] = truncated;
  return JSON.stringify(compact, null, 2);
}
