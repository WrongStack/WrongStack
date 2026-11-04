import {
  normalizeWorktreeEvent,
  type WorktreeTimelineEvent,
} from '@wrongstack/contracts/types/worktree-timeline';
import { entries, record } from './engine-values';

/** Lifecycle events kept for the timeline; the engine's own log is bounded too. */
const WORKTREE_EVENT_LIMIT = 1000;

/**
 * Folds the engine's worktree lifecycle frames: `worktree.timeline` (the whole log, sent when
 * a client connects) replaces what is kept, and each `worktree.timeline_event` adds one.
 * Null for any other frame.
 */
export function reduceWorktreeEvents(
  events: readonly WorktreeTimelineEvent[],
  type: string,
  payload: Record<string, unknown>,
  at: number,
): WorktreeTimelineEvent[] | null {
  const normalize = (event: Record<string, unknown>) =>
    normalizeWorktreeEvent(String(event['kind'] ?? ''), event, at);
  if (type === 'worktree.timeline')
    return entries(payload['events'])
      .map(normalize)
      .filter((event): event is WorktreeTimelineEvent => event !== null)
      .slice(-WORKTREE_EVENT_LIMIT);
  if (type !== 'worktree.timeline_event') return null;
  const event = normalize(record(payload['event']));
  return event ? [...events, event].slice(-WORKTREE_EVENT_LIMIT) : null;
}
