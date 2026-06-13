import type { TodoItem, Tool } from '@wrongstack/core';
import { loadPlan, savePlan, setPlanItemStatus } from '@wrongstack/core';
import { loadTasks, saveTasks } from '@wrongstack/core';

interface TodoInput {
  todos: TodoItem[];
}

interface TodoOutput {
  count: number;
  in_progress: number;
}

export const todoTool: Tool<TodoInput, TodoOutput> = {
  name: 'todo',
  category: 'Session',
  description:
    'Manage the session-level todo list. This is the primary mechanism for tracking multi-step work. ' +
    'The list is fully replaced on every call (not appended).',
  usageHint:
    'BEST PRACTICE for complex tasks:\n' +
    '- At the beginning of a non-trivial task, create a clear todo list with specific, actionable items.\n' +
    '- Only **one** item should be `in_progress` at any time.\n' +
    '- Update the list frequently as work progresses (mark items done, add new ones, change status).\n' +
    '- **Re-order items** to reflect current priorities — the full list is replaced each call, so item order is entirely under your control.\n' +
    '- When all items are completed the board auto-clears — you do NOT need to send an empty list.\n' +
    '- The system and user can see this list, so keep it honest and up-to-date.\n' +
    'This tool is extremely valuable for maintaining focus and giving the user visibility into your plan.',
  permission: 'auto',
  mutating: false, // mutates only conversation state (ctx.todos), not external state — no confirmation needed
  timeoutMs: 1_000,
  capabilities: ['session.todo'],
  inputSchema: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: 'Unique identifier for the todo item (e.g. "1", "auth-flow").',
            },
            content: {
              type: 'string',
              description: 'Clear, actionable description of the task.',
            },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'completed'],
              description: 'Current status. Only one item should be "in_progress" at a time.',
            },
            activeForm: {
              type: 'string',
              description: 'Optional present-tense form shown while the task is active (e.g. "Fixing auth bug").',
            },
          },
          required: ['id', 'content', 'status'],
        },
        description: 'The complete new list of todos. This replaces the previous list entirely.',
      },
    },
    required: ['todos'],
  },
  async execute(input, ctx) {
    if (!Array.isArray(input?.todos)) {
      throw new Error('todo: todos must be an array');
    }
    const items = input.todos.filter((t): t is TodoItem => Boolean(t?.id && t.content));
    const inProgress = items.filter((t) => t.status === 'in_progress');
    if (inProgress.length > 1) {
      // Keep only the first as in_progress, mark rest pending
      let seenInProgress = false;
      for (const item of items) {
        if (item.status === 'in_progress') {
          if (seenInProgress) item.status = 'pending';
          seenInProgress = true;
        }
      }
    }
    ctx.state.replaceTodos(items);

    // Auto-complete parent plan items / tasks when all their promoted
    // todos are done. Runs after state mutation so the UI sees the new
    // todo list before we touch the plan/task files.
    const completedPlanIds = new Set<string>();
    const completedTaskIds = new Set<string>();
    const pendingPlanIds = new Set<string>();
    const pendingTaskIds = new Set<string>();

    for (const item of items) {
      if (item.promotedFromPlan) {
        (item.status === 'completed' ? completedPlanIds : pendingPlanIds).add(item.promotedFromPlan);
      }
      if (item.promotedFromTask) {
        (item.status === 'completed' ? completedTaskIds : pendingTaskIds).add(item.promotedFromTask);
      }
    }

    // Mark fully-completed plan items as done
    for (const planId of completedPlanIds) {
      if (pendingPlanIds.has(planId)) continue; // not all done yet
      const planPath = (ctx.meta as Record<string, unknown>)['plan.path'];
      if (typeof planPath !== 'string' || !planPath) continue;
      try {
        const plan = await loadPlan(planPath);
        if (plan) {
          const updated = setPlanItemStatus(plan, planId, 'done');
          await savePlan(planPath, updated);
        }
      } catch { /* best-effort */ }
    }

    // Mark fully-completed tasks as completed
    for (const taskId of completedTaskIds) {
      if (pendingTaskIds.has(taskId)) continue; // not all done yet
      const taskPath = (ctx.meta as Record<string, unknown>)['task.path'];
      if (typeof taskPath !== 'string' || !taskPath) continue;
      try {
        const file = await loadTasks(taskPath);
        if (file) {
          const task = file.tasks.find((t) => t.id === taskId);
          if (task && task.status !== 'completed') {
            task.status = 'completed';
            task.updatedAt = new Date().toISOString();
            await saveTasks(taskPath, file);
          }
        }
      } catch { /* best-effort */ }
    }

    return {
      count: items.length,
      in_progress: items.filter((t) => t.status === 'in_progress').length,
    };
  },
};
