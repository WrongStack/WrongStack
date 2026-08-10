import {
  addPlanItem,
  clearPlan,
  deriveTodosFromPlanItem,
  emptyPlan,
  emptyTaskFile,
  formatPlan,
  formatPlanTemplates,
  getPlanTemplate,
  listPlanTemplates,
  loadPlan,
  loadTasks,
  mutatePlan,
  type PlanFile,
  removePlanItem,
  saveTasks,
  setPlanItemStatus,
  type TaskFile,
} from '@wrongstack/core/storage';
import type { SlashCommand } from '@wrongstack/core/types';
import { formatTaskList, formatTodosList } from '@wrongstack/core/utils';
import { todoTool } from '@wrongstack/tools';
import type { SlashCommandContext } from './command-context.js';

/** Find a plan item by 1-based index, exact id, or case-insensitive title substring. */
function findPlanItemIndex(plan: PlanFile, query: string): number {
  const asNum = Number.parseInt(query, 10);
  if (!Number.isNaN(asNum) && asNum >= 1 && asNum <= plan.items.length) return asNum - 1;
  const byId = plan.items.findIndex((it) => it.id === query);
  if (byId >= 0) return byId;
  const lower = query.toLowerCase();
  return plan.items.findIndex((it) => it.title.toLowerCase().includes(lower));
}

export function buildPlanCommand(opts: SlashCommandContext): SlashCommand {
  const help = [
    'Usage: /plan [show|add <title>|start <id|#>|done <id|#>|remove <id|#>|promote <id|#> [subtask ...]|derive <id|#> [subtask ...]|taskify <id|#>|template [list|use <name>]|clear] [--json]',
    '',
    'Read-only:',
    '  show | list             Show the persisted strategic plan.',
    '  template [list]         List bundled plan templates.',
    '',
    'Mutating:',
    '  add <title>             Add an open plan item.',
    '  start|done <id|#>       Change an item status.',
    '  remove <id|#>           Remove an item.',
    '  promote|derive <id|#>   Derive live todos from a plan item.',
    '  taskify <id|#>          Copy an item into the task store.',
    '  template use <name>     Append a bundled template.',
    '  clear                   Remove every plan item.',
    '',
    'Use --json for stable output and slash-command metadata backed by the persisted plan.',
  ].join('\n');

  const result = (
    message: string,
    payload: Record<string, unknown>,
    json: boolean,
  ): { message: string; metadata: Record<string, unknown> } => ({
    message: json ? JSON.stringify(payload, null, 2) : message,
    metadata: { plan: payload },
  });

  const errorResult = (code: string, message: string, json: boolean) =>
    result(message, { ok: false, error: { code, message } }, json);

  return {
    name: 'plan',
    category: 'Agent',
    argsHint: '[show|add|start|done|remove|promote|taskify|template|clear] [--json]',
    description:
      'Strategic plan board: /plan [show|add <title>|start <id|#>|done <id|#>|remove <id|#>|promote <id|#> [subtask ...]|derive <id|#> [subtask ...]|taskify <id|#>|template [list|use <name>]|clear]',
    help,
    async run(args: string) {
      const tokens = args
        .trim()
        .split(/\s+/)
        .filter((token) => token && token !== '--json');
      const json = args.trim().split(/\s+/).includes('--json');
      const [verb = '', ...rest] = tokens;
      if (verb === 'help') return { message: help };
      if (!opts.planPath) {
        return errorResult(
          'storage_not_configured',
          'Plan storage is not configured for this session.',
          json,
        );
      }

      const planPath = opts.planPath;
      const sessionId = opts.context?.session?.id ?? 'unknown';
      const restJoined = rest.join(' ').trim();

      // Read-only — no lock
      if (verb === '' || verb === 'show' || verb === 'list') {
        const plan = (await loadPlan(planPath)) ?? emptyPlan(sessionId);
        return result(formatPlan(plan), { ok: true, plan }, json);
      }

      if (verb === 'template' && (rest[0] === undefined || rest[0] === 'list')) {
        const templates = listPlanTemplates();
        return result(formatPlanTemplates(), { ok: true, templates }, json);
      }

      // taskify: reads plan, writes task — handled outside plan lock
      if (verb === 'taskify') {
        if (!restJoined) {
          return errorResult('usage', 'Usage: /plan taskify <id|index>', json);
        }
        const plan = (await loadPlan(planPath)) ?? emptyPlan(sessionId);
        const itemIdx = findPlanItemIndex(plan, restJoined);
        if (itemIdx === -1 || !plan.items[itemIdx]) {
          return errorResult('item_not_found', `No plan item matched "${restJoined}".`, json);
        }
        const item = plan.items[itemIdx]!;

        const taskPath = opts.context?.meta?.['task.path'];
        if (typeof taskPath !== 'string' || !taskPath) {
          return errorResult(
            'task_storage_not_configured',
            'Task storage is not configured for this session.',
            json,
          );
        }

        const taskFile: TaskFile = (await loadTasks(taskPath)) ?? emptyTaskFile(sessionId);
        const now = new Date().toISOString();
        const task = {
          id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          title: item.title,
          description: item.details,
          type: 'feature' as const,
          priority: 'medium' as const,
          status: 'pending' as const,
          createdAt: now,
          updatedAt: now,
        };
        taskFile.tasks.push(task);
        await saveTasks(taskPath, taskFile);
        return result(
          `Taskified "${item.title}" → task.\n${formatTaskList(taskFile.tasks)}`,
          { ok: true, plan, task, tasks: taskFile.tasks },
          json,
        );
      }

      // Mutating ops — locked via mutatePlan
      let outputMessage = '';
      let outputError: { code: string; message: string } | undefined;
      let outputExtra: Record<string, unknown> = {};
      let todosToReplace: NonNullable<ReturnType<typeof deriveTodosFromPlanItem>>['todos'] | null =
        null;
      const finalPlan = await mutatePlan(planPath, sessionId, async (plan) => {
        switch (verb) {
          case 'add': {
            if (!restJoined) {
              outputMessage = 'Usage: /plan add <title>';
              outputError = { code: 'usage', message: outputMessage };
              return plan;
            }
            const { plan: updated, item } = addPlanItem(plan, restJoined);
            outputMessage = `Added: ${item.title}\n${formatPlan(updated)}`;
            outputExtra = { item };
            return updated;
          }
          case 'start':
          case 'progress': {
            if (!restJoined) {
              outputMessage = 'Usage: /plan start <id|index>';
              outputError = { code: 'usage', message: outputMessage };
              return plan;
            }
            const updated = setPlanItemStatus(plan, restJoined, 'in_progress');
            outputMessage = formatPlan(updated);
            return updated;
          }
          case 'done':
          case 'complete': {
            if (!restJoined) {
              outputMessage = 'Usage: /plan done <id|index>';
              outputError = { code: 'usage', message: outputMessage };
              return plan;
            }
            const updated = setPlanItemStatus(plan, restJoined, 'done');
            outputMessage = formatPlan(updated);
            return updated;
          }
          case 'remove':
          case 'delete':
          case 'rm': {
            if (!restJoined) {
              outputMessage = 'Usage: /plan remove <id|index>';
              outputError = { code: 'usage', message: outputMessage };
              return plan;
            }
            const itemIdx = findPlanItemIndex(plan, restJoined);
            const item = itemIdx >= 0 ? plan.items[itemIdx] : undefined;
            if (!item) {
              outputMessage = `No plan item matched "${restJoined}".`;
              outputError = { code: 'item_not_found', message: outputMessage };
              return plan;
            }
            if (item.status !== 'done') {
              outputMessage = `Plan item "${item.title}" is unfinished and cannot be removed. Complete it first.`;
              outputError = { code: 'unfinished_item', message: outputMessage };
              return plan;
            }
            const updated = removePlanItem(plan, restJoined);
            outputMessage = formatPlan(updated);
            return updated;
          }
          case 'promote':
          case 'derive': {
            if (!restJoined) {
              outputMessage = `Usage: /plan ${verb} <id|index> [subtask ...]`;
              outputError = { code: 'usage', message: outputMessage };
              return plan;
            }
            const [target, ...subtasks] = restJoined.split(/\s+/);
            if (!target) {
              outputMessage = `Usage: /plan ${verb} <id|index> [subtask ...]`;
              outputError = { code: 'usage', message: outputMessage };
              return plan;
            }
            const derived = deriveTodosFromPlanItem(
              plan,
              target,
              subtasks.length > 0 ? subtasks : undefined,
            );
            if (!derived) {
              outputMessage = `No plan item matched "${target}".`;
              outputError = { code: 'item_not_found', message: outputMessage };
              return plan;
            }
            todosToReplace = derived.todos;
            const label = verb === 'derive' ? 'Derived' : 'Promoted to';
            outputMessage = `${label} ${derived.todos.length} todo(s):\n${formatTodosList(derived.todos)}\n\n${formatPlan(derived.plan)}`;
            outputExtra = { todos: derived.todos };
            return derived.plan;
          }
          case 'template': {
            const subVerb = rest[0] ?? '';
            const subRest = rest.slice(1).join(' ').trim();
            if (subVerb === 'use') {
              if (!subRest) {
                outputMessage = 'Usage: /plan template use <template-name>';
                outputError = { code: 'usage', message: outputMessage };
                return plan;
              }
              const template = getPlanTemplate(subRest);
              if (!template) {
                outputMessage = `Unknown template "${subRest}".`;
                outputError = { code: 'template_not_found', message: outputMessage };
                return plan;
              }
              let updated = plan;
              for (const item of template.items) {
                ({ plan: updated } = addPlanItem(updated, item.title, item.details));
              }
              outputMessage = `Applied template "${template.name}" (${template.items.length} items):\n${formatPlan(updated)}`;
              outputExtra = { template };
              return updated;
            }
            outputMessage = `Unknown template subcommand "${subVerb}". Try: list | use <name>`;
            outputError = { code: 'unknown_subcommand', message: outputMessage };
            return plan;
          }
          case 'clear': {
            const unfinished = plan.items.filter((item) => item.status !== 'done');
            if (unfinished.length > 0) {
              outputMessage = `Plan contains unfinished items and cannot be cleared: ${unfinished.map((item) => item.id).join(', ')}.`;
              outputError = { code: 'unfinished_items', message: outputMessage };
              return plan;
            }
            const updated = clearPlan(plan);
            outputMessage = 'Plan cleared.';
            return updated;
          }
          default:
            outputMessage = `Unknown subcommand "${verb}". Try: show | add <title> | start <id|#> | done <id|#> | remove <id|#> | promote <id|#> | taskify <id|#> | template [list|use <name>] | clear`;
            outputError = { code: 'unknown_subcommand', message: outputMessage };
            return plan;
        }
      });

      if (todosToReplace && opts.context) {
        await todoTool.execute({ todos: todosToReplace }, opts.context, {
          signal: AbortSignal.timeout(30_000),
        });
      }

      const payload = outputError
        ? { ok: false, plan: finalPlan, error: outputError }
        : { ok: true, plan: finalPlan, ...outputExtra };
      return result(outputMessage, payload, json);
    },
  };
}
