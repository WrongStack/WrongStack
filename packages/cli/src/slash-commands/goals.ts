import type { SlashCommand } from '@wrongstack/contracts/types';
import { type GoalSummary, PhaseStore } from '@wrongstack/goal';
import type { SlashCommandContext } from './command-context.js';

export function formatGoalSummary(goal: GoalSummary): string {
  return [
    `${goal.title} [${goal.id}]`,
    `Status: ${goal.status} · Progress: ${goal.percentComplete === null ? '—' : `${goal.percentComplete}%`} · Tasks: ${goal.completedTasks}/${goal.totalTasks} · Phases: ${goal.completedPhases}/${goal.totalPhases}`,
    `Session: ${goal.sessionId ?? '—'} · Owner: ${goal.ownerId ?? '—'}`,
    `Reachability: ${goal.reachability} · Verification: ${goal.verification}`,
    ...(goal.branch ? [`Branch: ${goal.branch} (integrate when reviewed)`] : []),
    ...goal.phases.map(
      (phase) =>
        `  ${phase.name}: ${phase.status} · ${phase.completedTasks}/${phase.totalTasks} tasks`,
    ),
    ...goal.blockers.map((blocker) => `  Blocker: ${blocker}`),
  ].join('\n');
}

export function buildGoalsCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'goals',
    category: 'Agent',
    description: 'My Goals — track all goals in this project by id.',
    help: 'Usage: /goals [goal-id]\nLists project goals, their owning sessions, progress, phases and blockers.',
    async run(args) {
      if (!opts.paths) return { message: 'Goal storage is not configured.' };
      const goals = await new PhaseStore({ baseDir: opts.paths.projectAutophase }).listGoals();
      const query = args.trim();
      const selected = query
        ? goals.filter((goal) => goal.id === query || goal.id.startsWith(query))
        : goals;
      if (query && selected.length !== 1)
        return {
          message: selected.length
            ? 'Goal id is ambiguous; use the full id.'
            : `Goal not found: ${query}`,
        };
      return {
        message: selected.length
          ? selected.map(formatGoalSummary).join('\n\n')
          : 'No goals in this project. Use /goal start <goal>.',
      };
    },
  };
}
