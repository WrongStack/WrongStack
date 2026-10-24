/**
 * Worktree timeline projection — the single source of truth for how the
 * `worktree.*` lifecycle events of {@link WorktreeManager} read as a timeline.
 *
 * Three surfaces draw the same story: the WebUI (live events over its socket),
 * the TUI (straight off the EventBus) and HQ (a persisted, possibly gappy event
 * log). Each used to fold the events into its own status map, so a refused
 * commit, a merge queue wait or a kept-for-review checkout read differently —
 * or vanished — depending on the window. This module owns the fold: event
 * normalisation, per-worktree phase segments (working → queued → merging),
 * outcomes, and the base branch's squash commits. Surfaces only draw.
 *
 * Pure and dependency-free like `session-timeline.ts`: it ships as its own
 * build entry (`@wrongstack/contracts/types/worktree-timeline`) so browser bundles
 * can import it, so nothing here may reach `node:*` or a barrel.
 *
 * @module types/worktree-timeline
 */

/** Every EventBus event the timeline consumes, in lifecycle order. */
export const WORKTREE_EVENT_NAMES = [
  'worktree.allocated',
  'worktree.committed',
  'worktree.merging',
  'worktree.merged',
  'worktree.conflict',
  'worktree.failed',
  'worktree.released',
] as const;

export type WorktreeEventName = (typeof WORKTREE_EVENT_NAMES)[number];

export type WorktreeTimelineEventKind =
  | 'allocated'
  | 'committed'
  | 'merging'
  | 'merged'
  | 'conflict'
  | 'failed'
  | 'released';

export type WorktreeFailedStage = 'allocate' | 'commit' | 'merge';

/**
 * One normalised lifecycle event. Field names match the EventBus payloads and
 * `HqWorktreeEventPayload`, so an HQ envelope payload is already this shape
 * (plus the envelope timestamp as `at`).
 */
export interface WorktreeTimelineEvent {
  kind: WorktreeTimelineEventKind;
  /** Emit time in ms. */
  at: number;
  handleId: string;
  ownerId?: string | undefined;
  ownerLabel?: string | undefined;
  sessionId?: string | undefined;
  branch?: string | undefined;
  baseBranch?: string | undefined;
  dir?: string | undefined;
  /** `committed`: false when there was nothing to commit. */
  committed?: boolean | undefined;
  insertions?: number | undefined;
  deletions?: number | undefined;
  files?: number | undefined;
  sha?: string | undefined;
  squash?: boolean | undefined;
  conflictFiles?: readonly string[] | undefined;
  /** `released`: true when the checkout stays on disk. */
  kept?: boolean | undefined;
  error?: string | undefined;
  stage?: WorktreeFailedStage | undefined;
}

/** `released` with this handle id is the sweep of every managed checkout. */
export const WORKTREE_CLEANUP_ALL_HANDLE = 'cleanup-all';

const KINDS: ReadonlySet<string> = new Set<WorktreeTimelineEventKind>([
  'allocated',
  'committed',
  'merging',
  'merged',
  'conflict',
  'failed',
  'released',
]);
const STAGES: ReadonlySet<string> = new Set<WorktreeFailedStage>(['allocate', 'commit', 'merge']);

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);

/**
 * Normalise one event. `kind` is either an event name (`worktree.merged`) or a
 * bare kind (`merged`, as HQ carries it). `fallbackAt` is used when the payload
 * has no `at` (events from a pre-timeline emitter). Returns null for anything
 * that is not a worktree lifecycle event with a handle id.
 */
export function normalizeWorktreeEvent(
  kind: string,
  payload: unknown,
  fallbackAt: number,
): WorktreeTimelineEvent | null {
  const bare = kind.startsWith('worktree.') ? kind.slice('worktree.'.length) : kind;
  if (!KINDS.has(bare) || typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;
  const handleId = str(p['handleId']);
  if (!handleId) return null;
  const event: WorktreeTimelineEvent = {
    kind: bare as WorktreeTimelineEventKind,
    at: num(p['at']) ?? fallbackAt,
    handleId,
  };
  const assign = <K extends keyof WorktreeTimelineEvent>(
    key: K,
    value: WorktreeTimelineEvent[K] | undefined,
  ) => {
    if (value !== undefined) event[key] = value;
  };
  assign('ownerId', str(p['ownerId']));
  assign('ownerLabel', str(p['ownerLabel']));
  assign('sessionId', str(p['sessionId']));
  assign('branch', str(p['branch']));
  assign('baseBranch', str(p['baseBranch']));
  assign('dir', str(p['dir']));
  assign('committed', bool(p['committed']));
  assign('insertions', num(p['insertions']));
  assign('deletions', num(p['deletions']));
  assign('files', num(p['files']));
  assign('sha', str(p['sha']));
  assign('squash', bool(p['squash']));
  assign('kept', bool(p['kept']));
  assign('error', str(p['error']));
  const stage = str(p['stage']);
  if (stage && STAGES.has(stage)) event.stage = stage as WorktreeFailedStage;
  const files = p['conflictFiles'];
  if (Array.isArray(files)) event.conflictFiles = files.filter((f) => typeof f === 'string');
  return event;
}

/** Where a worktree's time went. A segment with no `end` is still running. */
export type WorktreeLanePhase = 'working' | 'queued' | 'merging' | 'kept';

export interface WorktreeLaneSegment {
  phase: WorktreeLanePhase;
  start: number;
  end?: number | undefined;
}

/**
 * - `live`: a run still owns it (working / queued / merging)
 * - `merged`: landed on base
 * - `conflict`: merge conflicted; kept for review
 * - `failed`: a step failed (see `failedStage`); kept for review
 * - `kept`: released on purpose without merging (auto-merge off)
 * - `discarded`: removed without merging (nothing to commit, cancelled)
 */
export type WorktreeLaneOutcome = 'live' | 'merged' | 'conflict' | 'failed' | 'kept' | 'discarded';

export interface WorktreeLane {
  handleId: string;
  ownerId?: string | undefined;
  ownerLabel: string;
  sessionId?: string | undefined;
  branch: string;
  baseBranch?: string | undefined;
  dir?: string | undefined;
  /** First event of this worktree. */
  start: number;
  /** Last lifecycle step; undefined while a segment is still open. */
  end?: number | undefined;
  segments: WorktreeLaneSegment[];
  outcome: WorktreeLaneOutcome;
  /** Diff stats of the latest worktree commit. */
  insertions: number;
  deletions: number;
  files: number;
  sha?: string | undefined;
  /** Worktree commits (each `committed: true`). */
  commits: Array<{
    at: number;
    sha?: string | undefined;
    insertions: number;
    deletions: number;
    files: number;
  }>;
  mergedAt?: number | undefined;
  conflictFiles: string[];
  error?: string | undefined;
  failedStage?: WorktreeFailedStage | undefined;
  /** The checkout is still on disk (kept for review, or a run still owns it). */
  onDisk: boolean;
  /** This lane's events in time order, for a detail view. */
  events: WorktreeTimelineEvent[];
}

export interface WorktreeTimeline {
  baseBranch?: string | undefined;
  /** Earliest lane start (or `now` when empty). */
  start: number;
  /** `now` while a worktree is live, else the last event time (kept lanes don't stretch it). */
  end: number;
  /** Oldest first. */
  lanes: WorktreeLane[];
  /** Squash commits that landed on base, in time order. */
  baseCommits: Array<{ at: number; handleId: string; branch: string }>;
  counts: Record<WorktreeLaneOutcome, number>;
  /** Mean finished merge-queue wait (committed → merging), when any. */
  avgQueueMs?: number | undefined;
}

export interface ProjectWorktreeTimelineOptions {
  /** Current time; open segments run to it. */
  now: number;
  /** Keep only this session's worktrees. */
  sessionId?: string | undefined;
  /** Newest lanes kept (default 200). */
  maxLanes?: number | undefined;
}

export const DEFAULT_WORKTREE_TIMELINE_LANES = 200;

interface LaneState {
  lane: WorktreeLane;
  open?: WorktreeLaneSegment | undefined;
  order: number;
}

/** Fold lifecycle events into one lane per worktree. Tolerates gaps and disorder. */
export function projectWorktreeTimeline(
  events: readonly WorktreeTimelineEvent[],
  opts: ProjectWorktreeTimelineOptions,
): WorktreeTimeline {
  // Scope by WORKTREE, not by event: a worktree belongs to the session any of
  // its events names, and its untagged events (a panel remove/merge, the
  // cleanup sweep) still apply to it.
  let scoped: readonly WorktreeTimelineEvent[] = events;
  if (opts.sessionId) {
    const owned = new Set(
      events.filter((e) => e.sessionId === opts.sessionId).map((e) => e.handleId),
    );
    scoped = events.filter(
      (e) =>
        owned.has(e.handleId) ||
        (e.handleId === WORKTREE_CLEANUP_ALL_HANDLE && e.sessionId === undefined),
    );
  }
  // Stable sort by time: equal timestamps keep arrival order (allocate and its
  // first commit can share a millisecond).
  const ordered = scoped
    .map((event, index) => ({ event, index }))
    .sort((a, b) => a.event.at - b.event.at || a.index - b.index)
    .map((x) => x.event);

  const states = new Map<string, LaneState>();
  const baseCommits: WorktreeTimeline['baseCommits'] = [];
  let baseBranch: string | undefined;
  let lastAt: number | undefined;

  const close = (state: LaneState, at: number): void => {
    if (state.open) {
      state.open.end = Math.max(state.open.start, at);
      state.open = undefined;
    }
    state.lane.end = at;
  };
  const openPhase = (state: LaneState, phase: WorktreeLanePhase, at: number): void => {
    if (state.open?.phase === phase) return;
    close(state, at);
    const segment: WorktreeLaneSegment = { phase, start: at };
    state.lane.segments.push(segment);
    state.open = segment;
    state.lane.end = undefined;
  };

  for (const e of ordered) {
    lastAt = e.at;
    if (e.kind === 'released' && e.handleId === WORKTREE_CLEANUP_ALL_HANDLE) {
      // The sweep removed every managed checkout: nothing kept stays on disk.
      for (const state of states.values()) {
        if (!state.lane.onDisk || state.lane.outcome === 'live') continue;
        close(state, e.at);
        state.lane.onDisk = false;
      }
      continue;
    }

    let state = states.get(e.handleId);
    if (!state) {
      state = {
        order: states.size,
        lane: {
          handleId: e.handleId,
          ownerLabel: e.ownerLabel ?? e.ownerId ?? e.handleId,
          branch: e.branch ?? e.handleId,
          start: e.at,
          segments: [],
          outcome: 'live',
          insertions: 0,
          deletions: 0,
          files: 0,
          commits: [],
          conflictFiles: [],
          onDisk: true,
          events: [],
        },
      };
      states.set(e.handleId, state);
    }
    const lane = state.lane;
    lane.events.push(e);
    if (e.ownerId) lane.ownerId = e.ownerId;
    if (e.ownerLabel) lane.ownerLabel = e.ownerLabel;
    if (e.sessionId) lane.sessionId = e.sessionId;
    if (e.branch) lane.branch = e.branch;
    if (e.dir) lane.dir = e.dir;
    if (e.baseBranch) {
      lane.baseBranch = e.baseBranch;
      baseBranch = e.baseBranch;
    }

    switch (e.kind) {
      case 'allocated':
        lane.start = Math.min(lane.start, e.at);
        if (lane.outcome === 'live') openPhase(state, 'working', e.at);
        break;
      case 'committed':
        if (e.committed === false) break;
        lane.insertions = e.insertions ?? lane.insertions;
        lane.deletions = e.deletions ?? lane.deletions;
        lane.files = e.files ?? lane.files;
        if (e.sha) lane.sha = e.sha;
        lane.commits.push({
          at: e.at,
          sha: e.sha,
          insertions: e.insertions ?? 0,
          deletions: e.deletions ?? 0,
          files: e.files ?? 0,
        });
        if (lane.outcome === 'live') openPhase(state, 'queued', e.at);
        break;
      case 'merging':
        lane.outcome = 'live';
        openPhase(state, 'merging', e.at);
        break;
      case 'merged':
        close(state, e.at);
        lane.outcome = 'merged';
        lane.mergedAt = e.at;
        baseCommits.push({ at: e.at, handleId: lane.handleId, branch: lane.branch });
        break;
      case 'conflict':
        lane.outcome = 'conflict';
        lane.conflictFiles = [...(e.conflictFiles ?? [])];
        openPhase(state, 'kept', e.at);
        break;
      case 'failed':
        lane.outcome = 'failed';
        lane.error = e.error;
        lane.failedStage = e.stage;
        openPhase(state, 'kept', e.at);
        break;
      case 'released':
        if (e.kept) {
          lane.onDisk = true;
          if (lane.outcome === 'live') lane.outcome = 'kept';
          if (lane.outcome !== 'merged') openPhase(state, 'kept', e.at);
        } else {
          close(state, e.at);
          lane.onDisk = false;
          if (lane.outcome === 'live') lane.outcome = 'discarded';
        }
        break;
    }
  }

  const max = opts.maxLanes ?? DEFAULT_WORKTREE_TIMELINE_LANES;
  const lanes = [...states.values()]
    .sort((a, b) => a.lane.start - b.lane.start || a.order - b.order)
    .slice(-max)
    .map((s) => s.lane);
  const kept = new Set(lanes.map((l) => l.handleId));

  const counts: Record<WorktreeLaneOutcome, number> = {
    live: 0,
    merged: 0,
    conflict: 0,
    failed: 0,
    kept: 0,
    discarded: 0,
  };
  let queueTotal = 0;
  let queueCount = 0;
  for (const lane of lanes) {
    counts[lane.outcome]++;
    for (const seg of lane.segments) {
      if (seg.end !== undefined && seg.phase === 'queued') {
        queueTotal += seg.end - seg.start;
        queueCount++;
      }
    }
  }

  const start = lanes.length > 0 ? Math.min(...lanes.map((l) => l.start)) : opts.now;
  // Only running work grows the axis to `now`. A checkout parked for review
  // stays open indefinitely; letting it stretch the axis would squeeze the
  // run's real activity into a sliver hours later. Renderers draw open
  // segments to `end`.
  const end = counts.live > 0 ? Math.max(opts.now, lastAt ?? opts.now) : (lastAt ?? opts.now);
  return {
    ...(baseBranch ? { baseBranch } : {}),
    start,
    end: Math.max(end, start),
    lanes,
    baseCommits: baseCommits.filter((c) => kept.has(c.handleId)),
    counts,
    ...(queueCount > 0 ? { avgQueueMs: Math.round(queueTotal / queueCount) } : {}),
  };
}

const TICK_STEPS_MS = [
  1_000,
  5_000,
  10_000,
  15_000,
  30_000,
  60_000,
  2 * 60_000,
  5 * 60_000,
  10 * 60_000,
  15 * 60_000,
  30 * 60_000,
  3_600_000,
  2 * 3_600_000,
  6 * 3_600_000,
  12 * 3_600_000,
  86_400_000,
];

/**
 * Axis ticks for `[start, end]`: round wall-clock instants spaced by the
 * smallest "nice" step that yields at most `maxTicks` marks.
 */
export function worktreeTimelineTicks(start: number, end: number, maxTicks = 5): number[] {
  const span = Math.max(0, end - start);
  if (span === 0 || maxTicks < 1) return [start];
  const step =
    TICK_STEPS_MS.find((s) => span / s <= maxTicks) ??
    Math.ceil(span / maxTicks / 86_400_000) * 86_400_000;
  const ticks: number[] = [];
  for (let t = Math.ceil(start / step) * step; t <= end; t += step) ticks.push(t);
  return ticks;
}

/** Compact duration: `850ms`, `42s`, `3m 05s`, `1h 02m`. */
export function formatWorktreeDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** Branch name without the managed `wstack/ap/` prefix. */
export function shortWorktreeBranch(branch: string): string {
  return branch.replace(/^wstack\/ap\//, '');
}
