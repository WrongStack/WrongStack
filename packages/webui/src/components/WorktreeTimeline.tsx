import {
  formatWorktreeDuration,
  shortWorktreeBranch,
  type WorktreeLane,
  type WorktreeLaneOutcome,
  type WorktreeLanePhase,
  type WorktreeTimelineEvent,
  worktreeTimelineTicks,
} from '@wrongstack/contracts/types/worktree-timeline';
import {
  AlertTriangle,
  CheckCircle2,
  CircleDot,
  Eye,
  FolderOpen,
  GitCommitHorizontal,
  GitMerge,
  Loader2,
  MinusCircle,
  PauseCircle,
  Terminal,
  Trash2,
  X,
  XCircle,
} from 'lucide-react';
import type { CSSProperties } from 'react';
import { useMemo, useState } from 'react';
import { useWorktreeActions } from '@/hooks/useWorktreeActions';
import { useWorktreeTimeline } from '@/hooks/useWorktreeTimeline';
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { useWorktreeStore } from '@/stores';
import { WorktreeDiffSummaryView } from './WorktreeDiffSummary';

/** Width of the label column; the now-cursor overlay offsets by the same amount. */
const LABEL_COL = '9.5rem';
/** Compact (panel header) view shows only the newest lanes. */
const COMPACT_LANES = 12;

const PHASE_STYLE: Record<WorktreeLanePhase, { className: string; style?: CSSProperties }> = {
  working: { className: 'bg-warning/80' },
  // Stripes read as "waiting", distinct from the solid merge that follows.
  queued: {
    className: 'border border-info/50',
    style: {
      backgroundImage:
        'repeating-linear-gradient(135deg, hsl(var(--info) / 0.4) 0 3px, transparent 3px 7px)',
    },
  },
  merging: { className: 'bg-info' },
  kept: { className: 'border border-dashed border-muted-foreground/50 bg-muted-foreground/10' },
};

const OUTCOME_META: Record<
  WorktreeLaneOutcome,
  { icon: typeof CheckCircle2; tone: string; labelKey: string }
> = {
  live: { icon: CircleDot, tone: 'text-warning', labelKey: 'outcomeLive' },
  merged: { icon: CheckCircle2, tone: 'text-success', labelKey: 'outcomeMerged' },
  conflict: { icon: AlertTriangle, tone: 'text-destructive', labelKey: 'outcomeConflict' },
  failed: { icon: XCircle, tone: 'text-destructive', labelKey: 'outcomeFailed' },
  kept: { icon: PauseCircle, tone: 'text-muted-foreground', labelKey: 'outcomeKept' },
  discarded: { icon: MinusCircle, tone: 'text-muted-foreground', labelKey: 'outcomeDiscarded' },
};

const PHASE_LABEL: Record<WorktreeLanePhase, string> = {
  working: 'phaseWorking',
  queued: 'phaseQueued',
  merging: 'phaseMerging',
  kept: 'phaseKept',
};

const OUTCOME_ORDER: WorktreeLaneOutcome[] = ['live', 'merged', 'conflict', 'failed', 'kept'];

function clock(at: number, seconds: boolean): string {
  return new Date(at).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    ...(seconds ? { second: '2-digit' } : {}),
  });
}

/** Total time per phase, open segments counted to `until`. */
function phaseTotals(
  lane: WorktreeLane,
  until: number,
): Partial<Record<WorktreeLanePhase, number>> {
  const totals: Partial<Record<WorktreeLanePhase, number>> = {};
  for (const seg of lane.segments) {
    totals[seg.phase] = (totals[seg.phase] ?? 0) + Math.max(0, (seg.end ?? until) - seg.start);
  }
  return totals;
}

/**
 * WorktreeTimelineView — every managed git worktree as a lane on one time axis:
 * working → waiting to merge → merging, then merged / conflict / failed. The
 * base branch row marks each squash commit. Click a lane for its lifecycle,
 * error, conflicts and actions. Data comes from the shared core projector, so
 * it reads the same as the TUI monitor and HQ.
 */
export function WorktreeTimelineView({
  sessionId,
  compact = false,
}: {
  /** Offer a "this session / all" scope; omitted → all sessions. */
  sessionId?: string | undefined;
  compact?: boolean;
}): React.ReactElement | null {
  const { t } = useAppTranslation();
  const [scope, setScope] = useState<'session' | 'all'>('session');
  const scopedSession = sessionId && scope === 'session' ? sessionId : undefined;
  const timeline = useWorktreeTimeline(scopedSession);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const lanes = compact ? timeline.lanes.slice(-COMPACT_LANES) : timeline.lanes;
  const span = Math.max(1, timeline.end - timeline.start);
  const pct = (at: number) => Math.min(100, Math.max(0, ((at - timeline.start) / span) * 100));
  const selected = lanes.find((l) => l.handleId === selectedId);
  const ticks = useMemo(
    () => worktreeTimelineTicks(timeline.start, timeline.end, 5),
    [timeline.start, timeline.end],
  );
  const withSeconds = span < 10 * 60_000;
  const tr = (key: string, opts?: Record<string, unknown>) =>
    t(`activity:worktreeTimeline.${key}`, opts);

  if (compact) {
    if (lanes.length === 0) return null;
    return (
      <div
        data-testid="worktree-timeline-compact"
        role="img"
        aria-label={tr('chartAria', { base: timeline.baseBranch ?? 'HEAD' })}
        className="flex flex-col gap-0.5 rounded border border-border/60 bg-muted/20 p-1.5"
      >
        {lanes.map((lane) => (
          <LaneBar key={lane.handleId} lane={lane} pct={pct} end={timeline.end} thin tr={tr} />
        ))}
      </div>
    );
  }

  return (
    <section data-testid="worktree-timeline" className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        {OUTCOME_ORDER.filter((o) => timeline.counts[o] > 0).map((o) => {
          const meta = OUTCOME_META[o];
          const Icon = meta.icon;
          return (
            <span key={o} className="inline-flex items-center gap-1" data-outcome-count={o}>
              <Icon className={cn('h-3 w-3', meta.tone)} aria-hidden />
              <span className="tabular-nums text-foreground">{timeline.counts[o]}</span>
              {tr(meta.labelKey)}
            </span>
          );
        })}
        {timeline.avgQueueMs !== undefined && (
          <span>{tr('avgQueue', { duration: formatWorktreeDuration(timeline.avgQueueMs) })}</span>
        )}
        {sessionId && (
          <div className="ml-auto inline-flex rounded-md border border-border p-0.5">
            {(['session', 'all'] as const).map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={scope === s}
                onClick={() => setScope(s)}
                className={cn(
                  'rounded px-2 py-0.5 text-[11px] transition-colors',
                  scope === s
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {tr(s === 'session' ? 'scopeSession' : 'scopeAll')}
              </button>
            ))}
          </div>
        )}
      </div>

      {lanes.length === 0 ? (
        <div className="rounded-lg border border-border/70 bg-muted/20 px-3 py-4 text-xs">
          <div className="font-medium text-foreground">{tr('empty')}</div>
          <div className="mt-1 text-muted-foreground">{tr('emptyHint')}</div>
        </div>
      ) : (
        <figure
          className="relative m-0 rounded-lg border border-border/70 bg-card/60 px-2 py-2"
          aria-label={tr('chartAria', { base: timeline.baseBranch ?? 'HEAD' })}
        >
          <div
            className="grid items-center gap-y-1"
            style={{ gridTemplateColumns: `${LABEL_COL} 1fr` }}
          >
            {/* Base branch: one dot per squash commit that landed. */}
            <div className="flex min-w-0 items-center gap-1.5 pr-2 text-[11px] text-muted-foreground">
              <GitCommitHorizontal className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
              <code className="truncate font-mono text-foreground">
                {timeline.baseBranch ?? 'HEAD'}
              </code>
            </div>
            <div className="relative h-4">
              <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-primary/40" />
              {timeline.baseCommits.map((c) => (
                <span
                  key={`${c.handleId}-${c.at}`}
                  data-testid="worktree-base-commit"
                  title={`${shortWorktreeBranch(c.branch)} · ${clock(c.at, true)}`}
                  className={cn(
                    'absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-card bg-success transition-transform',
                    hoveredId === c.handleId && 'scale-150',
                  )}
                  style={{ left: `${pct(c.at)}%` }}
                />
              ))}
            </div>

            {lanes.map((lane) => {
              const meta = OUTCOME_META[lane.outcome];
              const isSelected = lane.handleId === selectedId;
              return (
                <button
                  key={lane.handleId}
                  type="button"
                  data-testid="worktree-lane"
                  data-outcome={lane.outcome}
                  aria-pressed={isSelected}
                  aria-label={tr('laneAria', {
                    branch: shortWorktreeBranch(lane.branch),
                    outcome: tr(meta.labelKey),
                  })}
                  onClick={() => setSelectedId(isSelected ? null : lane.handleId)}
                  onMouseEnter={() => setHoveredId(lane.handleId)}
                  onMouseLeave={() => setHoveredId(null)}
                  className={cn(
                    'col-span-2 grid items-center rounded-md py-0.5 text-left transition-colors hover:bg-accent/30',
                    isSelected && 'bg-accent/40 ring-1 ring-primary/30',
                  )}
                  style={{ gridTemplateColumns: `${LABEL_COL} 1fr` }}
                >
                  <span className="flex min-w-0 flex-col pr-2 pl-1">
                    <span className="flex min-w-0 items-center gap-1">
                      <meta.icon
                        className={cn(
                          'h-3 w-3 shrink-0',
                          meta.tone,
                          lane.outcome === 'live' && 'animate-pulse',
                        )}
                        aria-hidden
                      />
                      <code className="truncate font-mono text-[11px] text-foreground">
                        {shortWorktreeBranch(lane.branch)}
                      </code>
                    </span>
                    <span className="truncate pl-4 text-[10px] text-muted-foreground">
                      {lane.ownerLabel}
                    </span>
                  </span>
                  <LaneBar lane={lane} pct={pct} end={timeline.end} tr={tr} />
                </button>
              );
            })}

            {/* Time axis */}
            <div />
            <div className="relative h-4 text-[10px] tabular-nums text-muted-foreground">
              {ticks.map((at) => (
                <span
                  key={at}
                  className="absolute top-0 -translate-x-1/2 whitespace-nowrap"
                  style={{ left: `${pct(at)}%` }}
                >
                  {clock(at, withSeconds)}
                </span>
              ))}
            </div>
          </div>

          {/* While anything is live the axis ends at "now", so the cursor sits
              on the track's right edge (the container's px-2). */}
          {timeline.counts.live > 0 && (
            <div
              aria-hidden
              data-testid="worktree-now-cursor"
              title={tr('now')}
              className="pointer-events-none absolute top-2 right-2 bottom-6 w-px bg-warning/70"
            />
          )}
        </figure>
      )}

      {selected && (
        <LaneDetail
          lane={selected}
          // A parked checkout keeps aging after the axis stops at its last event.
          until={Math.max(timeline.end, Date.now())}
          baseBranch={timeline.baseBranch}
          onClose={() => setSelectedId(null)}
          tr={tr}
        />
      )}
    </section>
  );
}

function LaneBar({
  lane,
  pct,
  end,
  thin = false,
  tr,
}: {
  lane: WorktreeLane;
  pct: (at: number) => number;
  end: number;
  thin?: boolean;
  tr: (key: string, opts?: Record<string, unknown>) => string;
}): React.ReactElement {
  const laneEnd = lane.end ?? end;
  const meta = OUTCOME_META[lane.outcome];
  return (
    <span className={cn('relative block', thin ? 'h-1.5' : 'h-3')}>
      {lane.segments.map((seg, i) => {
        const left = pct(seg.start);
        // Keep instant steps (a no-op merge) visible as a sliver.
        const width = Math.max(thin ? 0.8 : 0.6, pct(seg.end ?? end) - left);
        const style = PHASE_STYLE[seg.phase];
        const duration = formatWorktreeDuration((seg.end ?? end) - seg.start);
        return (
          <span
            key={`${seg.phase}-${seg.start}-${i}`}
            data-phase={seg.phase}
            title={tr('segmentTitle', { phase: tr(PHASE_LABEL[seg.phase]), duration })}
            className={cn('absolute inset-y-0 rounded-sm', style.className)}
            style={{ left: `${left}%`, width: `${width}%`, ...style.style }}
          />
        );
      })}
      {!thin && lane.outcome !== 'live' && (
        <meta.icon
          aria-hidden
          className={cn(
            'absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-card',
            meta.tone,
          )}
          style={{ left: `${pct(lane.mergedAt ?? laneEnd)}%` }}
        />
      )}
    </span>
  );
}

const EVENT_LABEL: Record<WorktreeTimelineEvent['kind'], string> = {
  allocated: 'evAllocated',
  committed: 'evCommitted',
  merging: 'evMerging',
  merged: 'evMerged',
  conflict: 'evConflict',
  failed: 'evFailed',
  released: 'evReleased',
};

function eventDetail(e: WorktreeTimelineEvent): string | undefined {
  if (e.kind === 'committed') {
    if (e.committed === false) return undefined;
    const sha = e.sha ? ` · ${e.sha.slice(0, 7)}` : '';
    return `+${e.insertions ?? 0} −${e.deletions ?? 0} · ${e.files ?? 0}f${sha}`;
  }
  if (e.kind === 'conflict') return e.conflictFiles?.join(', ');
  if (e.kind === 'failed') return e.error?.trim().split('\n')[0];
  return undefined;
}

function LaneDetail({
  lane,
  until,
  baseBranch,
  onClose,
  tr,
}: {
  lane: WorktreeLane;
  until: number;
  baseBranch?: string | undefined;
  onClose: () => void;
  tr: (key: string, opts?: Record<string, unknown>) => string;
}): React.ReactElement {
  const actions = useWorktreeActions();
  const diffByDir = useWorktreeStore((s) => s.diffByDir);
  const [showDiff, setShowDiff] = useState(false);
  const meta = OUTCOME_META[lane.outcome];
  const totals = phaseTotals(lane, until);
  const live = lane.outcome === 'live';
  const canAct = lane.onDisk && !live && Boolean(lane.dir);
  const busy = actions.busyBranch === lane.branch;
  const diff = lane.dir ? diffByDir[lane.dir] : undefined;

  return (
    <div
      data-testid="worktree-lane-detail"
      className="rounded-lg border border-border/70 bg-card/80 p-3 text-xs"
    >
      <div className="flex items-start gap-2">
        <meta.icon className={cn('mt-0.5 h-4 w-4 shrink-0', meta.tone)} aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <code className="truncate font-mono text-sm text-foreground">
              {shortWorktreeBranch(lane.branch)}
            </code>
            <span
              className={cn('rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium', meta.tone)}
            >
              {tr(meta.labelKey)}
            </span>
          </div>
          <div className="mt-0.5 truncate text-muted-foreground">{lane.ownerLabel}</div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={tr('close')}
          title={tr('close')}
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        {lane.commits.length > 0 && (
          <span>
            <span className="text-success">+{lane.insertions}</span>{' '}
            <span className="text-destructive">−{lane.deletions}</span> · {lane.files}f
            {lane.sha ? ` · ${lane.sha.slice(0, 7)}` : ''}
          </span>
        )}
        {(Object.keys(PHASE_LABEL) as WorktreeLanePhase[])
          .filter((p) => totals[p] !== undefined)
          .map((p) => (
            <span key={p}>
              {tr(PHASE_LABEL[p])} {formatWorktreeDuration(totals[p] ?? 0)}
            </span>
          ))}
        <span>{tr(lane.onDisk ? 'onDisk' : 'removedFromDisk')}</span>
      </div>

      {lane.error && (
        <div className="mt-2 rounded border border-destructive/30 bg-destructive/5 p-2">
          <div className="text-[11px] font-medium text-destructive">
            {lane.failedStage ? tr(`stage_${lane.failedStage}`) : tr('outcomeFailed')}
          </div>
          <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] text-foreground">
            {lane.error.trim()}
          </pre>
        </div>
      )}

      {lane.conflictFiles.length > 0 && (
        <div className="mt-2">
          <div className="text-[11px] font-medium text-foreground">{tr('conflicts')}</div>
          <ul className="mt-0.5 space-y-0.5 font-mono text-[10px] text-destructive">
            {lane.conflictFiles.map((f) => (
              <li key={f} className="truncate">
                {f}
              </li>
            ))}
          </ul>
        </div>
      )}

      <ol className="mt-2 space-y-0.5 border-l border-border pl-2" aria-label={tr('lifecycle')}>
        {lane.events.map((e, i) => {
          const detail = eventDetail(e);
          return (
            <li key={`${e.kind}-${e.at}-${i}`} className="flex gap-2 text-[11px]">
              <span className="w-16 shrink-0 tabular-nums text-muted-foreground">
                {clock(e.at, true)}
              </span>
              <span className="shrink-0 text-foreground">
                {e.kind === 'released'
                  ? tr(e.kept ? 'evReleasedKept' : 'evReleased')
                  : tr(EVENT_LABEL[e.kind], { base: e.baseBranch ?? baseBranch ?? 'base' })}
              </span>
              {detail && <span className="min-w-0 truncate text-muted-foreground">{detail}</span>}
            </li>
          );
        })}
      </ol>

      {canAct && (
        <div className="mt-2 flex items-center gap-0.5 border-t border-border/60 pt-2">
          <DetailAction
            title={tr('actTerminal')}
            onClick={() => actions.open(lane.dir, 'terminal')}
          >
            <Terminal className="h-3.5 w-3.5" />
          </DetailAction>
          <DetailAction
            title={tr('actFolder')}
            onClick={() => actions.open(lane.dir, 'file-manager')}
          >
            <FolderOpen className="h-3.5 w-3.5" />
          </DetailAction>
          <DetailAction
            title={tr('actChanges')}
            onClick={() => {
              actions.viewChanges(lane.dir);
              setShowDiff((v) => !v);
            }}
          >
            <Eye className="h-3.5 w-3.5" />
          </DetailAction>
          {lane.outcome !== 'merged' && (
            <DetailAction title={tr('actMerge')} onClick={() => actions.merge(lane.branch)}>
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <GitMerge className="h-3.5 w-3.5" />
              )}
            </DetailAction>
          )}
          <DetailAction
            title={tr('actRemove')}
            danger
            onClick={() => actions.remove({ dir: lane.dir, branch: lane.branch })}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </DetailAction>
        </div>
      )}
      {showDiff && diff !== undefined && (
        <div className="mt-1.5">
          <WorktreeDiffSummaryView diff={diff} />
        </div>
      )}
    </div>
  );
}

function DetailAction({
  title,
  onClick,
  danger,
  children,
}: {
  title: string;
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className={cn(
        'rounded p-1 text-muted-foreground hover:bg-muted',
        danger ? 'hover:text-destructive' : 'hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}

export type WorktreeViewMode = 'timeline' | 'lanes' | 'graph';

/** Timeline / lanes / graph switch shared by the dock inspector and GoalView. */
export function WorktreeViewSwitch({
  value,
  onChange,
}: {
  value: WorktreeViewMode;
  onChange: (mode: WorktreeViewMode) => void;
}): React.ReactElement {
  const { t } = useAppTranslation();
  const label: Record<WorktreeViewMode, string> = {
    timeline: 'viewTimeline',
    lanes: 'viewLanes',
    graph: 'viewGraph',
  };
  return (
    <div className="inline-flex rounded-md border border-border p-0.5">
      {(['timeline', 'lanes', 'graph'] as const).map((mode) => (
        <button
          key={mode}
          type="button"
          aria-pressed={value === mode}
          onClick={() => onChange(mode)}
          className={cn(
            'rounded px-2 py-0.5 text-xs transition-colors',
            value === mode
              ? 'bg-primary/10 text-primary'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {t(`activity:worktreeTimeline.${label[mode]}`)}
        </button>
      ))}
    </div>
  );
}

/** Distinct worktrees in the timeline log for `sessionId` — a cheap boolean-ish selector input. */
export function useSessionWorktreeCount(sessionId: string | undefined): number {
  return useWorktreeStore((s) => {
    const ids = new Set<string>();
    for (const e of s.timelineEvents) {
      if (!sessionId || e.sessionId === sessionId) ids.add(e.handleId);
    }
    return ids.size;
  });
}
