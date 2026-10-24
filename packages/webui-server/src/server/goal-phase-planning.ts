import type { Logger } from '@wrongstack/contracts/types';
import type { Agent } from '@wrongstack/core/agent';
import { GoalPlanner, type PhaseTemplate } from '@wrongstack/goal';

import { toErrorMessage } from '@wrongstack/core/utils';

export interface GoalPhasePlanningHost {
  agent: Agent;
  logger: Logger;
}

export async function planPhases(
  host: GoalPhasePlanningHost,
  goal: string,
  signal?: AbortSignal,
): Promise<PhaseTemplate[]> {
  try {
    const planner = new GoalPlanner({
      goal,
      runOnce: async (prompt) => {
        const result = (await host.agent.run(prompt, {
          signal: signal ?? new AbortController().signal,
        })) as {
          status: string;
          finalText?: string | undefined;
        };
        return result.status === 'done' ? (result.finalText ?? '') : '';
      },
    });
    const { phases, parseFailed } = await planner.plan();
    if (!parseFailed && phases.length > 0) {
      const todos = phases.reduce((n, p) => n + (p.taskTemplates?.length ?? 0), 0);
      host.logger.info(`[Goal] Planned ${phases.length} phases / ${todos} todos for: ${goal}`);
      return phases;
    }
    host.logger.warn(`[Goal] Planner produced no executable phases for: ${goal}`);
  } catch (err) {
    host.logger.error(`[Goal] Planning failed: ${toErrorMessage(err)}`);
  }
  return [];
}

export async function runChimeraReview(
  host: GoalPhasePlanningHost,
  task: import('@wrongstack/contracts/types').TaskNode,
  phaseId: string,
  result: unknown,
  cwd?: string | undefined,
): Promise<void> {
  const output = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  void cwd; // reserved for future worktree-scoped review
  const reviewPrompt = [
    'You are a code review agent. Review the following completed task and its output.',
    '',
    `Task: ${task.title}`,
    task.description ? `Description: ${task.description}` : '',
    `Phase: ${phaseId}`,
    `Priority: ${task.priority}`,
    '',
    '--- Task Output ---',
    output.slice(0, 8000),
    '',
    '---',
    '',
    'Provide a brief review (2-5 sentences) covering:',
    '1. Does the output satisfy the task requirements? (yes/no/partial)',
    '2. Any correctness, security, or quality concerns.',
    '3. A confidence score (low/medium/high).',
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const result_ = (await host.agent.run(reviewPrompt)) as {
      status: string;
      finalText?: string | undefined;
    };
    if (result_.status === 'done' && result_.finalText) {
      host.logger.info(
        `[Goal] Chimera review for "${task.title}":\n${result_.finalText.slice(0, 2000)}`,
      );
    }
  } catch (err: unknown) {
    host.logger.warn(`[Goal] Chimera review failed for "${task.title}": ${toErrorMessage(err)}`);
  }
}
