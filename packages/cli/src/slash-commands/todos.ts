import { randomUUID } from 'node:crypto';
import type { TodoItem } from '@wrongstack/core/agent';
import type { SlashCommand } from '@wrongstack/core/types';
import { formatTodosList } from '@wrongstack/core/utils';
import { todoTool } from '@wrongstack/tools';
import type { SlashCommandContext } from './command-context.js';
import { parseSubcommand, unknownSubcommand } from './helpers.js';

/** Find a todo by 1-based index, exact id, or case-insensitive substring. */
function findTodo(todos: TodoItem[], query: string): { idx: number; item: TodoItem } | null {
  const asIndex = Number.parseInt(query, 10);
  if (!Number.isNaN(asIndex)) {
    const idx = asIndex - 1;
    const item = todos[idx];
    if (item) return { idx, item };
  }
  // Try exact id match
  const byId = todos.findIndex((t) => t.id === query);
  if (byId >= 0) {
    const item = todos[byId];
    if (item) return { idx: byId, item };
  }
  // Fall through to case-insensitive substring
  const q = query.toLowerCase();
  const byContent = todos.findIndex((t) => t.content.toLowerCase().includes(q));
  if (byContent >= 0) {
    const item = todos[byContent];
    if (item) return { idx: byContent, item };
  }
  return null;
}

export function buildTodosCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'todos',
    category: 'Inspect',
    description:
      'Inspect or edit the live todo list: /todos [show|clear|add|done|remove|rm <id|index>]. ' +
      'For multi-phase work use /plan (session-persistent roadmap). ' +
      'For structured typed work with priorities and dependencies use /tasks (session-persistent).',
    async run(args) {
      const ctx = opts.context;
      if (!ctx) return { message: 'No active context.' };
      const { cmd, rest } = parseSubcommand(args);
      const restJoined = rest.join(' ').trim();
      const updateTodos = (todos: TodoItem[]) =>
        todoTool.execute({ todos }, ctx, { signal: AbortSignal.timeout(30_000) });
      const isManagedProjection = (todo: TodoItem) =>
        Boolean(todo.kanbanBoardId && todo.kanbanTaskId);
      try {
        switch (cmd) {
          case '':
          case 'show':
          case 'list': {
            return { message: formatTodosList(ctx.todos) };
          }
          case 'clear': {
            const n = ctx.todos.length;
            if (n === 0) return { message: 'Todos were already empty.' };
            if (ctx.todos.some(isManagedProjection)) {
              return {
                message:
                  'Kanban-bound todos are task projections. Change or remove the tasks from Kanban.',
              };
            }
            ctx.state.replaceTodos([]);
            return { message: `Cleared ${n} todo${n === 1 ? '' : 's'}.` };
          }
          case 'add': {
            if (!restJoined) return { message: 'Usage: /todos add <text>' };
            if (ctx.todos.some(isManagedProjection)) {
              return { message: 'This Todo list is a Kanban projection. Add the task in Kanban.' };
            }
            const item: TodoItem = {
              id: `todo_${Date.now()}_${randomUUID().slice(0, 7)}`,
              content: restJoined,
              status: 'pending',
            };
            await updateTodos([...ctx.todos, item]);
            return { message: `Added: ${restJoined}` };
          }
          case 'done-all':
          case 'complete-all': {
            const pending = ctx.todos.filter((t) => t.status !== 'completed');
            if (pending.length === 0) return { message: 'No pending todos to complete.' };
            if (ctx.todos.some(isManagedProjection)) {
              return {
                message:
                  'Kanban-bound todos must complete through their real task lifecycle; complete the active task individually.',
              };
            }
            await updateTodos(
              ctx.todos.map((t) =>
                t.status === 'completed' ? t : { ...t, status: 'completed' as const },
              ),
            );
            return {
              message: `Marked ${pending.length} todo${pending.length === 1 ? '' : 's'} done.`,
            };
          }
          case 'done':
          case 'complete': {
            if (!restJoined) return { message: 'Usage: /todos done <id|index>' };
            const found = findTodo(ctx.todos, restJoined);
            if (!found) return { message: `No todo matched "${restJoined}".` };
            const doneItem: TodoItem = { ...found.item, status: 'completed' };
            const nextTodos = [
              ...ctx.todos.slice(0, found.idx),
              doneItem,
              ...ctx.todos.slice(found.idx + 1),
            ];
            const result = await updateTodos(nextTodos);
            const projected = ctx.todos.find((todo) => todo.id === doneItem.id);
            if (isManagedProjection(doneItem) && projected?.status !== 'completed') {
              return {
                message:
                  result.kanban_warnings?.[0] ??
                  `Kanban kept ${doneItem.content} at ${projected?.status ?? 'its current state'}.`,
              };
            }
            return { message: `Marked done: ${doneItem.content}` };
          }
          case 'remove':
          case 'rm':
          case 'delete': {
            if (!restJoined) return { message: 'Usage: /todos remove <id|index>' };
            const found = findTodo(ctx.todos, restJoined);
            if (!found) return { message: `No todo matched "${restJoined}".` };
            if (isManagedProjection(found.item)) {
              return {
                message:
                  'Kanban-bound todos are task projections. Remove the task from Kanban instead.',
              };
            }
            const nextTodos = [...ctx.todos.slice(0, found.idx), ...ctx.todos.slice(found.idx + 1)];
            ctx.state.replaceTodos(nextTodos);
            return { message: `Removed: ${found.item.content}` };
          }
          default:
            return {
              message:
                unknownSubcommand(
                  cmd,
                  ['show', 'clear', 'add', 'done', 'done-all', 'remove'],
                  'todos',
                ) +
                '\n\nRelated: /plan (session-persistent roadmap) | /tasks (structured tasks with priorities)',
            };
        }
      } catch (error) {
        return {
          message: `Todo update failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  };
}
