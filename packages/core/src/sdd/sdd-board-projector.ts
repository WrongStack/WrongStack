/**
 * SddBoardProjector
 *
 * Composes a live SDD board snapshot from a running graph and streams it to
 * every surface. It subscribes to `TaskTracker` mutations (the source of truth
 * for task state) plus the run's `sdd.*` lifecycle events (status / wave /
 * deadlock), and on each change — throttled — rebuilds a `SddBoardSnapshot`,
 * emits `sdd.board.snapshot` on the EventBus, persists it (JSON) and appends the
 * triggering event to the board's JSONL log.
 *
 * The graph is the single source of truth: task status/assignee/worktree live
 * on the nodes (the run mutates them through the tracker), so the projector
 * mostly re-derives the snapshot and only tracks run-level status/wave/deadlock.
 */
import type { EventBus, EventMap } from '../kernel/events.js';
import type { TaskGraph } from '../types/task-graph.js';
import type { TaskTracker } from './task-tracker.js';
import {
  buildBoardSnapshot,
  shortIdMap,
  type SddBoardFeedEntry,
  type SddBoardStatus,
  type SddDeadlockChain,
} from './board-types.js';
import type { SddBoardStore } from './sdd-board-store.js';

export interface SddBoardProjectorOptions {
  runId: string;
  graph: TaskGraph;
  tracker: TaskTracker;
  events: EventBus;
  /** Parent session id for emitted `sdd.board.snapshot` events. */
  sessionId?: string | (() => string | undefined) | undefined;
  /** Persist snapshots + JSONL events (optional — omit for in-memory only). */
  store?: SddBoardStore | undefined;
  specId?: string | undefined;
  /** Run-level default worker model/provider/fallbacks (shown in the board header). */
  defaultModel?: string | undefined;
  defaultProvider?: string | undefined;
  fallbackModels?: string[] | undefined;
  /** Base branch the run's squash commits land on (for the board + rollback). */
  baseBranch?: string | undefined;
  /** Snapshot coalescing window in ms (default 250). */
  throttleMs?: number | undefined;
  /** Clock injection for tests; defaults to Date.now. */
  now?: (() => number) | undefined;
}

export class SddBoardProjector {
  private readonly o: SddBoardProjectorOptions;
  private readonly now: () => number;
  private readonly throttleMs: number;
  private readonly shortId: Map<string, string>;

  private status: SddBoardStatus = 'idle';
  private wave = 0;
  private startedAt: number;
  private deadlockChains: SddDeadlockChain[] = [];
  /** Live activity feed, most recent first (capped). */
  private feed: SddBoardFeedEntry[] = [];
  private static readonly FEED_CAP = 60;
  private finished = false;
  private runDeadlocked = false;
  private runStopped = false;
  /** Squash commits the run landed on the base branch (for post-run rollback). */
  private mergedCommits: Array<{ taskId: string; sha: string; title: string }> = [];
  /** Base branch reported by the run at start (overrides the constructor option). */
  private runBaseBranch: string | undefined;

  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly unsubs: Array<() => void> = [];
  /** Tail of in-flight persistence, so callers can await a settled state. */
  private lastSave: Promise<void> = Promise.resolve();

  constructor(opts: SddBoardProjectorOptions) {
    this.o = opts;
    this.now = opts.now ?? Date.now;
    this.throttleMs = opts.throttleMs ?? 250;
    this.shortId = shortIdMap(opts.graph);
    this.startedAt = this.now();

    // Source of truth: any task mutation redraws the board.
    this.unsubs.push(opts.tracker.subscribe(() => this.markDirty()));

    // Run lifecycle → status/wave/deadlock + JSONL audit.
    this.onRun('sdd.run.started', (e) => {
      this.status = 'running';
      this.startedAt = this.now();
      if (e.baseBranch) this.runBaseBranch = e.baseBranch;
      this.markDirty();
    });
    this.onRun('sdd.run.finished', (e) => {
      this.finished = true;
      this.runDeadlocked = e.deadlocked;
      this.runStopped = e.stopped;
      this.flush(); // final snapshot persists synchronously
    });
    this.onRun('sdd.wave', (e) => {
      this.wave = e.wave;
      this.pushFeed({ ts: this.now(), kind: 'wave', text: `Wave ${e.wave + 1} started · ${e.batchSize} task(s) in parallel` });
      this.markDirty();
    });
    this.onRun('sdd.deadlock', (e) => {
      this.deadlockChains = e.chains.map((c) => ({
        blocked: this.shortId.get(c.blocked) ?? c.blocked.slice(0, 6),
        blockedBy: c.blockedBy.map((b) => this.shortId.get(b) ?? b.slice(0, 6)),
      }));
      this.pushFeed({ ts: this.now(), kind: 'deadlock', text: `Deadlock — ${e.chains.length} task(s) blocked by failed work` });
      this.markDirty();
    });
    // Task lifecycle → live activity feed (task STATE comes from the tracker,
    // which already triggers a redraw; here we narrate "what just happened").
    this.onRun('sdd.task.started', (e) => {
      const sid = this.shortId.get(e.taskId);
      this.pushFeed({
        ts: this.now(),
        kind: 'started',
        taskShortId: sid,
        agentName: e.agentName,
        text: `${e.agentName || 'a worker'} picked up ${sid ?? 'a task'}${this.titleOf(e.taskId)}`,
      });
      this.markDirty();
    });
    this.onRun('sdd.task.completed', (e) => {
      const sid = this.shortId.get(e.taskId);
      const agent = this.assigneeOf(e.taskId);
      this.pushFeed({
        ts: this.now(),
        kind: 'completed',
        taskShortId: sid,
        agentName: agent,
        text: `${sid ?? 'task'}${this.titleOf(e.taskId)} completed${agent ? ` by ${agent}` : ''} · ${(e.durationMs / 1000).toFixed(1)}s`,
      });
      this.markDirty();
    });
    this.onRun('sdd.task.failed', (e) => {
      const sid = this.shortId.get(e.taskId);
      this.pushFeed({
        ts: this.now(),
        kind: 'failed',
        taskShortId: sid,
        agentName: this.assigneeOf(e.taskId),
        text: `${sid ?? 'task'}${this.titleOf(e.taskId)} failed — ${e.error}`,
      });
      this.markDirty();
    });
    this.onRun('sdd.task.retrying', (e) => {
      const sid = this.shortId.get(e.taskId);
      this.pushFeed({
        ts: this.now(),
        kind: 'retrying',
        taskShortId: sid,
        text: `${sid ?? 'task'}${this.titleOf(e.taskId)} retrying (${e.attempt}/${e.maxRetries})`,
      });
      this.markDirty();
    });
    // Robustness events (completion gate / merge / supervisor / split) — narrate
    // "why a task didn't just sail to done" so the board never silently hides a
    // gate rejection, conflict, or supervisor verdict.
    this.onRun('sdd.task.verification_failed', (e) => {
      const sid = this.shortId.get(e.taskId);
      this.pushFeed({
        ts: this.now(),
        kind: 'verification_failed',
        taskShortId: sid,
        agentName: this.assigneeOf(e.taskId),
        text: `${sid ?? 'task'}${this.titleOf(e.taskId)} failed verification — ${e.reason}`,
      });
      this.markDirty();
    });
    this.onRun('sdd.task.conflict', (e) => {
      const sid = this.shortId.get(e.taskId);
      const files = e.conflictFiles.length;
      this.pushFeed({
        ts: this.now(),
        kind: 'conflict',
        taskShortId: sid,
        agentName: this.assigneeOf(e.taskId),
        text: `${sid ?? 'task'}${this.titleOf(e.taskId)} merge conflict — ${files} file(s)${files ? `: ${e.conflictFiles.slice(0, 3).join(', ')}${files > 3 ? '…' : ''}` : ''}`,
      });
      this.markDirty();
    });
    this.onRun('sdd.task.merged', (e) => {
      // Persist the run commit so a post-run rollback can revert it off disk.
      const title = this.o.graph.nodes.get(e.taskId)?.title ?? '';
      this.mergedCommits.push({ taskId: e.taskId, sha: e.sha, title });
      const sid = this.shortId.get(e.taskId);
      this.pushFeed({
        ts: this.now(),
        kind: 'completed',
        taskShortId: sid,
        text: `${sid ?? 'task'}${this.titleOf(e.taskId)} merged → ${this.runBaseBranch ?? this.o.baseBranch ?? 'base'} (${e.sha.slice(0, 8)})`,
      });
      this.markDirty();
    });
    this.onRun('sdd.task.split', (e) => {
      const sid = this.shortId.get(e.taskId);
      this.pushFeed({
        ts: this.now(),
        kind: 'split',
        taskShortId: sid,
        text: `${sid ?? 'task'}${this.titleOf(e.taskId)} split into ${e.subtaskIds.length} sub-task(s)`,
      });
      this.markDirty();
    });
    this.onRun('sdd.supervisor.decision', (e) => {
      const sid = this.shortId.get(e.taskId);
      this.pushFeed({
        ts: this.now(),
        kind: 'supervisor',
        taskShortId: sid,
        text: `supervisor → ${e.action} for ${sid ?? 'task'}${this.titleOf(e.taskId)}${e.rationale ? ` (${e.rationale})` : ''}`,
      });
      this.markDirty();
    });
  }

  private pushFeed(entry: SddBoardFeedEntry): void {
    this.feed.unshift(entry);
    if (this.feed.length > SddBoardProjector.FEED_CAP) this.feed.length = SddBoardProjector.FEED_CAP;
  }

  /** ` (title…)` suffix for a feed line, or '' when the node/title is missing. */
  private titleOf(taskId: string): string {
    const t = this.o.graph.nodes.get(taskId)?.title;
    if (!t) return '';
    return ` (${t.length > 40 ? `${t.slice(0, 39)}…` : t})`;
  }

  private assigneeOf(taskId: string): string | undefined {
    return this.o.graph.nodes.get(taskId)?.assignee;
  }

  /** Latest snapshot, built on demand (e.g. for a late-joining client). */
  snapshot() {
    return this.build();
  }

  /** Resolve once all in-flight snapshot persistence has settled. */
  async drain(): Promise<void> {
    await this.lastSave;
  }

  /** Stop projecting and release subscriptions. */
  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
  }

  // ── internal ────────────────────────────────────────────────────────────

  /** Subscribe to a run event scoped to this run id; also append to JSONL. */
  private onRun<K extends keyof EventMap>(event: K, handler: (e: EventMap[K]) => void): void {
    const wrapped = (e: EventMap[K]) => {
      if ((e as { runId?: string }).runId !== this.o.runId) return;
      void this.o.store?.appendEvent(this.o.runId, { ts: this.now(), type: event, payload: e });
      handler(e);
    };
    const off = this.o.events.on(event, wrapped as (p: EventMap[K]) => void);
    this.unsubs.push(off);
  }

  private resolveStatus(completed: number, total: number): SddBoardStatus {
    if (!this.finished) return this.status;
    if (this.runDeadlocked) return 'deadlocked';
    if (total > 0 && completed >= total) return 'completed';
    // A user-stopped run is a TERMINAL 'stopped' — distinct from a live 'paused'
    // run (which is still resumable). Surfaces must treat 'stopped' as inactive
    // so the post-run lifecycle controls (clean / rollback / destroy) apply.
    if (this.runStopped) return 'stopped';
    return 'failed';
  }

  private build() {
    const snap = buildBoardSnapshot(
      this.o.graph,
      {
        runId: this.o.runId,
        specId: this.o.specId,
        status: 'running',
        startedAt: this.startedAt,
        wave: this.wave,
        deadlockChains: this.deadlockChains,
        defaultModel: this.o.defaultModel,
        defaultProvider: this.o.defaultProvider,
        fallbackModels: this.o.fallbackModels,
        baseBranch: this.runBaseBranch ?? this.o.baseBranch,
        mergedCommits: this.mergedCommits,
      },
      this.now(),
    );
    snap.status = this.resolveStatus(snap.progress.completed, snap.progress.total);
    snap.feed = this.feed.slice(0, SddBoardProjector.FEED_CAP);
    return snap;
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.timer || this.finished) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.dirty) this.flush();
    }, this.throttleMs);
  }

  private flush(): void {
    this.dirty = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const snap = this.build();
    const sessionId = this.currentSessionId();
    this.o.events.emit('sdd.board.snapshot', {
      ...(sessionId ? { sessionId } : {}),
      runId: this.o.runId,
      snapshot: snap,
    });
    if (this.o.store) {
      // Serialize writes (no two snapshots race on the same file) and swallow
      // persistence errors — a live stream must never crash on a disk hiccup.
      const store = this.o.store;
      this.lastSave = this.lastSave.then(() => store.saveSnapshot(snap)).catch(() => {});
    }
  }

  private currentSessionId(): string | undefined {
    const value =
      typeof this.o.sessionId === 'function'
        ? this.o.sessionId()
        : this.o.sessionId;
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }
}
