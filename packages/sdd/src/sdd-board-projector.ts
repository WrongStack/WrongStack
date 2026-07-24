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

import type { EventBus, EventMap } from '@wrongstack/core/kernel';
import { DefaultSecretScrubber } from '@wrongstack/core/security';
import type { TaskTracker } from '@wrongstack/core/tasking';
import type { SecretScrubber, TaskGraph } from '@wrongstack/core/types';
import {
  buildBoardSnapshot,
  type SddBoardFeedEntry,
  type SddBoardSnapshot,
  type SddBoardStatus,
  type SddDeadlockChain,
  shortIdMap,
} from './board-types.js';
import type { SddBoardStore } from './sdd-board-store.js';

function summarizeToolInput(input: unknown, scrubber: SecretScrubber): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;

  // Paths are useful task telemetry and have a narrow meaning. Commands,
  // queries, and patterns are arbitrary user-controlled text: even after the
  // credential scrubber runs they can contain short passwords or other values
  // that do not match a known secret shape, so never copy them into durable
  // board state.
  for (const key of ['filePath', 'path'] as const) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      const compact = scrubber.scrub(value).replace(/\s+/g, ' ').trim();
      return compact.length > 240 ? `${compact.slice(0, 239)}…` : compact;
    }
  }
  if (typeof record['command'] === 'string' || typeof record['cmd'] === 'string') {
    return '[command omitted]';
  }
  if (typeof record['query'] === 'string' || typeof record['pattern'] === 'string') {
    return '[query omitted]';
  }
  return undefined;
}

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
  /** Scrubber used before worker telemetry becomes durable or user-visible. */
  secretScrubber?: SecretScrubber | undefined;
}

export class SddBoardProjector {
  private readonly o: SddBoardProjectorOptions;
  private readonly now: () => number;
  private readonly throttleMs: number;
  private readonly shortId: Map<string, string>;
  private readonly scrubber: SecretScrubber;

  private status: SddBoardStatus = 'idle';
  private wave = 0;
  private startedAt: number;
  private deadlockChains: SddDeadlockChain[] = [];
  /** Live activity feed, most recent first (capped). */
  private feed: SddBoardFeedEntry[] = [];
  private static readonly FEED_CAP = 60;
  /** Rich history is retained independently so a busy board cannot erase a task's log. */
  private taskEvents = new Map<string, SddBoardFeedEntry[]>();
  private static readonly TASK_EVENT_CAP = 250;
  private finished = false;
  private runDeadlocked = false;
  private runStopped = false;
  /** Squash commits the run landed on the base branch (for post-run rollback). */
  private mergedCommits: Array<{ taskId: string; sha: string; title: string }> = [];
  /** Base branch reported by the run at start (overrides the constructor option). */
  private runBaseBranch: string | undefined;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly unsubs: Array<() => void> = [];
  /** Latest snapshot waiting behind an in-flight disk write. */
  private pendingSnapshot: SddBoardSnapshot | undefined;
  /** At most one persistence loop runs; intermediate snapshots are coalesced. */
  private saveLoop: Promise<void> | undefined;

  constructor(opts: SddBoardProjectorOptions) {
    this.o = opts;
    this.now = opts.now ?? Date.now;
    this.throttleMs = opts.throttleMs ?? 250;
    this.shortId = shortIdMap(opts.graph);
    this.scrubber = opts.secretScrubber ?? new DefaultSecretScrubber();
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
      this.pushFeed({
        ts: this.now(),
        kind: 'wave',
        text: `Wave ${e.wave + 1} started · ${e.batchSize} task(s) in parallel`,
      });
      this.markDirty();
    });
    this.onRun('sdd.deadlock', (e) => {
      this.deadlockChains = e.chains.map((c) => ({
        blocked: this.shortId.get(c.blocked) ?? c.blocked.slice(0, 6),
        blockedBy: c.blockedBy.map((b) => this.shortId.get(b) ?? b.slice(0, 6)),
      }));
      this.pushFeed({
        ts: this.now(),
        kind: 'deadlock',
        text: `Deadlock — ${e.chains.length} task(s) blocked by failed work`,
      });
      this.markDirty();
    });
    // Task lifecycle → live activity feed (task STATE comes from the tracker,
    // which already triggers a redraw; here we narrate "what just happened").
    this.onRun('sdd.task.started', (e) => {
      const sid = this.shortId.get(e.taskId);
      this.pushFeed({
        ts: this.now(),
        kind: 'started',
        taskId: e.taskId,
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
        taskId: e.taskId,
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
        taskId: e.taskId,
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
        taskId: e.taskId,
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
        taskId: e.taskId,
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
        taskId: e.taskId,
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
        taskId: e.taskId,
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
        taskId: e.taskId,
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
        taskId: e.taskId,
        taskShortId: sid,
        text: `supervisor → ${e.action} for ${sid ?? 'task'}${this.titleOf(e.taskId)}${e.rationale ? ` (${e.rationale})` : ''}`,
      });
      this.markDirty();
    });

    // Task-scoped worker telemetry → a readable audit log in the task drawer.
    // Require both run correlation and graph membership before accepting it.
    this.onTask('subagent.tool_executed', (e, taskId) => {
      const sid = this.shortId.get(taskId);
      const detail = summarizeToolInput(e.input, this.scrubber);
      const agentName = e.agentName ? this.scrubber.scrub(e.agentName) : undefined;
      const action = this.scrubber.scrub(e.name);
      this.pushFeed({
        ts: this.now(),
        kind: 'tool',
        taskId,
        taskShortId: sid,
        agentName,
        action,
        detail,
        durationMs: e.durationMs,
        ok: e.ok,
        text: `${agentName ?? 'worker'} ran ${action}${detail ? ` · ${detail}` : ''}`,
      });
      void this.o.store?.appendEvent(this.o.runId, {
        ts: this.now(),
        type: 'subagent.tool_executed',
        payload: {
          runId: this.o.runId,
          taskId,
          subagentId: e.subagentId,
          agentName,
          name: action,
          durationMs: e.durationMs,
          ok: e.ok,
          detail,
        },
      });
      this.markDirty();
    });
    this.onTask('file.event', (e, taskId) => {
      if (e.scope !== 'task') return;
      const sid = this.shortId.get(taskId);
      const agentName = this.scrubber.scrub(e.agentName);
      const filePath = this.scrubber.scrub(e.filePath);
      this.pushFeed({
        ts: Date.parse(e.timestamp) || this.now(),
        kind: 'file',
        taskId,
        taskShortId: sid,
        agentName,
        action: e.operation,
        filePath,
        durationMs: e.durationMs,
        ok: true,
        text: `${e.operation} ${filePath}`,
      });
      void this.o.store?.appendEvent(this.o.runId, {
        ts: this.now(),
        type: 'file.event',
        payload: {
          runId: this.o.runId,
          taskId,
          agentName,
          operation: e.operation,
          filePath,
          toolName: this.scrubber.scrub(e.toolName),
          durationMs: e.durationMs,
          timestamp: e.timestamp,
        },
      });
      this.markDirty();
    });
  }

  private pushFeed(entry: SddBoardFeedEntry): void {
    this.feed.unshift(entry);
    if (this.feed.length > SddBoardProjector.FEED_CAP)
      this.feed.length = SddBoardProjector.FEED_CAP;
    if (entry.taskId) {
      const taskFeed = this.taskEvents.get(entry.taskId) ?? [];
      taskFeed.unshift(entry);
      if (taskFeed.length > SddBoardProjector.TASK_EVENT_CAP) {
        taskFeed.length = SddBoardProjector.TASK_EVENT_CAP;
      }
      this.taskEvents.set(entry.taskId, taskFeed);
    }
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
    while (this.saveLoop) await this.saveLoop;
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

  /** Subscribe to task-correlated telemetry and ignore events outside this graph. */
  private onTask<K extends keyof EventMap>(
    event: K,
    handler: (e: EventMap[K], taskId: string) => void,
  ): void {
    const wrapped = (e: EventMap[K]) => {
      const correlated = e as { taskId?: string; runId?: string };
      const taskId = correlated.taskId;
      if (!taskId || !this.o.graph.nodes.has(taskId)) return;
      if (correlated.runId !== this.o.runId) return;
      handler(e, taskId);
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
    snap.taskEvents = Object.fromEntries(
      [...this.taskEvents].map(([taskId, entries]) => [taskId, entries.slice()]),
    );
    return snap;
  }

  private markDirty(): void {
    if (this.timer || this.finished) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.throttleMs);
  }

  private flush(): void {
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
      // Keep one write in flight and one latest pending snapshot. If disk is
      // slower than the projection cadence, obsolete intermediate snapshots
      // are replaced instead of building an unbounded Promise/write backlog.
      this.pendingSnapshot = snap;
      this.startSaveLoop(this.o.store);
    }
  }

  private startSaveLoop(store: SddBoardStore): void {
    if (this.saveLoop) return;
    const loop = this.persistPendingSnapshots(store);
    this.saveLoop = loop;
    void loop.finally(() => {
      this.saveLoop = undefined;
    });
  }

  private async persistPendingSnapshots(store: SddBoardStore): Promise<void> {
    while (this.pendingSnapshot) {
      const snapshot = this.pendingSnapshot;
      this.pendingSnapshot = undefined;
      await store.saveSnapshot(snapshot).catch(() => {});
    }
  }

  private currentSessionId(): string | undefined {
    const value = typeof this.o.sessionId === 'function' ? this.o.sessionId() : this.o.sessionId;
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }
}
