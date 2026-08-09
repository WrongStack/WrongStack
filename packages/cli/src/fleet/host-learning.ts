import { captureLearnedFromAgentOutputDetailed } from '@wrongstack/core/agent-catalog';
import { TOKENS } from '@wrongstack/core/kernel';
import type { TaskResult } from '@wrongstack/core/types';
import type { MultiAgentDeps } from './host-types.js';

export function captureCompletedTaskLearningForHost(
  result: TaskResult,
  deps: Pick<MultiAgentDeps, 'container' | 'projectRoot'>,
  subagentLearningRoles: ReadonlyMap<string, string>,
): void {
  if (result.status !== 'success') return;
  const role = subagentLearningRoles.get(result.subagentId);
  const finalText = typeof result.result === 'string' ? result.result : result.partial?.text;
  if (!role || !finalText) return;
  try {
    const capture = captureLearnedFromAgentOutputDetailed(finalText, role, deps.projectRoot, false);
    if (capture.captured > 0) {
      deps.container
        .safeResolve(TOKENS.Logger)
        ?.debug(`agent learning captured ${capture.captured} item(s) for role "${role}"`);
    }
  } catch (error) {
    deps.container
      .safeResolve(TOKENS.Logger)
      ?.warn(
        `agent learning capture failed for role "${role}": ${error instanceof Error ? error.message : String(error)}`,
      );
  }
}
