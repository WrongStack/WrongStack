import { randomUUID } from 'node:crypto';
import type { TaskFile } from '@wrongstack/core/storage';
import {
  addPlanItem,
  formatPlan,
  loadTasks,
  mutatePlan,
  mutateTasks,
} from '@wrongstack/core/storage';
import type { TaskStatus, Tool } from '@wrongstack/core/types';
import { computeTaskItemProgress, formatTaskList, type TaskItem } from '@wrongstack/core/utils';
import { mirrorSessionTasksToKanban } from './session-kanban.js';
import { todoTool } from './todo.js';

// ---------------------------------------------------------------------------
// Task tool — structured work items with dependencies, types, and priorities.
// Unlike `todo` (flat, session-scoped), tasks support:
//   - Dependencies (task can depend on other tasks)
//   - Type classification (feature, bugfix, refactor, docs, test, chore)
//   - Priority ranking (critical, high, medium, low)
//   - Assignment (which agent/subagent)
//   - Estimates (hours)
//
// Like `todo`, the list is fully replaced on every call. Session-persistent:
// stored at `ctx.meta['task.path']` and isolated to this session — other sessions
// have their own separate task lists.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Find a task by 1-based index, exact id, or case-insensitive title substring. */
function findTaskIndex(tasks: TaskItem[], query: string): number {
  const asNum = Number.parseInt(query, 10);
  if (!Number.isNaN(asNum)) {
    const idx = asNum - 1;
    if (tasks[idx]) return idx;
  }
  const byId = tasks.findIndex((t) => t.id === query);
  if (byId >= 0) return byId;
  const lower = query.toLowerCase();
  return tasks.findIndex((t) => t.title.toLowerCase().includes(lower));
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

type TaskReplacementItem = Omit<TaskItem, 'createdAt' | 'updatedAt'> &
  Partial<Pick<TaskItem, 'createdAt' | 'updatedAt'>>;

type TaskAdditionItem = Omit<TaskItem, 'id' | 'createdAt' | 'updatedAt' | 'status'> &
  Partial<Pick<TaskItem, 'status'>>;

interface TaskInput {
  /** Replace: set new task list. Add: append a task. Status: update task status. Promote: convert a task to todo items. */
  action: 'replace' | 'add' | 'status' | 'show' | 'promote' | 'planify';
  /** Full task list for action=replace. */
  tasks?: TaskReplacementItem[] | undefined;
  /** Single task for action=add. id, createdAt, updatedAt are auto-generated. */
  task?: TaskAdditionItem | undefined;
  /** Task id for action=status or target for action=promote. */
  id?: string | undefined;
  /** New status for action=status. */
  status?: TaskStatus | undefined;
  /** Target task (id, 1-based index, or title substring) for action=promote. */
  target?: string | undefined;
  /** Optional subtask titles for action=promote. */
  subtasks?: string[] | undefined;
  /**
   * Storage scope. Default (unset): uses the session-scoped path — isolated to this
   * session, survives resume within the same session.
   * `scope: 'project'`: uses a shared project-level path, visible to all sessions
   * for this project. Useful for a shared backlog that outlasts any single session.
   */
  scope?: 'session' | 'project';
}

interface TaskOutput {
  ok: boolean;
  message: string;
  count: number;
  completed: number;
  inProgress: number;
}

export const taskTool: Tool<TaskInput, TaskOutput> = {
  name: 'task',
  category: 'Session',
  description:
    'Manage session-persistent structured work items with dependencies, types, and priorities. ' +
    'Unlike `todo` (flat, tactical), `task` supports typed work (feature/bugfix/refactor/etc.), ' +
    'dependencies between items, priority ranking, and agent assignment. ' +
    'Tasks are written to disk and survive session resumes. By default they are isolated to this session; ' +
    'use `scope: "project"` to store tasks in a shared project-level file visible to all sessions.',
  usageHint:
    'USE FOR STRUCTURED WORK:\n' +
    '- `action: "replace"` — replace task details/order without omitting unfinished persisted tasks\n' +
    '- `action: "add"` — append a single task\n' +
    '- `action: "status"` — update a task\'s status (e.g. pending→in_progress, in_progress→completed)\n' +
    '- `action: "show"` — view current tasks without changing them\n' +
    '- `action: "promote"` — convert a task into actionable todo items via `target` (id|index|substring)\n' +
    '- `action: "planify"` — promote a task to a plan item (strategic level) via `target` (id|index|substring)\n\n' +
    'Task fields:\n' +
    '- `dependsOn`: list of task IDs this one waits for\n' +
    '- `type`: "feature" | "bugfix" | "refactor" | "docs" | "test" | "chore"\n' +
    '- `priority`: "critical" | "high" | "medium" | "low"\n' +
    '- `assignee`: agent/subagent name (e.g. "bug-hunter", "refactor-planner")\n' +
    '- `estimateHours`: rough time estimate\n' +
    '- `scope`: "session" (default, isolated) or "project" (shared across sessions)',
  permission: 'confirm',
  mutating: true,
  subjectKey: 'action',
  capabilities: ['fs.write'],
  icon: 'task',
  timeoutMs: 5_000,
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['replace', 'add', 'status', 'show', 'promote', 'planify'],
        description:
          'replace = set full list, add = append, status = update task status, show = view only, promote = convert task to todos, planify = convert task to plan item.',
      },
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Unique id (e.g. "t1", "auth-flow").' },
            title: { type: 'string', description: 'Short title.' },
            description: { type: 'string', description: 'Optional details.' },
            type: {
              type: 'string',
              enum: ['feature', 'bugfix', 'refactor', 'docs', 'test', 'chore'],
            },
            priority: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'blocked', 'failed', 'review', 'completed'],
            },
            dependsOn: {
              type: 'array',
              items: { type: 'string' },
              description: 'IDs of tasks this one depends on.',
            },
            assignee: { type: 'string', description: 'Agent/subagent assigned.' },
            estimateHours: { type: 'number', description: 'Estimated hours.' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags.' },
            createdAt: { type: 'string' },
            updatedAt: { type: 'string' },
          },
          required: ['id', 'title', 'type', 'priority', 'status'],
        },
        description:
          'Complete desired task list. Existing unfinished tasks may not be omitted; complete them first.',
      },
      task: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          type: {
            type: 'string',
            enum: ['feature', 'bugfix', 'refactor', 'docs', 'test', 'chore'],
          },
          priority: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          status: {
            type: 'string',
            enum: ['pending', 'in_progress', 'blocked', 'failed', 'review', 'completed'],
          },
          dependsOn: { type: 'array', items: { type: 'string' } },
          assignee: { type: 'string' },
          estimateHours: { type: 'number' },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['title', 'type', 'priority'],
        description: 'Single task to append (id/createdAt/updatedAt auto-generated).',
      },
      id: {
        type: 'string',
        description: 'Task id for action=status or target for action=promote.',
      },
      status: {
        type: 'string',
        enum: ['pending', 'in_progress', 'blocked', 'failed', 'review', 'completed'],
        description: 'New status for action=status.',
      },
      target: {
        type: 'string',
        description:
          'Target task identifier (id, 1-based index, or title substring) for action=promote.',
      },
      subtasks: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional subtask titles for action=promote. Each becomes a pending todo.',
      },
      scope: {
        type: 'string',
        enum: ['session', 'project'],
        description:
          'Storage scope: "session" (default, isolated to this session) or "project" (shared across all sessions for this project).',
      },
    },
    required: ['action'],
  },
  async execute(input, ctx, _opts) {
    const signal = _opts?.signal ?? ctx?.signal;
    signal?.throwIfAborted();
    const meta = ((ctx.meta ??= {}) as Record<string, unknown>);
    const sessionTaskPath = meta['task.path'] as string | undefined;
    let taskPath: string | undefined;

    if (input.scope === 'project') {
      // Project-level: derive from the session path by replacing the filename with
      // 'backlog.tasks.json' so all sessions share the same file.
      if (typeof sessionTaskPath === 'string') {
        // Handle BOTH separators — a Windows-native path uses '\\'; a '/'-only
        // search would miss it and fall back to a bare relative path written
        // into the process CWD instead of the sessions dir.
        const lastSep = Math.max(
          sessionTaskPath.lastIndexOf('/'),
          sessionTaskPath.lastIndexOf('\\'),
        );
        taskPath =
          lastSep >= 0
            ? sessionTaskPath.slice(0, lastSep + 1) + 'backlog.tasks.json'
            : 'backlog.tasks.json';
      }
    } else {
      taskPath = sessionTaskPath;
    }

    if (typeof taskPath !== 'string' || !taskPath) {
      return {
        ok: false,
        message: 'Task storage path not configured.',
        count: 0,
        completed: 0,
        inProgress: 0,
      };
    }
    const sessionId = ctx.session?.id ?? 'unknown';

    if (input.action === 'show') {
      meta['task.path.resolved'] = taskPath;
      const file = (await loadTasks(taskPath)) ?? { version: 1, tasks: [] };
      const p = computeTaskItemProgress(file.tasks);
      const summary = file.tasks.length > 0 ? formatTaskList(file.tasks) : 'No tasks.';
      return {
        ok: true,
        message: summary,
        count: file.tasks.length,
        completed: p.completed,
        inProgress: p.inProgress,
      };
    }

    // Early-return result for validation errors that happen before or
    // during the critical section. The lock callback sets this instead of
    // mutating the file, and we return it after the lock releases.
    let early: TaskOutput | null = null;
    // Track promote output for the custom message
    const promoteMeta = { count: 0, title: '' };
    // Track planify data — written to plan file after the task lock releases
    const planifyMeta = { title: '', details: '' };
    let didPlanify = false;
    // collect todos to replace — called AFTER mutateTasks so rollback is possible
    type TodosReplacement = Array<{
      id: string;
      content: string;
      status: 'pending' | 'in_progress' | 'completed';
      activeForm?: string;
      promotedFromTask?: string;
    }>;
    let todosToReplace: TodosReplacement | null = null;

    let file: TaskFile;
    try {
      file = await mutateTasks(taskPath, sessionId, async (f: TaskFile) => {
        switch (input.action) {
          case 'show':
            // read-only — handled above
            break;

          case 'replace': {
            if (!Array.isArray(input.tasks)) {
              early = {
                ok: false,
                message: 'action=replace requires `tasks` array.',
                count: 0,
                completed: 0,
                inProgress: 0,
              };
              return f;
            }
            // Validate id uniqueness: findTaskIndex / status resolve a task by
            // the FIRST id match, so a duplicate id silently becomes unaddressable.
            const newIds = new Set(input.tasks.map((t) => t.id));
            if (newIds.size !== input.tasks.length) {
              const seen = new Set<string>();
              const dupes = [
                ...new Set(
                  input.tasks
                    .map((t) => t.id)
                    .filter((id) => {
                      if (seen.has(id)) return true;
                      seen.add(id);
                      return false;
                    }),
                ),
              ];
              early = {
                ok: false,
                message: `action=replace has duplicate task IDs: ${dupes.join(', ')}. Each task id must be unique.`,
                count: 0,
                completed: 0,
                inProgress: 0,
              };
              return f;
            }
            const omittedUnfinished = f.tasks.filter(
              (task) => task.status !== 'completed' && !newIds.has(task.id),
            );
            if (omittedUnfinished.length > 0) {
              early = {
                ok: false,
                message: `action=replace cannot omit unfinished tasks: ${omittedUnfinished.map((task) => task.id).join(', ')}. Complete them first.`,
                count: f.tasks.length,
                ...computeTaskItemProgress(f.tasks),
              };
              return f;
            }
            // Validate dependsOn references: must point to IDs within the new batch
            const taskStatusById = new Map(input.tasks.map((t) => [t.id, t.status]));
            for (const t of input.tasks) {
              if (t.dependsOn && t.dependsOn.length > 0) {
                const missing = t.dependsOn.filter((d) => !newIds.has(d));
                if (missing.length > 0) {
                  early = {
                    ok: false,
                    message: `dependsOn validation failed: task "${t.id}" references unknown IDs: ${missing.join(', ')}`,
                    count: 0,
                    completed: 0,
                    inProgress: 0,
                  };
                  return f;
                }
              }
              if (t.status === 'in_progress' || t.status === 'completed') {
                const unmet = (t.dependsOn ?? []).filter(
                  (dependencyId) => taskStatusById.get(dependencyId) !== 'completed',
                );
                if (unmet.length > 0) {
                  early = {
                    ok: false,
                    message: `dependency status validation failed: task "${t.id}" cannot be ${t.status} before completion of ${unmet.join(', ')}.`,
                    count: f.tasks.length,
                    ...computeTaskItemProgress(f.tasks),
                  };
                  return f;
                }
              }
            }
            const now = new Date().toISOString();
            f.tasks = input.tasks.map((t) => ({
              ...t,
              createdAt: t.createdAt || now,
              updatedAt: now,
            }));
            break;
          }

          case 'add': {
            const t = input.task;
            if (!t?.title) {
              early = {
                ok: false,
                message: 'action=add requires `task` with at least `title`.',
                count: 0,
                completed: 0,
                inProgress: 0,
              };
              return f;
            }
            // Validate dependsOn: all referenced IDs must exist in the current task list
            if (t.dependsOn && t.dependsOn.length > 0) {
              const existingIds = new Set(f.tasks.map((e: TaskItem) => e.id));
              const missing = t.dependsOn.filter((d) => !existingIds.has(d));
              if (missing.length > 0) {
                early = {
                  ok: false,
                  message: `dependsOn validation failed: unknown task IDs: ${missing.join(', ')}`,
                  count: 0,
                  completed: 0,
                  inProgress: 0,
                };
                return f;
              }
            }
            const now = new Date().toISOString();
            const newTask: TaskItem = {
              id: `task_${Date.now()}_${randomUUID().slice(0, 8)}`,
              title: t.title,
              description: t.description,
              type: t.type || 'feature',
              priority: t.priority || 'medium',
              status: t.status || 'pending',
              dependsOn: t.dependsOn,
              assignee: t.assignee,
              estimateHours: t.estimateHours,
              tags: t.tags,
              createdAt: now,
              updatedAt: now,
            };
            f.tasks.push(newTask);
            break;
          }

          case 'status': {
            if (!input.id || !input.status) {
              early = {
                ok: false,
                message: 'action=status requires `id` and `status`.',
                count: 0,
                completed: 0,
                inProgress: 0,
              };
              return f;
            }
            const task = f.tasks.find((t: TaskItem) => t.id === input.id);
            if (!task) {
              early = {
                ok: false,
                message: `Task "${input.id}" not found.`,
                count: 0,
                completed: 0,
                inProgress: 0,
              };
              return f;
            }
            if (input.status === 'in_progress' || input.status === 'completed') {
              const unmet = (task.dependsOn ?? []).filter(
                (dependencyId) =>
                  f.tasks.find((candidate) => candidate.id === dependencyId)?.status !==
                  'completed',
              );
              if (unmet.length > 0) {
                early = {
                  ok: false,
                  message: `Task "${task.id}" cannot be ${input.status} before dependencies complete: ${unmet.join(', ')}.`,
                  count: f.tasks.length,
                  ...computeTaskItemProgress(f.tasks),
                };
                return f;
              }
            }
            task.status = input.status;
            task.updatedAt = new Date().toISOString();
            break;
          }

          case 'promote': {
            const target = input.target?.trim();
            if (!target) {
              early = {
                ok: false,
                message: 'action=promote requires `target` (task id, index, or title substring).',
                count: 0,
                completed: 0,
                inProgress: 0,
              };
              return f;
            }
            const idx = findTaskIndex(f.tasks, target);
            if (idx === -1) {
              early = {
                ok: false,
                message: `No task matched "${target}".`,
                count: 0,
                completed: 0,
                inProgress: 0,
              };
              return f;
            }
            const match = f.tasks[idx];
            /* v8 ignore next 4 -- findTaskIndex returned a valid in-range idx, so match is always defined; defensive. */
            if (!match) {
              early = {
                ok: false,
                message: `No task matched "${target}".`,
                count: 0,
                completed: 0,
                inProgress: 0,
              };
              return f;
            }

            // Mark task in_progress
            if (match.status !== 'completed' && match.status !== 'failed') {
              match.status = 'in_progress';
              match.updatedAt = new Date().toISOString();
            }

            // Build todo items
            const todos: Array<{
              id: string;
              content: string;
              status: 'pending' | 'in_progress' | 'completed';
              activeForm?: string;
              promotedFromTask?: string;
            }> = [];
            const ts = Date.now();
            todos.push({
              id: `todo_${ts}_task`,
              content: match.title,
              status: 'in_progress',
              activeForm: match.title,
              promotedFromTask: match.id,
            });

            if (match.description) {
              todos.push({
                id: `todo_${ts}_${randomUUID().slice(0, 6)}`,
                content: match.description.slice(0, 200),
                status: 'pending',
                promotedFromTask: match.id,
              });
            }

            if (input.subtasks && input.subtasks.length > 0) {
              for (const st of input.subtasks) {
                todos.push({
                  id: `todo_${ts}_${randomUUID().slice(0, 6)}`,
                  content: st,
                  status: 'pending',
                  promotedFromTask: match.id,
                });
              }
            }

            todosToReplace = todos;
            promoteMeta.count = todos.length;
            promoteMeta.title = match.title;
            break;
          }

          case 'planify': {
            const target = input.target?.trim();
            if (!target) {
              early = {
                ok: false,
                message: 'action=planify requires `target` (task id, index, or title substring).',
                count: 0,
                completed: 0,
                inProgress: 0,
              };
              return f;
            }
            const idx = findTaskIndex(f.tasks, target);
            if (idx === -1) {
              early = {
                ok: false,
                message: `No task matched "${target}".`,
                count: 0,
                completed: 0,
                inProgress: 0,
              };
              return f;
            }
            const match = f.tasks[idx];
            /* v8 ignore next 4 -- findTaskIndex returned a valid in-range idx, so match is always defined; defensive. */
            if (!match) {
              early = {
                ok: false,
                message: `No task matched "${target}".`,
                count: 0,
                completed: 0,
                inProgress: 0,
              };
              return f;
            }
            // Extract data — plan write happens after the task lock releases
            planifyMeta.title = match.title;
            planifyMeta.details = match.description ?? '';
            didPlanify = true;
            // Do NOT mutate the task — just copy to plan
            break;
          }

          default:
            early = {
              ok: false,
              message: `Unknown action "${(input as { action: string }).action}". Use replace | add | status | show | promote | planify.`,
              count: 0,
              completed: 0,
              inProgress: 0,
            };
            return f;
        }

        return f;
      });
    } catch (err) {
      // Persist failed (mutateTasks throws on a failed save) — report ok:false
      // instead of falsely claiming the tasks were saved.
      return {
        ok: false,
        message: `Task change not saved — ${err instanceof Error ? err.message : String(err)}`,
        count: 0,
        completed: 0,
        inProgress: 0,
      };
    }

    // Record the path this call ACTUALLY wrote (session or derived project
    // backlog) so todo's promotedFromTask rollup follows the real file. The
    // seeded 'task.path' stays untouched — it anchors scope derivation above.
    (ctx.meta as Record<string, unknown>)['task.path.resolved'] = taskPath;

    // Apply todo replacements after the task file mutation succeeds so that
    // on error the state is rolled back cleanly.
    if (todosToReplace) {
      await todoTool.execute({ todos: todosToReplace }, ctx, {
        signal: AbortSignal.timeout(30_000),
      });
    }

    // The task sidecar is already durable. Queue the Kanban projection so a
    // contended board lock cannot consume the tool's timeout budget; the
    // bounded mirror queue logs failures and retries the newest snapshot.
    mirrorSessionTasksToKanban(ctx.projectRoot, file.tasks, sessionId);

    // If the callback set an early-return result, use it
    if (early) return early;

    // If planify copied task data, write it to the plan file now
    if (didPlanify) {
      const { title, details } = planifyMeta;
      const planPathRaw = (ctx.meta as Record<string, unknown>)['plan.path'];
      const prog = computeTaskItemProgress(file.tasks);
      if (typeof planPathRaw === 'string' && planPathRaw) {
        let planPath: string = planPathRaw;
        // Honor project scope for the PLAN file too (mirror of plan.ts taskify);
        // handle both separators.
        if (input.scope === 'project') {
          const lastSep = Math.max(planPath.lastIndexOf('/'), planPath.lastIndexOf('\\'));
          planPath =
            lastSep >= 0
              ? planPath.slice(0, lastSep + 1) + 'backlog.plan.json'
              : 'backlog.plan.json';
        }
        // Mutate the cross-file under ITS OWN lock so a concurrent plan tool
        // call in the same batch can't clobber the write.
        let formatted = '';
        try {
          await mutatePlan(planPath, sessionId, (pf) => {
            const { plan: updated } = addPlanItem(pf, title, details || undefined);
            formatted = formatPlan(updated);
            return updated;
          });
          // Same contract as 'task.path.resolved': the plan rollup follows the
          // file this call actually wrote.
          (ctx.meta as Record<string, unknown>)['plan.path.resolved'] = planPath;
        } catch (err) {
          return {
            ok: false,
            message: `planify: plan not saved — ${err instanceof Error ? err.message : String(err)}`,
            count: file.tasks.length,
            completed: prog.completed,
            inProgress: prog.inProgress,
          };
        }
        return {
          ok: true,
          message: `planify ok — added "${title}" to plan.\n${formatted}`,
          count: file.tasks.length,
          completed: prog.completed,
          inProgress: prog.inProgress,
        };
      }
      // Plan path missing — still report the REAL task counts (the task file was
      // loaded and may be non-empty), not zeros.
      return {
        ok: false,
        message: 'Plan storage path not configured — cannot planify.',
        count: file.tasks.length,
        completed: prog.completed,
        inProgress: prog.inProgress,
      };
    }

    const p = computeTaskItemProgress(file.tasks);
    const summary =
      promoteMeta.count > 0
        ? `promote ok — ${promoteMeta.count} todo(s) created from "${promoteMeta.title}".\n${formatTaskList(file.tasks)}`
        : file.tasks.length > 0
          ? formatTaskList(file.tasks)
          : 'No tasks.';
    return {
      ok: true,
      message: summary,
      count: file.tasks.length,
      completed: p.completed,
      inProgress: p.inProgress,
    };
  },
};
