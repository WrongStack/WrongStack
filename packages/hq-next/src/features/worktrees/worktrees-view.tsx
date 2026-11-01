'use client';

import { useHqStore } from '@hq/data/store/index';
import { useBackfilledEvents } from '@hq/domain/use-backfilled-events';
/**
 * Worktrees — isolated git checkouts of parallel work, per project.
 *
 * Each worktree is a lane on the project's time axis: working, waiting to
 * merge, merging; then merged, conflicted, failed or kept. Conflicts and
 * failures are listed first, with the reason. The project and the open lane
 * live in the URL (`?project=&lane=`).
 */
import {
  formatWorktreeDuration,
  shortWorktreeBranch,
  type WorktreeLane,
  type WorktreeLanePhase,
  worktreeTimelineTicks,
} from '@wrongstack/contracts/types/worktree-timeline';
import type { HqProjectRecord } from '@wrongstack/hq';
import { GitBranch } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { plural } from '@/features/overview/model';
import { cn } from '@/lib/cn';
import { useScopedEvents } from '@/lib/use-scope';
import { EVENT_LABEL, laneSentence, OUTCOME_LABEL, projectTimelines, STAGE_LABEL } from './model';

const EMPTY_PROJECTS: readonly HqProjectRecord[] = [];

const PHASE: Record<WorktreeLanePhase, { label: string; className: string }> = {
  working: { label: 'Working', className: 'bg-warning/80' },
  queued: { label: 'Waiting to merge', className: 'border border-info/60 bg-info/20' },
  merging: { label: 'Merging', className: 'bg-info' },
  kept: {
    label: 'Kept for review',
    className: 'border border-dashed border-muted-foreground/60 bg-muted-foreground/10',
  },
};

const OUTCOME_TONE: Record<WorktreeLane['outcome'], string> = {
  live: 'text-warning',
  merged: 'text-success',
  conflict: 'text-destructive',
  failed: 'text-destructive',
  kept: 'text-muted-foreground',
  discarded: 'text-muted-foreground',
};

export function WorktreesView(): ReactNode {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const backfilled = useBackfilledEvents('worktree.event', 500);
  const events = useScopedEvents(backfilled.events);
  const loading = backfilled.loading;
  const projects = useHqStore((state) => state.snapshot?.projects ?? EMPTY_PROJECTS);
  const [now, setNow] = useState(() => Date.now());

  const all = useMemo(() => projectTimelines(events, now), [events, now]);
  // A `?project=` link outside the scope still opens that project.
  const everything = useMemo(
    () => projectTimelines(backfilled.events, now),
    [backfilled.events, now],
  );
  const live = all.some((entry) => entry.timeline.counts.live > 0);
  useEffect(() => {
    setNow(Date.now());
  }, [events]);
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(timer);
  }, [live]);

  const nameOf = (id: string): string =>
    projects.find((project) => project.projectId === id)?.projectName ?? id;
  const current = everything.find((entry) => entry.projectId === params.get('project')) ?? all[0];
  // `all` and `everything` are built separately, so compare by id, not identity.
  const options =
    current !== undefined && !all.some((entry) => entry.projectId === current.projectId)
      ? [...all, current]
      : all;
  const lanes = current?.timeline.lanes ?? [];
  const lane =
    lanes.find((candidate) => candidate.handleId === params.get('lane')) ??
    current?.attention[0] ??
    lanes.at(-1);

  const set = (patch: Record<string, string | null>): void => {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) next.delete(key);
      else next.set(key, value);
    }
    const query = next.toString();
    router.replace(query === '' ? pathname : `${pathname}?${query}`, { scroll: false });
  };

  if (current === undefined) {
    return (
      <div className="mx-auto flex max-w-2xl flex-col items-start gap-3 px-6 py-16">
        <GitBranch className="size-6 text-muted-foreground" />
        <h2 className="font-display text-2xl font-semibold">
          {loading ? 'Loading worktree history…' : 'No worktree has been used yet'}
        </h2>
        {!loading && (
          <p className="text-base text-muted-foreground">
            Worktrees appear when Goal phases, SDD tasks or fleet subagents work in isolated git
            checkouts.
          </p>
        )}
      </div>
    );
  }

  const { timeline, attention } = current;
  const span = Math.max(1, timeline.end - timeline.start);
  const pct = (at: number): number =>
    Math.min(100, Math.max(0, ((at - timeline.start) / span) * 100));
  const ticks = worktreeTimelineTicks(timeline.start, timeline.end, 6);
  const multiDay = span > 24 * 60 * 60 * 1000;
  // A short timeline needs seconds, or every tick reads the same minute; a tick
  // that would repeat its neighbour's label is dropped.
  const tickOptions: Intl.DateTimeFormatOptions = multiDay
    ? { weekday: 'short', hour: '2-digit', minute: '2-digit' }
    : span < 10 * 60 * 1000
      ? { hour: '2-digit', minute: '2-digit', second: '2-digit' }
      : { hour: '2-digit', minute: '2-digit' };
  const tickLabels = ticks
    .map((at) => ({ at, label: new Date(at).toLocaleString([], tickOptions) }))
    .filter((tick, index, all) => index === 0 || tick.label !== all[index - 1]?.label);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-6">
      <header className="flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="font-display text-2xl font-semibold">
            {attention.length > 0
              ? `${plural(attention.length, 'worktree')} ${attention.length === 1 ? 'needs' : 'need'} you`
              : timeline.counts.live > 0
                ? `${plural(timeline.counts.live, 'worktree')} running`
                : 'All worktrees settled'}
          </h2>
          <p className="text-base text-muted-foreground">
            {plural(lanes.length, 'worktree')} on{' '}
            <span className="font-mono">{timeline.baseBranch ?? 'HEAD'}</span>
            {' · '}
            {timeline.counts.merged} merged
            {timeline.avgQueueMs !== undefined &&
              ` · merges waited ${formatWorktreeDuration(timeline.avgQueueMs)} on average`}
          </p>
        </div>
        {options.length > 1 && (
          <select
            aria-label="Project"
            value={current.projectId}
            onChange={(event) => set({ project: event.target.value, lane: null })}
            className="ml-auto h-9 border border-border bg-background px-2 text-sm"
          >
            {options.map((entry) => (
              <option key={entry.projectId} value={entry.projectId}>
                {nameOf(entry.projectId)}
                {entry.attention.length > 0 ? ` — ${entry.attention.length} need you` : ''}
              </option>
            ))}
          </select>
        )}
      </header>

      {attention.length > 0 && (
        <section className="flex flex-col gap-3" aria-labelledby="wt-attention">
          <h3 id="wt-attention" className="text-sm font-semibold">
            Needs a person
          </h3>
          <ul className="flex flex-col gap-2">
            {attention.map((entry) => (
              <li key={entry.handleId}>
                <button
                  type="button"
                  onClick={() => set({ lane: entry.handleId })}
                  className="flex w-full flex-col gap-1 border border-destructive/50 bg-destructive/5 px-4 py-3 text-left hover:bg-destructive/10"
                >
                  <span className="flex flex-wrap items-baseline gap-x-3">
                    <span className="font-medium text-destructive">
                      {OUTCOME_LABEL[entry.outcome]}
                    </span>
                    <span className="font-mono text-sm">{shortWorktreeBranch(entry.branch)}</span>
                    <span className="text-sm text-muted-foreground">{entry.ownerLabel}</span>
                  </span>
                  <span className="text-sm">{laneSentence(entry)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="flex flex-col gap-3" aria-labelledby="wt-timeline">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <h3 id="wt-timeline" className="text-sm font-semibold">
            Timeline
          </h3>
          <ul
            className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground"
            aria-label="Legend"
          >
            {Object.values(PHASE).map((phase) => (
              <li key={phase.label} className="flex items-center gap-1.5">
                <span
                  className={cn('inline-block h-2.5 w-5', phase.className)}
                  aria-hidden="true"
                />
                {phase.label}
              </li>
            ))}
            <li className="flex items-center gap-1.5">
              <span className="inline-block size-2.5 rounded-full bg-success" aria-hidden="true" />
              Landed on base
            </li>
          </ul>
        </div>
        <div className="overflow-x-auto">
          <div className="flex min-w-[40rem] flex-col gap-1">
            <div className="grid grid-cols-[14rem_minmax(0,1fr)_6rem] items-center gap-3 px-2 py-1">
              <span className="truncate font-mono text-sm text-muted-foreground">
                {timeline.baseBranch ?? 'HEAD'}
              </span>
              <span className="relative block h-4">
                <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-primary/50" />
                {timeline.baseCommits.map((commit) => (
                  <span
                    key={`${commit.handleId}-${commit.at}`}
                    title={`${shortWorktreeBranch(commit.branch)} · ${new Date(commit.at).toLocaleString()}`}
                    className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background bg-success"
                    style={{ left: `${pct(commit.at)}%` }}
                  />
                ))}
              </span>
              <span />
            </div>
            {lanes.map((entry) => (
              <button
                key={entry.handleId}
                type="button"
                data-lane={entry.handleId}
                aria-current={entry.handleId === lane?.handleId ? 'true' : undefined}
                onClick={() => set({ lane: entry.handleId })}
                className={cn(
                  'grid grid-cols-[14rem_minmax(0,1fr)_6rem] items-center gap-3 px-2 py-1.5 text-left hover:bg-muted/50',
                  entry.handleId === lane?.handleId && 'bg-muted',
                )}
              >
                <span className="flex min-w-0 flex-col">
                  <span className="truncate font-mono text-sm">
                    {shortWorktreeBranch(entry.branch)}
                  </span>
                  <span className={cn('truncate text-xs', OUTCOME_TONE[entry.outcome])}>
                    {OUTCOME_LABEL[entry.outcome]} ·{' '}
                    <span className="text-muted-foreground">{entry.ownerLabel}</span>
                  </span>
                </span>
                <span className="relative block h-3.5">
                  {entry.segments.map((segment, index) => {
                    const left = pct(segment.start);
                    const width = Math.max(0.6, pct(segment.end ?? timeline.end) - left);
                    return (
                      <span
                        key={`${segment.phase}-${segment.start}-${index}`}
                        title={`${PHASE[segment.phase].label} · ${formatWorktreeDuration((segment.end ?? timeline.end) - segment.start)}`}
                        className={cn('absolute inset-y-0', PHASE[segment.phase].className)}
                        style={{ left: `${left}%`, width: `${width}%` }}
                      />
                    );
                  })}
                </span>
                <span className="tabular text-right text-sm">
                  {entry.commits.length > 0 ? (
                    <>
                      <span className="text-success">+{entry.insertions}</span>{' '}
                      <span className="text-destructive">−{entry.deletions}</span>
                    </>
                  ) : (
                    <span className="text-muted-foreground">
                      {formatWorktreeDuration((entry.end ?? timeline.end) - entry.start)}
                    </span>
                  )}
                </span>
              </button>
            ))}
            <div className="grid grid-cols-[14rem_minmax(0,1fr)_6rem] gap-3 px-2">
              <span />
              <span className="relative block h-5 text-xs text-muted-foreground">
                {tickLabels.map(({ at, label }) => (
                  <span
                    key={at}
                    className="tabular absolute -translate-x-1/2 whitespace-nowrap"
                    style={{ left: `${pct(at)}%` }}
                  >
                    {label}
                  </span>
                ))}
              </span>
              <span />
            </div>
          </div>
        </div>
      </section>

      {lane !== undefined && <LaneDetail lane={lane} />}
    </div>
  );
}

function LaneDetail({ lane }: { lane: WorktreeLane }): ReactNode {
  return (
    <section
      aria-labelledby="wt-lane"
      className="flex flex-col gap-4 border border-border bg-card p-5"
    >
      <header className="flex flex-col gap-1">
        <p className="flex flex-wrap gap-x-3 text-sm">
          <span className={cn('font-medium', OUTCOME_TONE[lane.outcome])}>
            {OUTCOME_LABEL[lane.outcome]}
          </span>
          <span className="text-muted-foreground">{lane.ownerLabel}</span>
          <span className="text-muted-foreground">
            {lane.onDisk ? 'checkout still on disk' : 'checkout removed'}
          </span>
        </p>
        <h3 id="wt-lane" className="break-all font-mono text-lg font-semibold">
          {lane.branch}
        </h3>
        <p className="text-base">{laneSentence(lane)}</p>
        {lane.dir !== undefined && (
          <p className="break-all font-mono text-xs text-muted-foreground">{lane.dir}</p>
        )}
      </header>
      {lane.error !== undefined && (
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium text-destructive">
            {lane.failedStage !== undefined ? STAGE_LABEL[lane.failedStage] : 'Error'}
          </span>
          <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words border border-border bg-muted/30 p-3 font-mono text-[0.8125rem]">
            {lane.error.trim()}
          </pre>
        </div>
      )}
      <ol className="flex flex-col">
        {lane.events.map((event, index) => (
          <li
            key={`${event.kind}-${event.at}-${index}`}
            className="grid grid-cols-[6rem_minmax(0,1fr)] gap-3 border-t border-border py-2 text-sm"
          >
            <span className="tabular text-muted-foreground">
              {new Date(event.at).toLocaleTimeString()}
            </span>
            <span className="min-w-0">
              <span className="font-medium">{EVENT_LABEL[event.kind]}</span>
              {event.kind === 'committed' &&
                (event.committed === false ? (
                  <span className="text-muted-foreground"> — nothing to commit</span>
                ) : (
                  <span className="text-muted-foreground">
                    {' '}
                    — <span className="text-success">+{event.insertions ?? 0}</span>{' '}
                    <span className="text-destructive">−{event.deletions ?? 0}</span> in{' '}
                    {plural(event.files ?? 0, 'file')}
                    {event.sha !== undefined && (
                      <span className="font-mono"> {event.sha.slice(0, 7)}</span>
                    )}
                  </span>
                ))}
              {event.kind === 'conflict' && event.conflictFiles !== undefined && (
                <span className="break-words text-destructive">
                  {' '}
                  — {event.conflictFiles.join(', ')}
                </span>
              )}
              {event.kind === 'released' && (
                <span className="text-muted-foreground">
                  {' '}
                  — {event.kept ? 'kept on disk' : 'checkout removed'}
                </span>
              )}
              {event.kind === 'failed' && event.error !== undefined && (
                <span className="break-words text-destructive">
                  {' '}
                  — {event.error.split('\n')[0]}
                </span>
              )}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
