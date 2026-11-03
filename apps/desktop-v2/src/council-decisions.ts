import {
  applyCouncilResolution,
  applyCouncilVote,
  type CouncilLog,
  councilDecisionData,
  noteCouncilQuestion,
} from '@wrongstack/project-surfaces/council/panels';
import type { CouncilDecisionData } from '@wrongstack/project-surfaces/council/types';

export interface CouncilFold {
  log: CouncilLog;
  /** Set when this frame resolved a panel: the decision card the conversation shows. */
  decision?: CouncilDecisionData;
}

/**
 * Fold one `brain.event` frame into a conversation's council log, the way the WebUI's council
 * store does. Seat votes build the panel; a resolution that changes it yields the decision
 * card, and a replayed or older resolution yields none.
 */
export function reduceCouncil(log: CouncilLog, payload: Record<string, unknown>): CouncilFold {
  const request = payload['request'] as { id?: unknown; question?: unknown } | undefined;
  const questionId =
    typeof payload['requestId'] === 'string'
      ? payload['requestId']
      : typeof request?.id === 'string'
        ? request.id
        : undefined;
  // The question is on the brain.decision_* events, not on the council ones.
  const noted =
    questionId && typeof request?.question === 'string'
      ? noteCouncilQuestion(log, questionId, request.question)
      : log;
  if (payload['event'] === 'brain.council_vote') return { log: applyCouncilVote(noted, payload) };
  if (payload['event'] !== 'brain.council_resolved') return { log: noted };
  const requestId = typeof payload['requestId'] === 'string' ? payload['requestId'] : 'unknown';
  const previous = noted.panels.find((panel) => panel.requestId === requestId);
  const resolved = applyCouncilResolution(noted, payload);
  const panel = resolved.panels.find((entry) => entry.requestId === requestId);
  if (panel && panel === previous) return { log: resolved };
  return { log: resolved, decision: councilDecisionData(panel, payload) };
}
