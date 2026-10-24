/**
 * Worktrees — git worktree lifecycle on one time axis.
 *
 * Every managed worktree is a lane: working → waiting to merge → merging, then
 * merged / conflict / failed / kept, under the base branch with a dot per
 * squash commit. The fold is the shared core projector
 * (`@wrongstack/contracts/types/worktree-timeline`), so a lane here reads exactly
 * like the WebUI timeline and the TUI monitor. Seeded from the persisted event
 * log so a fresh browser sees history, then fed live; selecting a lane lists
 * its raw events below.
 */

import {
  formatWorktreeDuration,
  normalizeWorktreeEvent,
  projectWorktreeTimeline,
  shortWorktreeBranch,
  type WorktreeLane,
  type WorktreeLaneOutcome,
  type WorktreeLanePhase,
  type WorktreeTimelineEvent,
  worktreeTimelineTicks,
} from '@wrongstack/contracts/types/worktree-timeline';
import type { HqEventEnvelope, HqWorktreeEventPayload } from '@wrongstack/hq';
import {
  Check,
  CircleDot,
  GitBranch,
  GitMerge,
  MinusCircle,
  Package,
  PauseCircle,
  Trash2,
  TriangleAlert,
  XCircle,
} from 'lucide-react';
import type * as React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { EmptyState, Mono, toneText } from '../components/hq/primitives.js';
import { HeroMetric, Section, ViewHero, ViewShell } from '../components/hq/view-chrome.js';
import { Badge, type BadgeTone } from '../components/ui/badge.js';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card.js';
import type { HqTone } from '../domain/status-tone.js';
import { useBackfilledEvents } from '../domain/use-backfilled-events.js';
import { formatClock } from '../lib/format.js';
import { cn } from '../lib/utils.js';

const KIND_META: Record<string, { icon: typeof Check; tone: HqTone; badge: BadgeTone }> = {
  allocated: { icon: Package, tone: 'info', badge: 'info' },
  committed: { icon: Check, tone: 'active', badge: 'active' },
  merging: { icon: GitMerge, tone: 'info', badge: 'info' },
  merged: { icon: GitMerge, tone: 'active', badge: 'active' },
  conflict: { icon: TriangleAlert, tone: 'warn', badge: 'warn' },
  released: { icon: Trash2, tone: 'idle', badge: 'idle' },
  failed: { icon: XCircle, tone: 'error', badge: 'error' },
};

const FALLBACK = { icon: Package, tone: 'info' as HqTone, badge: 'info' as BadgeTone };

const OUTCOME_META: Record<
  WorktreeLaneOutcome,
  { icon: typeof Check; tone: HqTone; badge: BadgeTone; label: string }
> = {
  live: { icon: CircleDot, tone: 'warn', badge: 'warn', label: 'running' },
  merged: { icon: Check, tone: 'active', badge: 'active', label: 'merged' },
  conflict: { icon: TriangleAlert, tone: 'warn', badge: 'warn', label: 'conflict' },
  failed: { icon: XCircle, tone: 'error', badge: 'error', label: 'failed' },
  kept: { icon: PauseCircle, tone: 'idle', badge: 'idle', label: 'kept' },
  discarded: { icon: MinusCircle, tone: 'idle', badge: 'idle', label: 'discarded' },
};

const PHASE_CLASS: Record<WorktreeLanePhase, string> = {
  working: 'bg-warning/80',
  queued: 'border border-info/50 bg-info/20',
  merging: 'bg-info',
  kept: 'border border-dashed border-muted-foreground/50 bg-muted-foreground/10',
};

const PHASE_LABEL: Record<WorktreeLanePhase, string> = {
  working: 'working',
  queued: 'waiting to merge',
  merging: 'merging',
  kept: 'kept for review',
};

const STAGE_LABEL = {
  allocate: 'checkout creation failed',
  commit: 'commit refused (pre-commit hook or locked index)',
  merge: 'merge into base failed',
} as const;

function EventLine({ event }: { event: HqEventEnvelope }): React.ReactElement {
  const payload = event.payload as HqWorktreeEventPayload;
  const meta = KIND_META[payload.kind] ?? FALLBACK;
  const Icon = meta.icon;
  return (
    <div
      data-testid="worktree-event"
      data-kind={payload.kind}
      className="flex flex-wrap items-center gap-2 px-3 py-1.5 text-xs"
    >
      <Icon className={`size-3.5 shrink-0 ${toneText(meta.tone)}`} />
      <span className="font-medium">{payload.kind}</span>
      {payload.branch !== undefined && <Badge tone="info">{payload.branch}</Badge>}

      {payload.kind === 'committed' && (
        <Mono>
          <span className="text-success">+{payload.insertions ?? 0}</span>{' '}
          <span className="text-destructive">−{payload.deletions ?? 0}</span> in{' '}
          {payload.files ?? 0} file(s)
          {payload.sha !== undefined ? ` (${payload.sha.slice(0, 7)})` : ''}
        </Mono>
      )}
      {payload.kind === 'conflict' && payload.conflictFiles !== undefined && (
        <Mono className="text-destructive">conflicts: {payload.conflictFiles.join(', ')}</Mono>
      )}
      {payload.kind === 'failed' && (
        <Mono className="text-destructive">
          {payload.stage ? `${STAGE_LABEL[payload.stage]}: ` : ''}
          {payload.error}
        </Mono>
      )}

      <Mono className="tabular ml-auto">{formatClock(event.timestamp)}</Mono>
    </div>
  );
}

/** The envelope's session and timestamp are authoritative for a persisted event. */
function toTimelineEvent(envelope: HqEventEnvelope): WorktreeTimelineEvent | null {
  const payload = envelope.payload as HqWorktreeEventPayload;
  const at = Date.parse(envelope.timestamp);
  return normalizeWorktreeEvent(
    payload.kind,
    { ...payload, ...(envelope.sessionId ? { sessionId: envelope.sessionId } : {}) },
    Number.isFinite(at) ? at : 0,
  );
}

function LaneRow({
  lane,
  pct,
  end,
  selected,
  onSelect,
}: {
  lane: WorktreeLane;
  pct: (at: number) => number;
  end: number;
  selected: boolean;
  onSelect: () => void;
}): React.ReactElement {
  const meta = OUTCOME_META[lane.outcome];
  const Icon = meta.icon;
  return (
    <button
      type="button"
      data-testid="worktree-lane"
      data-outcome={lane.outcome}
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        'grid w-full grid-cols-[11rem_1fr_6rem] items-center gap-3 rounded-md px-2 py-1 text-left transition-colors hover:bg-muted/40',
        selected && 'bg-muted/60 ring-1 ring-primary/30',
      )}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <Icon
          className={cn(
            'size-3.5 shrink-0',
            toneText(meta.tone),
            lane.outcome === 'live' && 'animate-pulse',
          )}
        />
        <span className="min-w-0">
          <span className="block truncate font-mono text-xs">
            {shortWorktreeBranch(lane.branch)}
          </span>
          <span className="block truncate text-[11px] text-muted-foreground">
            {lane.ownerLabel}
          </span>
        </span>
      </span>
      <span className="relative block h-3">
        {lane.segments.map((seg, i) => {
          const left = pct(seg.start);
          const width = Math.max(0.6, pct(seg.end ?? end) - left);
          return (
            <span
              key={`${seg.phase}-${seg.start}-${i}`}
              data-phase={seg.phase}
              title={`${PHASE_LABEL[seg.phase]} · ${formatWorktreeDuration((seg.end ?? end) - seg.start)}`}
              className={cn('absolute inset-y-0 rounded-sm', PHASE_CLASS[seg.phase])}
              style={{ left: `${left}%`, width: `${width}%` }}
            />
          );
        })}
      </span>
      <Mono className="tabular text-right">
        {lane.commits.length > 0 ? (
          <>
            <span className="text-success">+{lane.insertions}</span>{' '}
            <span className="text-destructive">−{lane.deletions}</span>
          </>
        ) : (
          formatWorktreeDuration((lane.end ?? end) - lane.start)
        )}
      </Mono>
    </button>
  );
}

export function WorktreeView(): React.ReactElement {
  const { events, loading } = useBackfilledEvents('worktree.event', 300);
  const [now, setNow] = useState(() => Date.now());
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const timeline = useMemo(() => {
    const normalized: WorktreeTimelineEvent[] = [];
    for (const envelope of events) {
      const event = toTimelineEvent(envelope);
      if (event) normalized.push(event);
    }
    return projectWorktreeTimeline(normalized, { now });
  }, [events, now]);

  const live = timeline.counts.live > 0;
  useEffect(() => {
    setNow(Date.now());
  }, [events]);
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [live]);

  const lanes = timeline.lanes;
  const selected = lanes.find((l) => l.handleId === selectedId) ?? lanes.at(-1);
  const selectedEvents = useMemo(
    () =>
      selected
        ? events.filter((e) => (e.payload as HqWorktreeEventPayload).handleId === selected.handleId)
        : [],
    [events, selected],
  );

  if (lanes.length === 0) {
    return (
      <ViewShell>
        <EmptyState
          icon={GitBranch}
          title={loading ? 'Loading worktree history…' : 'No worktree events yet'}
          hint={
            loading
              ? undefined
              : 'These appear when Goal phases, SDD tasks or fleet subagents run in isolated git worktrees.'
          }
        />
      </ViewShell>
    );
  }

  const span = Math.max(1, timeline.end - timeline.start);
  const pct = (at: number) => Math.min(100, Math.max(0, ((at - timeline.start) / span) * 100));
  const ticks = worktreeTimelineTicks(timeline.start, timeline.end, 6);
  const attention = timeline.counts.conflict + timeline.counts.failed;
  const selectedMeta = selected ? OUTCOME_META[selected.outcome] : null;

  return (
    <ViewShell>
      <ViewHero
        eyebrow="Workspace lanes"
        headline="Parallel branch lifecycle"
        description="Each isolated worktree on one time axis: how long it worked, waited in the merge queue and merged — and which ones need a human."
        tone={attention > 0 ? 'error' : live ? 'warn' : 'active'}
        metrics={
          <>
            <HeroMetric label="worktrees" value={lanes.length} />
            <HeroMetric
              label="running"
              value={timeline.counts.live}
              tone={live ? 'warn' : 'active'}
            />
            <HeroMetric label="merged" value={timeline.counts.merged} tone="active" />
            <HeroMetric
              label="need attention"
              value={attention}
              tone={attention > 0 ? 'error' : 'active'}
            />
            {timeline.avgQueueMs !== undefined && (
              <HeroMetric
                label="avg merge wait"
                value={formatWorktreeDuration(timeline.avgQueueMs)}
              />
            )}
          </>
        }
      />

      <Section eyebrow={`base ${timeline.baseBranch ?? 'HEAD'}`} title="Timeline">
        <Card>
          <CardContent className="space-y-1 p-3">
            <div className="grid grid-cols-[11rem_1fr_6rem] items-center gap-3 px-2">
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <GitMerge className="size-3.5 text-primary" />
                <span className="truncate font-mono">{timeline.baseBranch ?? 'HEAD'}</span>
              </span>
              <span className="relative block h-4">
                <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-primary/40" />
                {timeline.baseCommits.map((c) => (
                  <span
                    key={`${c.handleId}-${c.at}`}
                    data-testid="worktree-base-commit"
                    title={`${shortWorktreeBranch(c.branch)} · ${new Date(c.at).toLocaleTimeString()}`}
                    className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-card bg-success"
                    style={{ left: `${pct(c.at)}%` }}
                  />
                ))}
              </span>
              <span />
            </div>
            {lanes.map((lane) => (
              <LaneRow
                key={lane.handleId}
                lane={lane}
                pct={pct}
                end={timeline.end}
                selected={lane.handleId === selected?.handleId}
                onSelect={() => setSelectedId(lane.handleId)}
              />
            ))}
            <div className="grid grid-cols-[11rem_1fr_6rem] gap-3 px-2">
              <span />
              <span className="relative block h-4 text-[11px] tabular-nums text-muted-foreground">
                {ticks.map((at) => (
                  <span
                    key={at}
                    className="absolute -translate-x-1/2 whitespace-nowrap"
                    style={{ left: `${pct(at)}%` }}
                  >
                    {new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                ))}
              </span>
              <span />
            </div>
          </CardContent>
        </Card>
      </Section>

      {selected && selectedMeta && (
        <Section eyebrow={selected.ownerLabel} title={shortWorktreeBranch(selected.branch)}>
          <Card data-testid="worktree-lane-detail">
            <CardHeader>
              <CardTitle className="truncate font-mono normal-case tracking-normal">
                {selected.branch}
              </CardTitle>
              <Badge tone={selectedMeta.badge}>{selectedMeta.label}</Badge>
              <Mono className="tabular ml-auto">
                {selected.onDisk ? 'checkout on disk' : 'checkout removed'}
              </Mono>
            </CardHeader>
            <CardContent className="divide-y divide-border/60 p-0">
              {selected.error && (
                <div className="px-3 py-2 text-xs">
                  <div className="font-medium text-destructive">
                    {selected.failedStage ? STAGE_LABEL[selected.failedStage] : 'failed'}
                  </div>
                  <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px]">
                    {selected.error.trim()}
                  </pre>
                </div>
              )}
              {selectedEvents.map((event) => (
                <EventLine key={event.id} event={event} />
              ))}
            </CardContent>
          </Card>
        </Section>
      )}
    </ViewShell>
  );
}
