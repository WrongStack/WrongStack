import {
  formatWorktreeDuration,
  projectWorktreeTimeline,
  shortWorktreeBranch,
  type WorktreeLane,
  type WorktreeLaneOutcome,
  type WorktreeLanePhase,
  type WorktreeTimelineEvent,
  worktreeTimelineTicks,
} from '@wrongstack/contracts/types/worktree-timeline';
import { X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import './worktree-history.css';

const OUTCOME_WORD: Record<WorktreeLaneOutcome, string> = {
  live: 'running',
  merged: 'merged',
  conflict: 'conflict',
  failed: 'failed',
  kept: 'kept',
  discarded: 'discarded',
};
const OUTCOME_ORDER: WorktreeLaneOutcome[] = ['live', 'merged', 'conflict', 'failed', 'kept'];
const PHASE_WORD: Record<WorktreeLanePhase, string> = {
  working: 'working',
  queued: 'waiting to merge',
  merging: 'merging',
  kept: 'kept for review',
};
const STAGE_WORD = {
  allocate: 'Creating the checkout failed',
  commit: 'Commit refused (pre-commit hook or locked index)',
  merge: 'Merge into base failed',
} as const;

const clock = (at: number, seconds: boolean) =>
  new Date(at).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    ...(seconds ? { second: '2-digit' } : {}),
  });

/** What one lifecycle step says in the lane's detail. */
function worktreeEventText(event: WorktreeTimelineEvent, base: string): string {
  const word =
    event.kind === 'allocated'
      ? 'worktree created'
      : event.kind === 'merging'
        ? 'merge started'
        : event.kind === 'merged'
          ? `merged into ${base}`
          : event.kind === 'conflict'
            ? 'merge conflict'
            : event.kind === 'released'
              ? event.kept
                ? 'kept on disk'
                : 'removed'
              : event.kind;
  const detail =
    event.kind === 'committed' && event.committed !== false
      ? `+${event.insertions ?? 0} −${event.deletions ?? 0} · ${event.files ?? 0} files${
          event.sha ? ` · ${event.sha.slice(0, 7)}` : ''
        }`
      : event.kind === 'committed'
        ? 'nothing to commit'
        : event.kind === 'conflict'
          ? event.conflictFiles?.join(', ')
          : event.kind === 'failed'
            ? event.error?.trim().split('\n')[0]
            : undefined;
  return detail ? `${word} · ${detail}` : word;
}

/** Time spent in each phase; open segments run to `until`. */
function phaseTotals(lane: WorktreeLane, until: number) {
  const totals = new Map<WorktreeLanePhase, number>();
  for (const segment of lane.segments)
    totals.set(
      segment.phase,
      (totals.get(segment.phase) ?? 0) + Math.max(0, (segment.end ?? until) - segment.start),
    );
  return totals;
}

/** The lifecycle log as a clock that moves on only while a worktree is live. */
function useWorktreeTimeline(events: readonly WorktreeTimelineEvent[]) {
  const [now, setNow] = useState(() => Date.now());
  const timeline = useMemo(() => projectWorktreeTimeline(events, { now }), [events, now]);
  const live = timeline.counts.live > 0;
  useEffect(() => {
    // A new step re-anchors the axis even when idle, so a finished lane ends at its real time.
    if (events.length) setNow(Date.now());
  }, [events]);
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);
  return timeline;
}

/**
 * Every worktree the engine allocated, as the WebUI's worktree timeline draws it: one lane per
 * worktree on a shared time axis (working, waiting to merge, merging, kept), how it ended, and
 * the squash commits that landed on the base branch. Choosing a lane shows its lifecycle.
 */
export function WorktreeHistory({ events }: { events: readonly WorktreeTimelineEvent[] }) {
  const timeline = useWorktreeTimeline(events);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const base = timeline.baseBranch ?? 'HEAD';
  const span = Math.max(1, timeline.end - timeline.start);
  const at = (time: number) => Math.min(100, Math.max(0, ((time - timeline.start) / span) * 100));
  const seconds = span < 10 * 60_000;
  const selected = timeline.lanes.find((lane) => lane.handleId === selectedId);
  if (!timeline.lanes.length)
    return (
      <p className="field-help">
        No worktree activity yet. Goal phases, SDD tasks and fleet subagents that run in isolated
        git worktrees appear here.
      </p>
    );
  return (
    <section className="worktree-history" aria-label="Worktree timeline">
      <p className="worktree-history-counts">
        {OUTCOME_ORDER.filter((outcome) => timeline.counts[outcome] > 0).map((outcome) => (
          <span key={outcome} className={`outcome-${outcome}`}>
            <strong>{timeline.counts[outcome]}</strong> {OUTCOME_WORD[outcome]}
          </span>
        ))}
        {timeline.avgQueueMs !== undefined && (
          <span>avg merge wait {formatWorktreeDuration(timeline.avgQueueMs)}</span>
        )}
      </p>
      <figure className="worktree-history-chart" aria-label={`Worktree timeline on ${base}`}>
        <div className="worktree-history-label">
          <code>{base}</code>
        </div>
        <div className="worktree-history-track base">
          {timeline.baseCommits.map((commit) => (
            <span
              key={`${commit.handleId}-${commit.at}`}
              className="worktree-history-commit"
              title={`${shortWorktreeBranch(commit.branch)} · ${clock(commit.at, true)}`}
              style={{ left: `${at(commit.at)}%` }}
            />
          ))}
        </div>
        {timeline.lanes.map((lane) => {
          const chosen = lane.handleId === selectedId;
          return (
            <button
              type="button"
              key={lane.handleId}
              className="worktree-history-lane"
              aria-pressed={chosen}
              aria-label={`${shortWorktreeBranch(lane.branch)} — ${OUTCOME_WORD[lane.outcome]}`}
              onClick={() => setSelectedId(chosen ? null : lane.handleId)}
            >
              <span className="worktree-history-label">
                <code className={`outcome-${lane.outcome}`}>
                  {shortWorktreeBranch(lane.branch)}
                </code>
                <small>{lane.ownerLabel}</small>
              </span>
              <span className="worktree-history-track">
                {lane.segments.map((segment, index) => {
                  const left = at(segment.start);
                  const until = segment.end ?? timeline.end;
                  return (
                    <span
                      key={`${segment.phase}-${segment.start}-${index}`}
                      className={`worktree-history-segment phase-${segment.phase}`}
                      title={`${PHASE_WORD[segment.phase]} · ${formatWorktreeDuration(until - segment.start)}`}
                      style={{ left: `${left}%`, width: `${Math.max(0.6, at(until) - left)}%` }}
                    />
                  );
                })}
                {lane.outcome !== 'live' && (
                  <span
                    className={`worktree-history-end outcome-${lane.outcome}`}
                    style={{ left: `${at(lane.mergedAt ?? lane.end ?? timeline.end)}%` }}
                  />
                )}
              </span>
            </button>
          );
        })}
        <div />
        <div className="worktree-history-axis">
          {worktreeTimelineTicks(timeline.start, timeline.end, 5).map((tick) => (
            <span key={tick} style={{ left: `${at(tick)}%` }}>
              {clock(tick, seconds)}
            </span>
          ))}
        </div>
      </figure>
      {selected && (
        <WorktreeLaneDetail
          lane={selected}
          base={base}
          until={Math.max(timeline.end, Date.now())}
          onClose={() => setSelectedId(null)}
        />
      )}
    </section>
  );
}

function WorktreeLaneDetail({
  lane,
  base,
  until,
  onClose,
}: {
  lane: WorktreeLane;
  base: string;
  until: number;
  onClose: () => void;
}) {
  const totals = phaseTotals(lane, until);
  return (
    <article className="worktree-history-detail" aria-label="Worktree lifecycle">
      <header>
        <code>{shortWorktreeBranch(lane.branch)}</code>
        <span className={`worktree-history-badge outcome-${lane.outcome}`}>
          {OUTCOME_WORD[lane.outcome]}
        </span>
        <small>{lane.ownerLabel}</small>
        <button type="button" className="icon-button" aria-label="Close details" onClick={onClose}>
          <X size={13} />
        </button>
      </header>
      <p className="worktree-history-stats">
        {lane.commits.length > 0 &&
          `+${lane.insertions} −${lane.deletions} · ${lane.files} files${
            lane.sha ? ` · ${lane.sha.slice(0, 7)}` : ''
          } · `}
        {[...totals]
          .map(([phase, ms]) => `${PHASE_WORD[phase]} ${formatWorktreeDuration(ms)}`)
          .join(' · ')}
        {` · ${lane.onDisk ? 'checkout still on disk' : 'checkout removed'}`}
      </p>
      {lane.error && (
        <p className="session-error">
          {lane.failedStage ? STAGE_WORD[lane.failedStage] : 'Failed'}: {lane.error}
        </p>
      )}
      {lane.conflictFiles.length > 0 && (
        <p className="session-error">Conflicted files: {lane.conflictFiles.join(', ')}</p>
      )}
      <ol>
        {lane.events.map((event, index) => (
          <li key={`${event.kind}-${event.at}-${index}`}>
            <time dateTime={new Date(event.at).toISOString()}>{clock(event.at, true)}</time>
            <span>{worktreeEventText(event, base)}</span>
          </li>
        ))}
      </ol>
    </article>
  );
}
