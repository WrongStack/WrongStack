/**
 * Worktree timelines, one per project.
 *
 * The lane fold is the shared contracts projector, so a lane reads the same
 * here as in the WebUI and the TUI. What HQ adds is the split: worktrees from
 * different projects have different base branches and live in different
 * repositories, so they never share an axis.
 */
import {
  normalizeWorktreeEvent,
  projectWorktreeTimeline,
  type WorktreeLane,
  type WorktreeTimeline,
  type WorktreeTimelineEvent,
} from '@wrongstack/contracts/types/worktree-timeline';
import type { HqEventEnvelope } from '@wrongstack/hq';

export interface ProjectTimeline {
  projectId: string;
  timeline: WorktreeTimeline;
  /** Newest event, for ordering projects. */
  lastAt: number;
  /** Lanes a person must look at: a conflict, or a failure. */
  attention: WorktreeLane[];
}

/** The envelope's session and timestamp are authoritative for a persisted event. */
export function toTimelineEvent(envelope: HqEventEnvelope): WorktreeTimelineEvent | null {
  const payload = envelope.payload;
  if (payload === null || typeof payload !== 'object') return null;
  const at = Date.parse(envelope.timestamp);
  const kind = (payload as { kind?: unknown }).kind;
  return normalizeWorktreeEvent(
    typeof kind === 'string' ? kind : '',
    { ...payload, ...(envelope.sessionId ? { sessionId: envelope.sessionId } : {}) },
    Number.isFinite(at) ? at : 0,
  );
}

export function projectTimelines(
  envelopes: readonly HqEventEnvelope[],
  now: number,
): ProjectTimeline[] {
  const byProject = new Map<string, WorktreeTimelineEvent[]>();
  for (const envelope of envelopes) {
    if (envelope.type !== 'worktree.event') continue;
    const event = toTimelineEvent(envelope);
    if (event === null) continue;
    const list = byProject.get(envelope.projectId) ?? [];
    list.push(event);
    byProject.set(envelope.projectId, list);
  }
  return [...byProject.entries()]
    .map(([projectId, events]) => {
      const timeline = projectWorktreeTimeline(events, { now });
      return {
        projectId,
        timeline,
        lastAt: events.reduce((latest, event) => Math.max(latest, event.at), 0),
        attention: timeline.lanes.filter(
          (lane) => lane.outcome === 'conflict' || lane.outcome === 'failed',
        ),
      };
    })
    .filter((entry) => entry.timeline.lanes.length > 0)
    .sort(
      (left, right) => right.attention.length - left.attention.length || right.lastAt - left.lastAt,
    );
}

export const OUTCOME_LABEL: Record<WorktreeLane['outcome'], string> = {
  live: 'Running',
  merged: 'Merged',
  conflict: 'Merge conflict',
  failed: 'Failed',
  kept: 'Kept for review',
  discarded: 'Discarded',
};

export const STAGE_LABEL: Record<NonNullable<WorktreeLane['failedStage']>, string> = {
  allocate: 'Could not create the checkout',
  commit: 'The commit was refused (pre-commit hook or a locked index)',
  merge: 'Merging into the base branch failed',
};

export const EVENT_LABEL: Record<WorktreeTimelineEvent['kind'], string> = {
  allocated: 'Checkout created',
  committed: 'Committed',
  merging: 'Merge started',
  merged: 'Merged into base',
  conflict: 'Merge conflict',
  failed: 'Failed',
  released: 'Released',
};

/** One sentence for a lane's latest state. */
export function laneSentence(lane: WorktreeLane): string {
  if (lane.outcome === 'conflict') {
    return lane.conflictFiles.length > 0
      ? `Conflicts in ${lane.conflictFiles.join(', ')}.`
      : 'The merge stopped on a conflict.';
  }
  if (lane.outcome === 'failed') {
    return lane.failedStage !== undefined ? `${STAGE_LABEL[lane.failedStage]}.` : 'Failed.';
  }
  if (lane.outcome === 'kept') return 'Finished and left on disk for review.';
  if (lane.outcome === 'live') {
    const phase = lane.segments.at(-1)?.phase;
    return phase === 'queued'
      ? 'Waiting in the merge queue.'
      : phase === 'merging'
        ? 'Merging into base.'
        : 'Working.';
  }
  return lane.outcome === 'merged' ? 'Merged into base.' : 'Removed without merging.';
}
