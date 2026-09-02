import { randomUUID } from 'node:crypto';
import {
  addPlanItem,
  clearPlan,
  deriveTodosFromPlanItem,
  formatPlan,
  getPlanTemplate,
  loadPlan,
  mutatePlan,
  mutateTasks,
  type PlanFile,
  removePlanItem,
  setPlanItemStatus,
  type TaskFile,
} from '@wrongstack/core/storage';
import type { Tool } from '@wrongstack/core/types';
import { ToolValidationError } from '@wrongstack/core/types';
import { formatTaskList } from '@wrongstack/core/utils';
import { projectSessionPlanToKanban } from './session-kanban.js';
import { todoTool } from './todo.js';

/**
 * `planTool` — the LLM-callable counterpart to the `/plan` slash command.
 *
 * Plans capture strategic, multi-step approaches that survive across
 * session resumes (unlike todos, which are tactical and per-turn).
 * Storage path comes from `ctx.meta['plan.path']` — the CLI seeds this
 * during startup so the tool always knows where to read/write.
 *
 * One tool, multiple actions, JSON in/out. The action discriminates the
 * operation so the LLM can do show / add / start / done / remove / promote /
 * derive / template_use / clear via a single tool registration instead of
 * bloating the surface with nine near-identical tools.
 */
interface PlanInput {
  action:
    | 'show'
    | 'add'
    | 'status'
    | 'start'
    | 'done'
    | 'remove'
    | 'promote'
    | 'template_use'
    | 'clear'
    | 'taskify';
  /** Required for add. */
  title?: string | undefined;
  /** Optional detail line for add. */
  details?: string | undefined;
  /** Required for start/done/remove/promote — accepts plan item id OR 1-based index OR title substring. */
  target?: string | undefined;
  /** Exact status for action=status. */
  status?: PlanFile['items'][number]['status'] | undefined;
  /** Optional subtasks for promote. If omitted, a single todo is created from the plan item title. */
  subtasks?: string[] | undefined;
  /** Required for template_use — the template name (e.g. "new-feature", "bug-fix"). */
  template?: string | undefined;
  /**
   * Storage scope. Default (unset): uses the session-scoped path — isolated to this
   * session, survives resume within the same session.
   * `scope: 'project'`: uses a shared project-level path, visible to all sessions
   * for this project. Useful for a shared roadmap that outlasts any single session.
   */
  scope?: 'session' | 'project';
}

interface PlanOutput {
  ok: boolean;
  message: string;
  /** Formatted plan after the operation. Same string the user sees from `/plan show`. */
  plan: string;
  /** Total item count after the operation. */
  count: number;
  /** Number of items not in 'done' status. */
  open: number;
  /** When promote/derive succeed, the generated todo items so the caller can inspect them. */
  todos?: Array<{
    id: string;
    content: string;
    status: string;
    activeForm?: string | undefined;
    promotedFromPlan?: string | undefined;
  }>;
}

export const planTool: Tool<PlanInput, PlanOutput> = {
  name: 'plan',
  category: 'Session',
  description:
    'Manage a session-persistent strategic plan. The plan is written to disk and survives conversation resumptions within the same session, but is isolated to this session — other sessions have their own separate plans. ' +
    'Unlike todos (which are per-turn and lost on restart), a plan tracks high-level progress across multiple turns. ' +
    'Use this to outline big-picture work, then promote concrete items into the todo list when ready to execute. ' +
    'By default plans are isolated to this session; use `scope: "project"` to store the plan in a shared project-level file visible to all sessions.',
  usageHint:
    'RECOMMENDED FOR COMPLEX, MULTI-PHASE WORK:\n\n' +
    '- Start by creating a high-level plan with `action: "add"` or using templates (`template_use`).\n' +
    '- Use `action: "status"` with `open`, `in_progress`, or `done` for exact status changes.\n' +
    '- Use `promote` to turn a plan item into actionable todos.\n' +
    '- Use `taskify` to convert a plan item into a structured task (with type/priority/deps).\n' +
    '- Unfinished plan items cannot be removed or cleared; complete them first.\n' +
    '- Keep plans at the "why and what" level, and todos at the "how and next step" level.\n' +
    '- Common templates: "new-feature", "bug-fix", "refactor", "release", "security-audit".\n\n' +
    'This tool is excellent for maintaining long-term direction across many turns within a session. Plans survive resume but are not shared across separate sessions.\n' +
    'Use `scope: "project"` to use a shared project-level plan file.',
  permission: 'confirm',
  // WS-046: gives permission decisions something to key on.
  // The action performed; plan has no single file or path subject.
  subjectKey: 'action',
  mutating: true,
  capabilities: ['fs.write'],
  icon: 'plan',
  timeoutMs: 30_000,
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [
          'show',
          'add',
          'status',
          'start',
          'done',
          'remove',
          'promote',
          'template_use',
          'clear',
          'taskify',
        ],
        description: 'The operation to perform on the plan board.',
      },
      title: {
        type: 'string',
        description: 'Title of the plan item. Required for action=add.',
      },
      details: {
        type: 'string',
        description: 'Additional details or description for a new plan item (action=add).',
      },
      target: {
        type: 'string',
        description:
          'Identifier for the target plan item (id, 1-based index, or partial title). Required for most actions except add/show/clear.',
      },
      status: {
        type: 'string',
        enum: ['open', 'in_progress', 'done'],
        description: 'Exact plan item status for action=status.',
      },
      subtasks: {
        type: 'array',
        items: { type: 'string' },
        description:
          'List of subtask titles. Used with promote to break a plan item into multiple todos.',
      },
      template: {
        type: 'string',
        description:
          'Template identifier when using action=template_use. Common values: new-feature, bug-fix, refactor, release, security-audit.',
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

    const VALID_ACTIONS: ReadonlySet<string> = new Set([
      'show',
      'add',
      'status',
      'start',
      'done',
      'remove',
      'promote',
      'template_use',
      'clear',
      'taskify',
    ]);
    if (!input?.action || !VALID_ACTIONS.has(input.action)) {
      throw new ToolValidationError({
        message: `plan: unknown or missing action "${input?.action}". Allowed actions: ${[...VALID_ACTIONS].join(', ')}`,
        field: 'action',
      });
    }

    if (input.scope !== undefined && input.scope !== 'session' && input.scope !== 'project') {
      throw new ToolValidationError({
        message: `plan: invalid scope "${input.scope}". Allowed: session, project`,
        field: 'scope',
      });
    }

    const meta = (ctx.meta ??= {}) as Record<string, unknown>;
    const sessionPlanPath = meta['plan.path'] as string | undefined;
    let planPath: string | undefined;

    if (input.scope === 'project') {
      // Project-level: derive from the session path by replacing the filename with
      // 'backlog.plan.json' so all sessions share the same file.
      if (typeof sessionPlanPath === 'string') {
        // Handle BOTH separators — a Windows-native path uses '\\', and a
        // '/'-only search would miss it and fall back to a bare relative path
        // written into the process CWD instead of the sessions dir.
        const lastSep = Math.max(
          sessionPlanPath.lastIndexOf('/'),
          sessionPlanPath.lastIndexOf('\\'),
        );
        if (lastSep < 0) {
          // A separator-less session path has no directory to anchor the shared
          // file to; silently deriving a CWD-relative 'backlog.plan.json' would
          // scatter project plans across whatever directory the process happens
          // to run in. Refuse explicitly instead.
          return {
            ok: false,
            message: `Cannot derive the project-scoped plan path: session plan path "${sessionPlanPath}" has no directory component.`,
            plan: '',
            count: 0,
            open: 0,
          };
        }
        planPath = sessionPlanPath.slice(0, lastSep + 1) + 'backlog.plan.json';
      }
    } else {
      planPath = sessionPlanPath;
    }
    if (typeof planPath !== 'string' || !planPath) {
      return {
        ok: false,
        message: 'Plan storage path is not configured for this session.',
        plan: '',
        count: 0,
        open: 0,
      };
    }
    const sessionId = ctx.session?.id ?? 'unknown';

    if (input.action === 'show') {
      meta['plan.path.resolved'] = planPath;
      const plan = (await loadPlan(planPath)) ?? {
        version: 1,
        sessionId,
        updatedAt: new Date().toISOString(),
        items: [],
      };
      return mkResult(plan, true, 'Plan show ok.');
    }

    let early: PlanOutput | null = null;
    // Track taskify data — task write happens after the plan lock releases
    const taskifyMeta = { title: '', details: '' };
    let didTaskify = false;
    let todosToReplace: NonNullable<PlanOutput['todos']> | null = null;

    let plan: PlanFile;
    try {
      plan = await mutatePlan(planPath, sessionId, async (p) => {
        switch (input.action) {
          case 'show':
            break;

          case 'add': {
            const title = input.title?.trim();
            if (!title) {
              early = mkResult(p, false, 'add requires `title`.');
              return p;
            }
            const { plan: updated } = addPlanItem(p, title, input.details?.trim() || undefined);
            return updated;
          }

          case 'start':
          case 'done': {
            if (!input.target) {
              early = mkResult(
                p,
                false,
                `${input.action} requires \`target\` (id|index|substring).`,
              );
              return p;
            }
            const next = setPlanItemStatus(
              p,
              input.target,
              input.action === 'start' ? 'in_progress' : 'done',
            );
            if (next === p) {
              early = mkResult(p, false, `No plan item matched "${input.target}".`);
              return p;
            }
            return next;
          }

          case 'status': {
            const VALID_PLAN_STATUSES: ReadonlySet<string> = new Set(['open', 'in_progress', 'done']);
            if (!input.target || !input.status) {
              early = mkResult(
                p,
                false,
                'status requires `target` (id|index|substring) and `status`.',
              );
              return p;
            }
            if (!VALID_PLAN_STATUSES.has(input.status)) {
              early = mkResult(
                p,
                false,
                `status requires valid status ('open' | 'in_progress' | 'done'), got "${input.status}".`,
              );
              return p;
            }
            const next = setPlanItemStatus(p, input.target, input.status);
            if (next === p) {
              early = mkResult(p, false, `No plan item matched "${input.target}".`);
              return p;
            }
            return next;
          }

          case 'remove': {
            if (!input.target) {
              early = mkResult(p, false, 'remove requires `target` (id|index|substring).');
              return p;
            }
            const next = removePlanItem(p, input.target);
            if (next === p) {
              early = mkResult(p, false, `No plan item matched "${input.target}".`);
              return p;
            }
            const nextIds = new Set(next.items.map((item) => item.id));
            const removed = p.items.find((item) => !nextIds.has(item.id));
            if (removed?.status !== 'done') {
              early = mkResult(
                p,
                false,
                `Plan item "${removed?.title ?? input.target}" is not done and cannot be removed. Complete it first.`,
              );
              return p;
            }
            return next;
          }

          case 'promote': {
            if (!input.target) {
              early = mkResult(
                p,
                false,
                `${input.action} requires \`target\` (id|index|substring).`,
              );
              return p;
            }
            const derived = deriveTodosFromPlanItem(p, input.target, input.subtasks);
            if (!derived) {
              early = mkResult(p, false, `No plan item matched "${input.target}".`);
              return p;
            }
            todosToReplace = derived.todos;
            early = mkResult(
              derived.plan,
              true,
              `${input.action} ok — ${derived.todos.length} todo(s) created.`,
              derived.todos,
            );
            return derived.plan;
          }

          case 'template_use': {
            const templateName = input.template?.trim();
            if (!templateName) {
              early = mkResult(p, false, 'template_use requires `template` name.');
              return p;
            }
            const template = getPlanTemplate(templateName);
            if (!template) {
              early = mkResult(p, false, `Unknown template "${templateName}".`);
              return p;
            }
            let updated = p;
            for (const item of template.items) {
              ({ plan: updated } = addPlanItem(updated, item.title, item.details));
            }
            early = mkResult(
              updated,
              true,
              `Applied template "${template.name}" — ${template.items.length} items added.`,
            );
            return updated;
          }

          case 'clear':
            if (p.items.some((item) => item.status !== 'done')) {
              early = mkResult(
                p,
                false,
                'Plan contains unfinished items and cannot be cleared. Complete them first.',
              );
              return p;
            }
            return clearPlan(p);

          case 'taskify': {
            if (!input.target) {
              early = mkResult(
                p,
                false,
                'taskify requires `target` (plan item id|index|substring).',
              );
              return p;
            }
            // Find plan item by 1-based index, exact id, or title substring
            let itemIdx = -1;
            const asNum = Number.parseInt(input.target, 10);
            if (!Number.isNaN(asNum) && asNum >= 1 && asNum <= p.items.length) {
              itemIdx = asNum - 1;
            } else {
              itemIdx = p.items.findIndex((it) => it.id === input.target);
              if (itemIdx === -1) {
                const lower = input.target.toLowerCase();
                itemIdx = p.items.findIndex((it) => it.title.toLowerCase().includes(lower));
              }
            }
            if (itemIdx === -1 || !p.items[itemIdx]) {
              early = mkResult(p, false, `No plan item matched "${input.target}".`);
              return p;
            }
            const item = p.items[itemIdx]!;
            // Extract data — task write happens after the plan lock releases
            taskifyMeta.title = item.title;
            taskifyMeta.details = item.details ?? '';
            didTaskify = true;
            break;
          }

          default:
            early = mkResult(p, false, `Unknown action "${(input as { action: string }).action}".`);
            return p;
        }

        return p;
      });
    } catch (err) {
      // Persist failed (mutatePlan throws on a failed save) — report ok:false
      // with the real reason instead of falsely claiming the plan was saved.
      return {
        ok: false,
        message: `Plan change not saved — ${err instanceof Error ? err.message : String(err)}`,
        plan: '',
        count: 0,
        open: 0,
      };
    }

    // Record the path this call ACTUALLY wrote (session or derived project
    // backlog) so todo's promotedFromPlan rollup follows the real file. The
    // seeded 'plan.path' stays untouched — it anchors scope derivation above.
    (ctx.meta as Record<string, unknown>)['plan.path.resolved'] = planPath;

    // A successful plan mutation includes its projection onto the unified
    // session board; callers never observe plan state ahead of Kanban state.
    await projectSessionPlanToKanban(ctx.projectRoot, plan.items, sessionId);

    if (todosToReplace) {
      await todoTool.execute({ todos: todosToReplace }, ctx, {
        signal: AbortSignal.timeout(30_000),
      });
    }

    // If the callback set an early-return result, use it
    if (early) return early;

    // If taskify copied plan item data, write it to the task file now
    if (didTaskify) {
      const taskPathRaw = (ctx.meta as Record<string, unknown>)['task.path'];
      if (typeof taskPathRaw !== 'string' || !taskPathRaw) {
        return mkResult(plan, false, 'Task storage path not configured — cannot taskify.');
      }
      let taskPath: string = taskPathRaw;
      // Honor project scope for the TASK file too: a project-scoped taskify must
      // append to the shared backlog.tasks.json, not the per-session task file
      // (mirrors the plan-path derivation above; handles both separators).
      if (input.scope === 'project') {
        const lastSep = Math.max(taskPath.lastIndexOf('/'), taskPath.lastIndexOf('\\'));
        taskPath =
          lastSep >= 0
            ? taskPath.slice(0, lastSep + 1) + 'backlog.tasks.json'
            : 'backlog.tasks.json';
      }
      const now = new Date().toISOString();
      // Mutate the cross-file under ITS OWN lock — a raw loadTasks/push/saveTasks
      // can interleave with a concurrent task tool call in the same batch and
      // clobber writes. mutateTasks is the documented race-safe write path.
      try {
        const taskFile: TaskFile = await mutateTasks(taskPath, sessionId, (f) => {
          f.tasks.push({
            id: `task_${randomUUID()}`,
            title: taskifyMeta.title,
            description: taskifyMeta.details || undefined,
            type: 'feature',
            priority: 'medium',
            status: 'pending',
            createdAt: now,
            updatedAt: now,
          });
          return f;
        });
        // Same contract as 'plan.path.resolved': the task rollup follows the
        // file this call actually wrote.
        (ctx.meta as Record<string, unknown>)['task.path.resolved'] = taskPath;
        return mkResult(
          plan,
          true,
          `taskify ok — added "${taskifyMeta.title}" to tasks.\n${formatTaskList(taskFile.tasks)}`,
        );
      } catch (err) {
        // The plan item was saved, but copying it into the task file failed.
        return mkResult(
          plan,
          false,
          `taskify: task not saved — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return mkResult(plan, true, `Plan ${input.action} ok.`);
  },
};

function mkResult(
  plan: PlanFile,
  ok: boolean,
  message: string,
  todos?: PlanOutput['todos'],
): PlanOutput {
  let open = 0;
  for (let i = 0; i < plan.items.length; i++) {
    if (plan.items[i]!.status !== 'done') open++;
  }
  const result: PlanOutput = {
    ok,
    message,
    plan: formatPlan(plan),
    count: plan.items.length,
    open,
  };
  if (todos !== undefined) result.todos = todos;
  return result;
}
