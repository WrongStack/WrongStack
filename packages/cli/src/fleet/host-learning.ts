import {
  captureLearnedFromAgentOutputDetailed,
  recordSkillOutcome,
} from '@wrongstack/core/agent-catalog';
import { TOKENS } from '@wrongstack/core/kernel';
import type { TaskResult } from '@wrongstack/core/types';
import type { MultiAgentDeps } from './host-types.js';

/** What a spawn recorded about the agent that will produce this result. */
export interface LearningSubject {
  role: string;
  skills: readonly string[];
}

export function captureCompletedTaskLearningForHost(
  result: TaskResult,
  deps: Pick<MultiAgentDeps, 'container' | 'projectRoot'>,
  subjects: ReadonlyMap<string, LearningSubject>,
  /**
   * Called when a capture persisted at least one directive. The auto-optimize
   * scheduler uses it as its trigger, so distillation follows learning without
   * anyone pressing a button.
   */
  onCaptured?: (role: string) => void,
): void {
  const subject = subjects.get(result.subagentId);
  if (!subject) return;
  const logger = deps.container.safeResolve(TOKENS.Logger);

  // Feed the outcome back into skill affinity before anything can throw, so a
  // capture failure does not also lose the signal about which skills were
  // loaded for a task that did / did not work out.
  if (subject.skills.length > 0) {
    try {
      recordSkillOutcome(
        subject.role,
        subject.skills,
        result.status === 'success',
        deps.projectRoot,
      );
    } catch (error) {
      logger?.debug?.(`skill affinity update failed for role "${subject.role}": ${describe(error)}`);
    }
  }

  // Capture from failed and cancelled tasks too. A subagent that hit a wall and
  // wrote down *why* is the single highest-value learning source there is;
  // restricting capture to successes threw all of it away.
  const finalText = typeof result.result === 'string' ? result.result : result.partial?.text;
  if (!finalText) return;
  try {
    const capture = captureLearnedFromAgentOutputDetailed(
      finalText,
      subject.role,
      deps.projectRoot,
      false,
    );
    if (capture.captured > 0) {
      const routed = capture.skills?.length ? ` (skills: ${capture.skills.join(', ')})` : '';
      logger?.debug(
        `agent learning captured ${capture.captured} item(s) for role "${subject.role}"${routed}`,
      );
      try {
        onCaptured?.(subject.role);
      } catch {
        // The scheduler is best-effort; never let it fail a task completion.
      }
    }
  } catch (error) {
    logger?.warn(`agent learning capture failed for role "${subject.role}": ${describe(error)}`);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
