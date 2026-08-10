import { randomUUID } from 'node:crypto';
import type { TodoItem } from '@wrongstack/core/agent';
import {
  addPlanItem,
  emptyPlan,
  formatPlan,
  loadPlan,
  loadTasks,
  mutateTasks,
  saveCompletedWorkCheckpoint,
  savePlan,
} from '@wrongstack/core/storage';
import type { SlashCommand, TaskPriority, TaskStatus, TaskType } from '@wrongstack/core/types';
import type { TaskItem } from '@wrongstack/core/utils';
import {
  formatTaskList,
  formatTaskProgress,
  recordCompletedWorkEvidence,
} from '@wrongstack/core/utils';
import { todoTool } from '@wrongstack/tools';
import type { SlashCommandContext } from './command-context.js';
import { parseSubcommand, unknownSubcommand } from './helpers.js';

function findTask(tasks: TaskItem[], query: string): { idx: number; item: TaskItem } | null {
  const asIndex = Number.parseInt(query, 10);
  if (!Number.isNaN(asIndex)) {
    const idx = asIndex - 1;
    const item = tasks[idx];
    if (item) return { idx, item };
  }
  const byId = tasks.findIndex((t) => t.id === query);
  if (byId >= 0) {
    const item = tasks[byId];
    if (item) return { idx: byId, item };
  }
  const q = query.toLowerCase();
  const byTitle = tasks.findIndex((t) => t.title.toLowerCase().includes(q));
  if (byTitle >= 0) {
    const item = tasks[byTitle];
    if (item) return { idx: byTitle, item };
  }
  return null;
}

function validateType(s: string): TaskType | null {
  const valid: TaskType[] = ['feature', 'bugfix', 'refactor', 'docs', 'test', 'chore'];
  return valid.includes(s as TaskType) ? (s as TaskType) : null;
}

function validatePriority(s: string): TaskPriority | null {
  const valid: TaskPriority[] = ['critical', 'high', 'medium', 'low'];
  return valid.includes(s as TaskPriority) ? (s as TaskPriority) : null;
}

function validateStatus(s: string): TaskStatus | null {
  const valid: TaskStatus[] = [
    'pending',
    'in_progress',
    'blocked',
    'failed',
    'review',
    'completed',
  ];
  return valid.includes(s as TaskStatus) ? (s as TaskStatus) : null;
}

export function buildTasksCommand(_opts: SlashCommandContext): SlashCommand {
  return {
    name: 'tasks',
    category: 'Inspect',
    description:
      'Manage structured tasks with dependencies, types, and priorities: /tasks [show|add <title>|start|done|fail|status <id> <status>|promote <id>|planify <id>|clear]. ' +
      'Tasks are session-persistent (survive resume, isolated to this session). Use `scope: "project"` to share across sessions. ' +
      'For simpler per-turn todos use /todos. For multi-phase roadmaps use /plan.',
    help: [
      'Usage:',
      '  /tasks                            Show task progress + list',
      '  /tasks show                       Same as no args',
      '  /tasks add <title> [type] [prio]  Add a task',
      '  /tasks start <id|index>           Mark task in-progress',
      '  /tasks done <id|index>            Mark task completed',
      '  /tasks fail <id|index>            Mark task failed',
      '  /tasks status <id> <status>       Set exact status (pending|in_progress|blocked|review|completed|failed)',
      '  /tasks depends <id> <depId...>    Set dependencies for a task',
      '  /tasks assign <id> <agent>        Assign task to an agent/subagent',
      '  /tasks promote <id>               Promote task to todo items',
      '  /tasks planify <id>               Promote task to a plan item',
      '  /tasks clear                      Remove all tasks',
      '',
      'Types: feature, bugfix, refactor, docs, test, chore',
      'Priorities: critical, high, medium, low',
      'Scope: tasks are session-isolated by default; use scope:"project" in the task tool to share across sessions',
    ].join('\n'),
    async run(args, ctx) {
      if (!ctx) {
        return { message: 'No agent context available.' };
      }
      const taskPath = (ctx.meta as Record<string, unknown>)?.['task.path'];
      if (typeof taskPath !== 'string' || !taskPath) {
        return { message: 'Task storage is not configured for this session.' };
      }
      const sessionId = ctx.session?.id ?? 'unknown';
      const { cmd, rest } = parseSubcommand(args);
      const restJoined = rest.join(' ').trim();

      // Read-only ops — no lock overhead
      if (cmd === '' || cmd === 'show' || cmd === 'list') {
        const file = await loadTasks(taskPath);
        const all = file?.tasks ?? [];
        // Optional status filter: `/tasks show <status>` or `--status <status>`.
        const filterArg = restJoined.replace(/^--status\s+/, '').trim();
        const statusFilter = filterArg ? validateStatus(filterArg) : null;
        if (filterArg && !statusFilter) {
          return {
            message: `Invalid status "${filterArg}". Valid: pending, in_progress, blocked, failed, review, completed.`,
          };
        }
        const tasks = statusFilter ? all.filter((t) => t.status === statusFilter) : all;
        if (statusFilter && tasks.length === 0) {
          return { message: `No tasks with status "${statusFilter}".` };
        }
        return { message: formatTaskList(tasks) };
      }
      if (cmd === 'progress' || cmd === 'statusline') {
        const file = await loadTasks(taskPath);
        return { message: formatTaskProgress(file?.tasks ?? []) };
      }

      // planify: reads tasks, writes plan — handled inside the task lock
      // to prevent TOCTOU between loadTasks and savePlan.
      if (cmd === 'planify') {
        if (!restJoined) return { message: 'Usage: /tasks planify <id|index>' };
        const planPath = (ctx.meta as Record<string, unknown>)?.['plan.path'];
        if (typeof planPath !== 'string' || !planPath) {
          return { message: 'Plan storage is not configured for this session.' };
        }

        let outputMessage = '';
        await mutateTasks(taskPath, sessionId, async (file) => {
          const found = findTask(file.tasks, restJoined);
          if (!found) {
            outputMessage = `No task matched "${restJoined}".`;
            return file;
          }
          const planCfg = (await loadPlan(planPath)) ?? emptyPlan(sessionId);
          const { plan: updated } = addPlanItem(planCfg, found.item.title, found.item.description);
          await savePlan(planPath, updated);
          outputMessage = `Planified "${found.item.title}" → plan item.\n${formatPlan(updated)}`;
          return file;
        });
        return { message: outputMessage };
      }

      // Mutating ops — locked via mutateTasks
      let outputMessage = '';
      // Task completed inside the mutate callback — recorded into the
      // completed-work ledger (evidence + system-prompt block + checkpoint)
      // after the lock is released.
      let completedTask: { id: string; title: string } | null = null;
      let todosToReplace: TodoItem[] | null = null;
      await mutateTasks(taskPath, sessionId, async (file) => {
        switch (cmd) {
          case 'add': {
            if (!restJoined) {
              outputMessage = 'Usage: /tasks add <title> [type] [priority]';
              return file;
            }
            // Peel optional trailing `[type] [priority]` off the END so a
            // multi-word title isn't truncated to its first word. Priority is
            // peeled first (priority words rarely appear in titles); a trailing
            // type is peeled only when a priority was also present (the
            // documented `<title> [type] [priority]` form), so a title ending in
            // a type-like word ("Fix the auth bug") is preserved intact.
            const parts = restJoined.split(/\s+/);
            let type: TaskType = 'feature';
            let priority: TaskPriority = 'medium';
            if (parts.length > 1) {
              const p = validatePriority(parts[parts.length - 1] ?? '');
              if (p) {
                priority = p;
                parts.pop();
                if (parts.length > 1) {
                  const t = validateType(parts[parts.length - 1] ?? '');
                  if (t) {
                    type = t;
                    parts.pop();
                  }
                }
              }
            }
            const title = parts.join(' ');
            const now = new Date().toISOString();
            file.tasks.push({
              id: `task_${randomUUID()}`,
              title,
              type,
              priority,
              status: 'pending',
              createdAt: now,
              updatedAt: now,
            });
            outputMessage = `Added: ${title}\n\n${formatTaskProgress(file.tasks)}`;
            break;
          }
          case 'start':
          case 'done':
          case 'fail': {
            if (!restJoined) {
              outputMessage = `Usage: /tasks ${cmd} <id|index>`;
              return file;
            }
            const found = findTask(file.tasks, restJoined);
            if (!found) {
              outputMessage = `No task matched "${restJoined}".`;
              return file;
            }
            const statusMap: Record<string, TaskStatus> = {
              start: 'in_progress',
              done: 'completed',
              fail: 'failed',
            };
            const verbMap: Record<string, string> = {
              start: 'Started',
              done: 'Completed',
              fail: 'Failed',
            };
            const nextStatus = statusMap[cmd] ?? 'pending';
            if (nextStatus === 'in_progress' || nextStatus === 'completed') {
              const unmet = (found.item.dependsOn ?? []).filter(
                (dependencyId) =>
                  file.tasks.find((task) => task.id === dependencyId)?.status !== 'completed',
              );
              if (unmet.length > 0) {
                outputMessage = `Cannot mark "${found.item.title}" ${nextStatus}; dependencies are unfinished: ${unmet.join(', ')}.`;
                return file;
              }
            }
            found.item.status = nextStatus;
            found.item.updatedAt = new Date().toISOString();
            if (cmd === 'done') {
              completedTask = { id: found.item.id, title: found.item.title };
            }
            outputMessage = `Marked ${verbMap[cmd] ?? cmd}: ${found.item.title}\n\n${formatTaskProgress(file.tasks)}`;
            break;
          }
          case 'status': {
            if (rest.length < 2) {
              outputMessage = 'Usage: /tasks status <id> <status>';
              return file;
            }
            const targetId = rest[0] ?? '';
            const newStatus = validateStatus(rest[1] ?? '');
            if (!newStatus) {
              outputMessage = `Invalid status "${rest[1]}".`;
              return file;
            }
            const found = findTask(file.tasks, targetId);
            if (!found) {
              outputMessage = `No task matched "${targetId}".`;
              return file;
            }
            if (
              newStatus === 'in_progress' ||
              newStatus === 'review' ||
              newStatus === 'completed'
            ) {
              const unmet = (found.item.dependsOn ?? []).filter(
                (dependencyId) =>
                  file.tasks.find((task) => task.id === dependencyId)?.status !== 'completed',
              );
              if (unmet.length > 0) {
                outputMessage = `Cannot mark "${found.item.title}" ${newStatus}; dependencies are unfinished: ${unmet.join(', ')}.`;
                return file;
              }
            }
            found.item.status = newStatus;
            found.item.updatedAt = new Date().toISOString();
            if (newStatus === 'completed') {
              completedTask = { id: found.item.id, title: found.item.title };
            }
            outputMessage = `Status → ${newStatus}: ${found.item.title}\n\n${formatTaskProgress(file.tasks)}`;
            break;
          }
          case 'depends':
          case 'deps': {
            if (rest.length < 2) {
              outputMessage = 'Usage: /tasks depends <id> <depId1> [depId2 ...]';
              return file;
            }
            const targetId = rest[0] ?? '';
            const depIds = rest.slice(1);
            const found = findTask(file.tasks, targetId);
            if (!found) {
              outputMessage = `No task matched "${targetId}".`;
              return file;
            }
            const knownIds = new Set(file.tasks.map((task) => task.id));
            const missing = depIds.filter((dependencyId) => !knownIds.has(dependencyId));
            if (missing.length > 0) {
              outputMessage = `Unknown dependency task IDs: ${missing.join(', ')}.`;
              return file;
            }
            if (
              found.item.status === 'in_progress' ||
              found.item.status === 'review' ||
              found.item.status === 'completed'
            ) {
              const unmet = depIds.filter(
                (dependencyId) =>
                  file.tasks.find((task) => task.id === dependencyId)?.status !== 'completed',
              );
              if (unmet.length > 0) {
                outputMessage = `Cannot add unfinished dependencies to active task "${found.item.title}": ${unmet.join(', ')}.`;
                return file;
              }
            }
            found.item.dependsOn = depIds;
            found.item.updatedAt = new Date().toISOString();
            outputMessage = `Dependencies set for "${found.item.title}": ${depIds.join(', ')}`;
            break;
          }
          case 'assign': {
            if (rest.length < 2) {
              outputMessage = 'Usage: /tasks assign <id> <agent>';
              return file;
            }
            const targetId = rest[0] ?? '';
            const agent = rest.slice(1).join(' ');
            const found = findTask(file.tasks, targetId);
            if (!found) {
              outputMessage = `No task matched "${targetId}".`;
              return file;
            }
            found.item.assignee = agent;
            found.item.updatedAt = new Date().toISOString();
            outputMessage = `Assigned to ${agent}: "${found.item.title}"`;
            break;
          }
          case 'promote': {
            if (!restJoined) {
              outputMessage = 'Usage: /tasks promote <id|index>';
              return file;
            }
            const found = findTask(file.tasks, restJoined);
            if (!found) {
              outputMessage = `No task matched "${restJoined}".`;
              return file;
            }
            const unmet = (found.item.dependsOn ?? []).filter(
              (dependencyId) =>
                file.tasks.find((task) => task.id === dependencyId)?.status !== 'completed',
            );
            if (unmet.length > 0) {
              outputMessage = `Cannot promote "${found.item.title}"; dependencies are unfinished: ${unmet.join(', ')}.`;
              return file;
            }
            found.item.status = 'in_progress';
            found.item.updatedAt = new Date().toISOString();
            const todos: Array<{
              id: string;
              content: string;
              status: 'pending' | 'in_progress' | 'completed';
              activeForm?: string;
              promotedFromTask?: string;
            }> = [
              {
                id: `todo_${Date.now()}_task`,
                content: found.item.title,
                status: 'in_progress',
                activeForm: found.item.title,
                promotedFromTask: found.item.id,
              },
            ];
            if (found.item.description) {
              todos.push({
                id: `todo_${randomUUID()}`,
                content: found.item.description.slice(0, 200),
                status: 'pending',
                promotedFromTask: found.item.id,
              });
            }
            // Append to the existing todo list rather than replacing it, so a
            // /tasks promote doesn't wipe unrelated in-flight todos. Drop any
            // todos previously promoted from this same task to stay idempotent.
            const existing = ctx.state.todos.filter(
              (t) => (t as { promotedFromTask?: string }).promotedFromTask !== found.item.id,
            );
            todosToReplace = [...existing, ...todos];
            outputMessage = `Promoted to ${todos.length} todo(s): "${found.item.title}"\n\n${formatTaskProgress(file.tasks)}`;
            break;
          }
          case 'clear': {
            const n = file.tasks.length;
            if (n === 0) {
              outputMessage = 'Tasks were already empty.';
              return file;
            }
            const unfinished = file.tasks.filter((task) => task.status !== 'completed');
            if (unfinished.length > 0) {
              outputMessage = `Cannot clear unfinished tasks: ${unfinished.map((task) => task.id).join(', ')}. Complete them first.`;
              return file;
            }
            file.tasks = [];
            outputMessage = `Cleared ${n} task${n === 1 ? '' : 's'}.`;
            break;
          }
          default:
            outputMessage =
              unknownSubcommand(
                cmd,
                [
                  'show',
                  'add',
                  'start',
                  'done',
                  'fail',
                  'status',
                  'depends',
                  'assign',
                  'promote',
                  'planify',
                  'clear',
                ],
                'tasks',
              ) + '\n\nRelated: /plan (session-persistent roadmap) | /todos (per-turn list)';
            return file;
        }
        return file;
      });

      if (todosToReplace) {
        await todoTool.execute({ todos: todosToReplace }, ctx, {
          signal: AbortSignal.timeout(30_000),
        });
      }

      if (completedTask) {
        // Ledger update: in-memory evidence + [completed_work_ledger] system
        // prompt block (both via the recorder), then the durable checkpoint
        // when the session has one configured. Failures must not undo the
        // task-status change the user asked for — surface, don't throw.
        const done = completedTask as { id: string; title: string };
        try {
          recordCompletedWorkEvidence(ctx, {
            key: `task:${done.id}`,
            source: 'task',
            summary: done.title,
          });
          const completedWorkPath = (ctx.meta as Record<string, unknown>)?.['completedWork.path'];
          if (typeof completedWorkPath === 'string' && completedWorkPath) {
            await saveCompletedWorkCheckpoint(
              completedWorkPath,
              sessionId,
              ctx.contextEvidence?.completedWork ?? [],
            );
          }
        } catch (err) {
          outputMessage += `\n⚠ Completed-work ledger update failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      return { message: outputMessage };
    },
  };
}
