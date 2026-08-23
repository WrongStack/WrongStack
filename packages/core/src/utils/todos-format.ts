import type { TodoItem } from '../types/context.js';
import { color } from './color.js';

/**
 * Canonical text rendering of the live todo list, shared by the CLI's
 * `/todos` slash command and the TUI's auto-echo (which prints the same
 * snapshot to chat history each time the `todo` tool mutates the list).
 *
 * Layout: a header line with the `done/total done` count, then one row
 * per item — `[ ]` pending, `[~]` in-progress, `[x]` completed. In-
 * progress rows prefer `activeForm` ("Building the project") over the
 * imperative `content` ("Build the project") when present.
 *
 * Returned as a single newline-joined string so callers can hand it
 * straight to a history dispatcher or stdout.
 */
export function formatTodosList(todos: TodoItem[]): string {
  if (todos.length === 0) return 'No todos.';
  const lines: string[] = [];
  const done = todos.filter((t) => t.status === 'completed').length;
  lines.push(color.dim(`Todos (${done}/${todos.length} done):`));
  todos.forEach((t, i) => {
    const mark =
      t.status === 'completed'
        ? color.green('[x]')
        : t.status === 'in_progress'
          ? color.yellow('[~]')
          : color.dim('[ ]');
    const text = t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content;
    const label = t.status === 'completed' ? color.dim(text) : text;
    lines.push(`  ${color.dim(String(i + 1).padStart(2))}. ${mark} ${label}`);
  });
  return lines.join('\n');
}

/**
 * Render one todo row for the model, including its Kanban binding.
 *
 * The binding is the whole contract: with Kanban active a row is not an
 * independent note, it is a projection of a real card, and the model is
 * required to echo `kanbanBoardId`/`kanbanTaskId` back on the next `todo`
 * call or the card cannot be advanced. Every surface that replayed live todo
 * state to the model used to strip these ids, so the only place they appeared
 * was the `todo` tool's own return value — which ages out of context. Once it
 * did, the next update fell back to fuzzy title matching, and a row whose
 * title had drifted silently stopped applying to its card.
 */
export function formatTodoForModel(todo: TodoItem): string {
  const binding =
    todo.kanbanBoardId && todo.kanbanTaskId
      ? ` <kanban ${todo.kanbanBoardId}/${todo.kanbanTaskId}>`
      : '';
  // Surface the blocking reason inline. The board already knows this on every
  // mutation; without it in the row the model reads a flat list where blocked
  // work looks exactly like ready work, and picks the next item by guesswork.
  const blocked = todo.blockedBy?.length ? ` [blocked by: ${todo.blockedBy.join('; ')}]` : '';
  return `- [${todo.status}]${blocked} ${todo.content} (${todo.id})${binding}`;
}

/** Multi-line `formatTodoForModel` rendering, or a stable empty-state line. */
export function formatTodosForModel(
  todos: readonly TodoItem[],
  emptyLine = '- No active todos remain.',
): string {
  return todos.length ? todos.map(formatTodoForModel).join('\n') : emptyLine;
}

/**
 * True when at least one row is bound to a real Kanban card, meaning the list
 * is a managed projection rather than free-standing session state.
 */
export function hasKanbanBoundTodos(todos: readonly TodoItem[] | undefined | null): boolean {
  if (!Array.isArray(todos)) return false;
  return todos.some((todo) => Boolean(todo.kanbanBoardId && todo.kanbanTaskId));
}

/**
 * True when the todos list still has at least one unfinished item — either
 * `pending` (not started) or `in_progress` (underway). The REPL and other
 * post-turn handlers call this to decide whether to surface `<nextsteps>`
 * suggestions to the user: as long as the agent has open todos, finishing
 * them takes priority over offering new prompt options. Surfacing
 * `<nextsteps>` mid-task is what causes YOLO+auto mode and the autonomy
 * 'auto' loop to prematurely pivot away from the in-flight todo list.
 *
 * Returns false for an empty / undefined list (nothing pending, nothing to
 * block on) and false for an all-completed list. Treats any non-array input
 * (legacy contexts, mocks) as "no todos" rather than throwing.
 */
export function hasOpenTodos(todos: readonly TodoItem[] | undefined | null): boolean {
  if (!Array.isArray(todos) || todos.length === 0) return false;
  return todos.some((t) => t.status === 'pending' || t.status === 'in_progress');
}
