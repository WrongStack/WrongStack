import { describeKanbanBoundary, type KanbanBoard, type KanbanTask } from '@wrongstack/kanban';

interface KanbanAgentFlags {
  provider?: string | undefined;
  model?: string | undefined;
  name?: string | undefined;
  role?: string | undefined;
  fallbackProfile?: string | undefined;
  fallbackModels?: string[] | undefined;
  tools?: string[] | undefined;
  allowedCapabilities?: string[] | undefined;
}

export function parseKanbanAgentFlags(args: string[]): {
  target?: string | undefined;
  flags: KanbanAgentFlags;
} {
  const flags: KanbanAgentFlags = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;
    const readValue = (prefix: string): string | undefined => {
      if (arg.startsWith(`${prefix}=`)) return arg.slice(prefix.length + 1);
      const next = args[i + 1];
      if (arg === prefix && next && !next.startsWith('--')) {
        i += 1;
        return next;
      }
      return undefined;
    };
    const provider = readValue('--provider') ?? readValue('-p');
    if (provider) flags.provider = provider;
    else {
      const model = readValue('--model') ?? readValue('-m');
      if (model) flags.model = model;
      else {
        const name = readValue('--name') ?? readValue('-n');
        if (name) flags.name = stripQuotes(name);
        else {
          const role = readValue('--role');
          if (role) flags.role = role;
          else {
            const fallback = readValue('--fallback') ?? readValue('--fallback-profile');
            if (fallback) flags.fallbackProfile = fallback;
            else {
              const fallbackModels = readValue('--fallback-models');
              if (fallbackModels) flags.fallbackModels = splitCsv(fallbackModels);
              else {
                const tools = readValue('--tools');
                if (tools) flags.tools = splitCsv(tools);
                else {
                  const caps = readValue('--capabilities') ?? readValue('--caps');
                  if (caps) flags.allowedCapabilities = splitCsv(caps);
                  else if (!arg.startsWith('--')) positional.push(arg);
                }
              }
            }
          }
        }
      }
    }
  }
  return { target: positional[0], flags };
}

export function buildKanbanAgentPrompt(
  board: KanbanBoard,
  task: KanbanTask,
  assignment: KanbanTask['assignment'],
): string {
  const dependencyLines = (task.dependsOn ?? [])
    .map((depId) => board.tasks.find((candidate) => candidate.id === depId))
    .filter((dep): dep is KanbanTask => Boolean(dep))
    .map((dep) => `- ${dep.title} [${dep.status}] (${dep.id})`);
  const checks = task.successCriteria?.map((check) => `- ${check.description}`).join('\n');
  const metrics = task.goalMetrics
    ?.map(
      (metric) =>
        `- ${metric.name}: ${metric.current ?? 'n/a'}${metric.target !== undefined ? ` / ${metric.direction === 'at_most' ? '≤' : '≥'} ${metric.target}` : ''}${metric.unit ? ` ${metric.unit}` : ''} [${metric.status}]`,
    )
    .join('\n');
  const chain = task.chain
    ? [
        `chainId: ${task.chain.chainId}`,
        `order: ${task.chain.order}`,
        task.chain.previousTaskId ? `previous: ${task.chain.previousTaskId}` : '',
        task.chain.nextTaskId ? `next: ${task.chain.nextTaskId}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    : '';
  const routing = [
    assignment?.role ? `role: ${assignment.role}` : '',
    assignment?.provider ? `provider: ${assignment.provider}` : '',
    assignment?.model ? `model: ${assignment.model}` : '',
    assignment?.fallbackProfile ? `fallbackProfile: ${assignment.fallbackProfile}` : '',
    assignment?.fallbackModels?.length
      ? `fallbackModels: ${assignment.fallbackModels.join(', ')}`
      : '',
  ].filter(Boolean);
  const boundaries = [
    board.boundary?.enabled ? `board: ${describeKanbanBoundary(board.boundary)}` : '',
    task.boundary?.enabled ? `task: ${describeKanbanBoundary(task.boundary)}` : '',
    ...(board.boundary?.enabled
      ? (board.boundary.allow ?? []).map(
          (selector) => `board allow ${selector.access} ${selector.kind}:${selector.path}`,
        )
      : []),
    ...(task.boundary?.enabled
      ? (task.boundary.allow ?? []).map(
          (selector) => `task allow ${selector.access} ${selector.kind}:${selector.path}`,
        )
      : []),
  ].filter(Boolean);
  return [
    `You are processing a WrongStack kanban task.`,
    '',
    `Board: ${board.title} (${board.id})`,
    `Task: ${task.title} (${task.id})`,
    `Status: ${task.status}`,
    `Priority: ${task.priority}`,
    task.description ? `Description:\n${task.description}` : '',
    routing.length ? `Routing hints:\n${routing.join('\n')}` : '',
    chain ? `Task chain:\n${chain}` : '',
    dependencyLines.length ? `Dependencies:\n${dependencyLines.join('\n')}` : '',
    checks ? `Success criteria:\n${checks}` : '',
    metrics ? `Goal metrics:\n${metrics}` : '',
    task.labels?.length ? `Labels: ${task.labels.join(', ')}` : '',
    boundaries.length
      ? `BOUNDARY CONTRACT (enforced by the tool runtime; do not attempt to bypass):\n${boundaries.map((line) => `- ${line}`).join('\n')}`
      : '',
    '',
    'Work the task end-to-end. Use the kanban tool, not direct file edits, to update this task.',
    `When you start or finish, call kanban with action "mark_assignment", boardId "${board.id}", taskId "${task.id}", and assignmentStatus "running", "completed", or "failed". Include lastResult or error when you finish.`,
    'When finished, report what changed, what you verified, and any remaining blockers.',
  ]
    .filter(Boolean)
    .join('\n');
}

export function splitCsv(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function stripQuotes(value: string): string {
  return value.replace(/^"|"$/g, '');
}
