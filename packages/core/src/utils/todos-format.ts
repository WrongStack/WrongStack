import type { TodoItem } from '../core/context.js';
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
