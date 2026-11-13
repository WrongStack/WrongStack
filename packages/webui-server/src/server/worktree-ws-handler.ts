import { basename, join, resolve, sep } from 'node:path';
import type { EventBus } from '@wrongstack/contracts/kernel';
import type { Logger } from '@wrongstack/contracts/types';
import {
  normalizeWorktreeEvent,
  WORKTREE_CLEANUP_ALL_HANDLE,
  WORKTREE_EVENT_NAMES,
  type WorktreeTimelineEvent,
} from '@wrongstack/contracts/types/worktree-timeline';
import { toErrorMessage } from '@wrongstack/core/utils';
import { cleanupStaleSddWorktrees, sddRunLiveReason } from '@wrongstack/sdd';
import { WorktreeManager } from '@wrongstack/worktree';
import type { WebSocket } from 'ws';
import type { WorktreeHandleView, WorktreeOrphanView, WSServerMessage } from './types.js';
import { sendSerialized } from './ws-utils.js';

const MAX_ACTIVITY = 6;
/** Lifecycle events kept for the timeline (survive release, unlike `handles`). */
const MAX_TIMELINE_EVENTS = 1000;

/** Statuses that mean a worktree is actively owned by a live in-session run. */
const ACTIVE_STATUSES = new Set(['allocating', 'active', 'committing', 'merging']);

/**
 * Only this project's own managed branches are operable from the panel — both a
 * safety scope (never touch `main`/arbitrary refs) AND an argv-injection guard:
 * the strict charset forbids a leading `-`, so a client can't smuggle a value
 * that git would parse as a flag. Mirrors `WorktreeManager`'s `wstack/ap/<slug>`.
 */
const MANAGED_BRANCH_RE = /^wstack\/ap\/[A-Za-z0-9._/-]+$/;

/**
 * Case-folded where the filesystem is case-insensitive (win32, darwin): there
 * `wstack/ap/LV` deletes the loose ref of `wstack/ap/lv` and `.../LIVE-RUN`
 * names the same checkout, so live-run guards must compare folded.
 */
function foldCase(s: string): string {
  return process.platform === 'win32' || process.platform === 'darwin' ? s.toLowerCase() : s;
}

interface WorktreeManagementDeps {
  projectRoot: string;
  /** Board snapshot dir — powers the cross-process liveness guard on cleanup. */
  boardsDir: string;
}

/**
 * WorktreeWebSocketHandler — mirrors GoalWebSocketHandler. Subscribes to
 * the shared EventBus `worktree.*` lifecycle events, keeps a live snapshot of
 * every worktree, and broadcasts:
 *   - `worktree.event` incrementally (drives the flowing activity strip)
 *   - `worktree.state`  on connect + on a 2s timer (drives swim-lanes/DAG)
 *   - `worktree.timeline` on connect + `worktree.timeline_event` per event:
 *     the normalised lifecycle log the timeline view projects. Unlike
 *     `handles` it is not pruned on release, so finished runs stay visible.
 */
export class WorktreeWebSocketHandler {
  private readonly clients = new Set<WebSocket>();
  private readonly clientOffs = new Map<WebSocket, () => void>();
  private readonly handles = new Map<string, WorktreeHandleView>();
  private readonly timeline: WorktreeTimelineEvent[] = [];
  private baseBranch = '';
  private disposed = false;
  /** Every mutation bumps `stateVersion`; `broadcastVersion` suppresses no-op 2s resyncs. */
  private stateVersion = 0;
  private broadcastVersion = 0;
  private broadcastInterval: ReturnType<typeof setInterval> | null = null;
  private readonly offs: Array<() => void> = [];
  /** Coalesces concurrent orphan scans into at most one follow-up re-scan. */
  private scanInFlight: Promise<void> | null = null;
  private scanRescanNeeded = false;

  constructor(
    private readonly events: EventBus,
    private readonly logger: Logger,
    private readonly management?: WorktreeManagementDeps | undefined,
  ) {
    this.subscribe();
  }

  addClient(ws: WebSocket): void {
    if (this.disposed) return;
    this.clients.add(ws);
    const drop = () => {
      this.clients.delete(ws);
      this.clientOffs.delete(ws);
    };
    ws.on('close', drop);
    ws.on('error', drop);
    this.clientOffs.set(ws, () => {
      ws.off?.('close', drop);
      ws.off?.('error', drop);
    });
    this.send(ws, this.stateMessage());
    this.send(ws, { type: 'worktree.timeline', payload: { events: [...this.timeline] } });
    void this.scanAndBroadcast();
  }

  /** Handle worktree-panel control messages (scan / clean / per-row ops). */
  async handleMessage(msg: { type: string; payload?: Record<string, unknown> }): Promise<boolean> {
    const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
    if (msg.type === 'worktree.scan') {
      await this.scanAndBroadcast();
      return true;
    }
    if (msg.type === 'worktree.cleanup') {
      await this.cleanupOrphans();
      return true;
    }
    if (msg.type === 'worktree.remove') {
      await this.removeOne(str(msg.payload?.['dir']), str(msg.payload?.['branch']));
      return true;
    }
    if (msg.type === 'worktree.merge') {
      await this.mergeBranch(str(msg.payload?.['branch']));
      return true;
    }
    if (msg.type === 'worktree.diff') {
      await this.diffOne(str(msg.payload?.['dir']), str(msg.payload?.['baseBranch']));
      return true;
    }
    return false;
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.stopBroadcast();
    this.disposed = true;
    for (const offWs of this.clientOffs.values()) offWs();
    this.clientOffs.clear();
    this.clients.clear();
    this.handles.clear();
    this.timeline.length = 0;
    this.baseBranch = '';
    this.scanRescanNeeded = false;
  }

  // ── orphan management ─────────────────────────────────────────────────────

  /** Absolute managed-worktrees root for this project. */
  private worktreesRoot(): string {
    return resolve(join(this.management!.projectRoot, '.wrongstack', 'worktrees'));
  }

  /** True iff `dir` resolves strictly inside the managed worktrees root. */
  private underRoot(dir: string): boolean {
    const abs = resolve(dir);
    const root = this.worktreesRoot();
    return abs !== root && abs.startsWith(root + sep);
  }

  /** Branches of worktrees a live in-session run currently owns. */
  private liveActiveBranches(): Set<string> {
    const live = new Set<string>();
    for (const h of this.handles.values()) {
      if (ACTIVE_STATUSES.has(h.status) && h.branch) live.add(h.branch);
    }
    return live;
  }

  /** True iff a live in-session run owns `branch` (any spelling git resolves to it). */
  private isLiveBranch(branch: string): boolean {
    const key = foldCase(branch);
    for (const b of this.liveActiveBranches()) if (foldCase(b) === key) return true;
    return false;
  }

  /** True iff `dir` is the checkout of a worktree a live in-session run owns. */
  private isLiveDir(dir: string): boolean {
    const abs = foldCase(resolve(dir));
    for (const h of this.handles.values()) {
      if (ACTIVE_STATUSES.has(h.status) && h.dir && foldCase(resolve(h.dir)) === abs) return true;
    }
    return false;
  }

  private hasActiveHandles(): boolean {
    for (const h of this.handles.values()) {
      if (ACTIVE_STATUSES.has(h.status)) return true;
    }
    return false;
  }

  /**
   * Coalesced orphan scan entry point. Multiple concurrent callers share one
   * in-flight scan; if a caller arrives during a scan, a single follow-up
   * scan is scheduled to pick up mutations that landed mid-scan.
   */
  private scanAndBroadcast(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.scanInFlight) {
      this.scanRescanNeeded = true;
      return this.scanInFlight;
    }
    this.scanInFlight = this.runScanAndMaybeRescan();
    return this.scanInFlight;
  }

  private async runScanAndMaybeRescan(): Promise<void> {
    try {
      await this.runScanOnce();
      while (this.scanRescanNeeded && !this.disposed) {
        this.scanRescanNeeded = false;
        await this.runScanOnce();
      }
    } finally {
      this.scanInFlight = null;
    }
  }

  private async runScanOnce(): Promise<void> {
    if (this.disposed) return;
    if (!this.management) {
      this.broadcast({ type: 'worktree.orphans', payload: { orphans: [], canClean: false } });
      return;
    }
    try {
      const wt = new WorktreeManager({ projectRoot: this.management.projectRoot });
      const { worktrees, branches } = await wt.listManaged();
      if (this.disposed) return;
      const orphans: WorktreeOrphanView[] = [];
      const seenBranches = new Set<string>();
      for (const w of worktrees) {
        if ((w.branch && this.isLiveBranch(w.branch)) || this.isLiveDir(w.dir)) {
          if (w.branch) seenBranches.add(foldCase(w.branch));
          continue;
        }
        if (w.branch) seenBranches.add(foldCase(w.branch));
        orphans.push({ kind: 'worktree', dir: w.dir, branch: w.branch });
      }
      for (const b of branches) {
        if (this.isLiveBranch(b) || seenBranches.has(foldCase(b))) continue;
        orphans.push({ kind: 'branch', branch: b });
      }
      const canClean = !this.hasActiveHandles();
      this.broadcast({
        type: 'worktree.orphans',
        payload: {
          orphans,
          canClean,
          reason: canClean ? undefined : 'a run is live in this session',
        },
      });
    } catch (err) {
      this.logger.debug?.(`worktree orphan scan failed: ${toErrorMessage(err)}`);
      this.broadcast({ type: 'worktree.orphans', payload: { orphans: [], canClean: false } });
    }
  }

  /**
   * Force-remove every orphaned worktree + branch. Refused while a run is live —
   * in this session (active handles) OR another process (the SDD board liveness
   * guard inside cleanupStaleSddWorktrees). Best-effort; reports the outcome.
   */
  private async cleanupOrphans(): Promise<void> {
    if (!this.management) {
      this.broadcast({
        type: 'worktree.cleanup_result',
        payload: { ok: false, removed: 0, reason: 'cleanup is not available in this session' },
      });
      return;
    }
    if (this.hasActiveHandles()) {
      this.broadcast({
        type: 'worktree.cleanup_result',
        payload: { ok: false, removed: 0, reason: 'a run is live in this session — stop it first' },
      });
      return;
    }
    const res = await cleanupStaleSddWorktrees({
      projectRoot: this.management.projectRoot,
      boardsDir: this.management.boardsDir,
      stateTransport: 'kanban',
    });
    if (this.disposed) return;
    if (res.skippedReason) {
      this.broadcast({
        type: 'worktree.cleanup_result',
        payload: { ok: false, removed: 0, reason: res.skippedReason },
      });
      await this.scanAndBroadcast();
      return;
    }
    // Drop any kept-for-review handles we held — their checkouts are gone now.
    let removedHandles = 0;
    for (const [id, h] of [...this.handles]) {
      if (!ACTIVE_STATUSES.has(h.status)) {
        this.handles.delete(id);
        removedHandles++;
      }
    }
    if (removedHandles > 0) this.stateVersion++;
    // The sweep runs on a bus-less manager, so record it for the timeline here.
    this.recordTimeline('worktree.released', {
      handleId: WORKTREE_CLEANUP_ALL_HANDLE,
      ownerId: WORKTREE_CLEANUP_ALL_HANDLE,
      kept: false,
    });
    this.broadcast({
      type: 'worktree.cleanup_result',
      payload: { ok: true, removed: res.removed },
    });
    this.broadcastState();
    await this.scanAndBroadcast();
  }

  /** Remove/discard ONE worktree + branch. Refused while a live run owns it. */
  private async removeOne(dir?: string, branch?: string): Promise<void> {
    if (!this.management || (!dir && !branch)) {
      this.broadcast({
        type: 'worktree.cleanup_result',
        payload: { ok: false, removed: 0, reason: 'nothing to remove' },
      });
      return;
    }
    // Validate the client-supplied targets: a branch must be one of ours (the
    // regex also blocks argv flag-smuggling) and a dir must be inside the
    // managed worktrees root (no path traversal to arbitrary checkouts).
    if (branch && !MANAGED_BRANCH_RE.test(branch)) {
      this.broadcast({
        type: 'worktree.cleanup_result',
        payload: { ok: false, removed: 0, reason: 'not a managed worktree branch' },
      });
      return;
    }
    if (dir && !this.underRoot(dir)) {
      this.broadcast({
        type: 'worktree.cleanup_result',
        payload: { ok: false, removed: 0, reason: 'path is outside the managed worktrees root' },
      });
      return;
    }
    // Guard by dir too: a request naming only the checkout must not bypass it.
    if ((branch && this.isLiveBranch(branch)) || (dir && this.isLiveDir(dir))) {
      this.broadcast({
        type: 'worktree.cleanup_result',
        payload: {
          ok: false,
          removed: 0,
          reason: 'a run is live on this worktree — stop it first',
        },
      });
      return;
    }
    // Only this session's handles are filtered out of the orphan list, so a
    // row can be the live checkout of a run in another process. Apply the
    // same cross-process board guard the bulk cleanup uses.
    const liveReason = await this.otherProcessLiveReason();
    if (this.disposed) return;
    if (liveReason) {
      this.broadcast({
        type: 'worktree.cleanup_result',
        payload: { ok: false, removed: 0, reason: liveReason },
      });
      return;
    }
    if ((branch && this.isLiveBranch(branch)) || (dir && this.isLiveDir(dir))) {
      this.broadcast({
        type: 'worktree.cleanup_result',
        payload: {
          ok: false,
          removed: 0,
          reason: 'a run is live on this worktree — stop it first',
        },
      });
      return;
    }
    const wt = new WorktreeManager({ projectRoot: this.management.projectRoot });
    const { removed } = dir ? await wt.removeOne(dir, branch) : await wt.removeBranch(branch ?? '');
    if (this.disposed) return;
    if (removed) {
      const normDir = dir ? foldCase(resolve(dir)) : '';
      const dirSlug = dir ? foldCase(basename(resolve(dir))) : '';
      const normBranch = branch ? foldCase(branch) : '';
      let removedMatching = 0;
      for (const [id, h] of [...this.handles]) {
        if (ACTIVE_STATUSES.has(h.status)) continue;
        const branchMatch = Boolean(normBranch && h.branch && foldCase(h.branch) === normBranch);
        const dirMatch = Boolean(
          normDir &&
            (h.dir
              ? foldCase(resolve(h.dir)) === normDir
              : h.handleId && foldCase(h.handleId) === dirSlug),
        );
        if (branchMatch || dirMatch) {
          this.handles.delete(id);
          removedMatching++;
        }
      }
      if (removedMatching > 0) this.stateVersion++;
      this.recordTimeline('worktree.released', {
        handleId: dir ? basename(resolve(dir)) : (branch ?? '').replace(/^wstack\/ap\//, ''),
        ...(branch ? { branch } : {}),
        kept: false,
      });
    }
    this.broadcast({
      type: 'worktree.cleanup_result',
      payload: {
        ok: removed,
        removed: removed ? 1 : 0,
        reason: removed ? undefined : 'remove failed (not a managed worktree?)',
      },
    });
    this.broadcastState();
    await this.scanAndBroadcast();
  }

  /** Squash-merge ONE branch into base. Refused while a live run owns it. */
  private async mergeBranch(branch?: string): Promise<void> {
    if (!this.management || !branch) {
      this.broadcast({
        type: 'worktree.merge_result',
        payload: { ok: false, branch: branch ?? '', reason: 'no branch' },
      });
      return;
    }
    if (!MANAGED_BRANCH_RE.test(branch)) {
      this.broadcast({
        type: 'worktree.merge_result',
        payload: { ok: false, branch, reason: 'not a managed worktree branch' },
      });
      return;
    }
    if (this.isLiveBranch(branch)) {
      this.broadcast({
        type: 'worktree.merge_result',
        payload: { ok: false, branch, reason: 'a run is live on this worktree — stop it first' },
      });
      return;
    }
    const liveReason = await this.otherProcessLiveReason();
    if (this.disposed) return;
    if (liveReason) {
      this.broadcast({
        type: 'worktree.merge_result',
        payload: { ok: false, branch, reason: liveReason },
      });
      return;
    }
    if (this.isLiveBranch(branch)) {
      this.broadcast({
        type: 'worktree.merge_result',
        payload: { ok: false, branch, reason: 'a run is live on this worktree — stop it first' },
      });
      return;
    }
    const wt = new WorktreeManager({ projectRoot: this.management.projectRoot });
    const res = await wt.mergeBranch(branch);
    if (this.disposed) return;
    // Handle-free merge emits nothing; the managed branch's slug is its handle id.
    if (res.ok) {
      this.recordTimeline('worktree.merged', {
        handleId: branch.replace(/^wstack\/ap\//, ''),
        branch,
      });
    }
    this.broadcast({
      type: 'worktree.merge_result',
      payload: {
        ok: res.ok,
        branch,
        conflict: res.conflict,
        conflictFiles: res.conflictFiles,
        reason: res.reason,
      },
    });
    await this.scanAndBroadcast();
  }

  /** Cross-process liveness guard shared with `cleanupOrphans` (see sddRunLiveReason). */
  private otherProcessLiveReason(): Promise<string | undefined> {
    return sddRunLiveReason({
      projectRoot: this.management!.projectRoot,
      boardsDir: this.management!.boardsDir,
      stateTransport: 'kanban',
    });
  }

  /** Compact change summary for one worktree checkout. */
  private async diffOne(dir?: string, baseBranch?: string): Promise<void> {
    // Same path guard as removeOne — never run git in an arbitrary directory.
    if (!this.management || !dir || !this.underRoot(dir)) {
      this.broadcast({ type: 'worktree.diff_result', payload: { dir: dir ?? '', summary: null } });
      return;
    }
    // A baseBranch is only ever a managed branch or omitted (→ detected base);
    // reject anything that could smuggle a git flag.
    const base = baseBranch && MANAGED_BRANCH_RE.test(baseBranch) ? baseBranch : undefined;
    const wt = new WorktreeManager({ projectRoot: this.management.projectRoot });
    const summary = await wt.diffSummary(resolve(dir), base);
    this.broadcast({ type: 'worktree.diff_result', payload: { dir, summary } });
  }

  // ── internals ───────────────────────────────────────────────────────────

  private subscribe(): void {
    const on = this.events.on.bind(this.events) as never as (
      ev: string,
      fn: (p: unknown) => void,
    ) => () => void;

    // Timeline log first, so a snapshot sent from a state handler below
    // already contains the event that triggered it.
    for (const name of WORKTREE_EVENT_NAMES) {
      this.offs.push(on(name, (p) => this.recordTimeline(name, p)));
    }

    this.offs.push(
      on('worktree.allocated', (p) => {
        const e = p as {
          handleId: string;
          ownerId: string;
          ownerLabel: string;
          dir?: string;
          branch: string;
          baseBranch: string;
        };
        if (e.baseBranch && e.baseBranch !== this.baseBranch) {
          this.baseBranch = e.baseBranch;
          this.stateVersion++;
        }
        this.upsert(e.handleId, {
          handleId: e.handleId,
          ownerId: e.ownerId,
          ownerLabel: e.ownerLabel,
          dir: e.dir,
          branch: e.branch,
          baseBranch: e.baseBranch,
          status: 'active',
          insertions: 0,
          deletions: 0,
          files: 0,
          allocatedAt: Date.now(),
          lastEventAt: Date.now(),
          recentActivity: [],
        });
        this.activity(e.handleId, 'allocated', `branch ${e.branch}`);
        this.ensureBroadcast();
      }),
      on('worktree.committed', (p) => {
        const e = p as {
          handleId: string;
          insertions: number;
          deletions: number;
          files: number;
          committed: boolean;
        };
        this.patch(e.handleId, {
          status: 'committing',
          insertions: e.insertions,
          deletions: e.deletions,
          files: e.files,
        });
        if (e.committed)
          this.activity(e.handleId, 'committed', `+${e.insertions}/-${e.deletions} (${e.files}f)`);
        this.broadcastState();
      }),
      on('worktree.merging', (p) => {
        const e = p as { handleId: string; baseBranch: string };
        this.patch(e.handleId, { status: 'merging' });
        this.activity(e.handleId, 'merging', `→ ${e.baseBranch}`);
        this.broadcastState();
      }),
      on('worktree.merged', (p) => {
        const e = p as { handleId: string; baseBranch: string };
        this.patch(e.handleId, { status: 'merged' });
        this.activity(e.handleId, 'merged', `→ ${e.baseBranch}`);
        this.broadcastState();
      }),
      on('worktree.conflict', (p) => {
        const e = p as { handleId: string; conflictFiles: string[] };
        this.patch(e.handleId, { status: 'needs-review', conflictFiles: e.conflictFiles });
        this.activity(e.handleId, 'conflict', e.conflictFiles.join(', '));
        this.broadcastState();
      }),
      on('worktree.failed', (p) => {
        const e = p as { handleId: string; error: string };
        this.patch(e.handleId, { status: 'failed', lastError: e.error });
        this.activity(e.handleId, 'failed', e.error);
        this.broadcastState();
      }),
      on('worktree.released', (p) => {
        const e = p as { handleId: string; kept: boolean };
        if (!e.kept) {
          this.handles.delete(e.handleId);
          this.stateVersion++;
        }
        this.activity(e.handleId, 'released', e.kept ? 'kept for review' : 'removed');
        if (this.handles.size === 0) this.stopBroadcast();
        else this.broadcastState();
      }),
    );
  }

  /** Append one lifecycle event to the bounded timeline log and stream it. */
  private recordTimeline(name: string, payload: unknown): void {
    const event = normalizeWorktreeEvent(name, payload, Date.now());
    if (!event) return;
    this.timeline.push(event);
    if (this.timeline.length > MAX_TIMELINE_EVENTS) {
      this.timeline.splice(0, this.timeline.length - MAX_TIMELINE_EVENTS);
    }
    this.broadcast({ type: 'worktree.timeline_event', payload: { event } });
  }

  private upsert(id: string, view: WorktreeHandleView): void {
    this.handles.set(id, view);
    this.stateVersion++;
  }

  private patch(id: string, patch: Partial<WorktreeHandleView>): void {
    const cur = this.handles.get(id);
    if (!cur) return;
    this.handles.set(id, { ...cur, ...patch, lastEventAt: Date.now() });
    this.stateVersion++;
  }

  private activity(id: string, kind: string, text: string): void {
    const cur = this.handles.get(id);
    if (cur) {
      const recentActivity = [...cur.recentActivity, { kind, text, at: Date.now() }].slice(
        -MAX_ACTIVITY,
      );
      this.handles.set(id, { ...cur, recentActivity });
      this.stateVersion++;
    }
    this.broadcast({
      type: 'worktree.event',
      payload: { kind, handleId: id, text, at: Date.now() },
    });
  }

  private stateMessage(): WSServerMessage {
    return {
      type: 'worktree.state',
      payload: { worktrees: [...this.handles.values()], baseBranch: this.baseBranch },
    };
  }

  private broadcastState(): void {
    this.broadcast(this.stateMessage());
    this.broadcastVersion = this.stateVersion;
  }

  private ensureBroadcast(): void {
    this.broadcastState();
    if (this.broadcastInterval) return;
    this.broadcastInterval = setInterval(() => {
      // Resync safety net: every real mutation broadcasts immediately via
      // `broadcastState`, so the interval only re-sends when a state change
      // somehow missed its broadcast.
      if (this.broadcastVersion !== this.stateVersion) this.broadcastState();
    }, 2000);
    this.broadcastInterval.unref?.();
  }

  private stopBroadcast(): void {
    this.broadcastState();
    if (this.broadcastInterval) {
      clearInterval(this.broadcastInterval);
      this.broadcastInterval = null;
    }
  }

  private broadcast(msg: WSServerMessage): void {
    if (this.disposed) return;
    const data = JSON.stringify(msg);
    for (const ws of this.clients) {
      try {
        sendSerialized(ws, data);
      } catch (err) {
        this.logger.debug?.(`worktree broadcast failed: ${toErrorMessage(err)}`);
      }
    }
  }

  private send(ws: WebSocket, msg: WSServerMessage): void {
    try {
      sendSerialized(ws, JSON.stringify(msg));
    } catch {
      /* client gone */
    }
  }
}
