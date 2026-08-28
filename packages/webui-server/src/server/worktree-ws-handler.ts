import { join, resolve, sep } from 'node:path';
import type { EventBus } from '@wrongstack/core/kernel';
import type { Logger } from '@wrongstack/core/types';
import { toErrorMessage } from '@wrongstack/core/utils';
import { WorktreeManager } from '@wrongstack/core/worktree';
import { cleanupStaleSddWorktrees } from '@wrongstack/sdd';
import type { WebSocket } from 'ws';
import type { WorktreeHandleView, WorktreeOrphanView, WSServerMessage } from './types.js';
import { sendSerialized } from './ws-utils.js';

const MAX_ACTIVITY = 6;

/** Statuses that mean a worktree is actively owned by a live in-session run. */
const ACTIVE_STATUSES = new Set(['allocating', 'active', 'committing', 'merging']);

/**
 * Only this project's own managed branches are operable from the panel — both a
 * safety scope (never touch `main`/arbitrary refs) AND an argv-injection guard:
 * the strict charset forbids a leading `-`, so a client can't smuggle a value
 * that git would parse as a flag. Mirrors `WorktreeManager`'s `wstack/ap/<slug>`.
 */
const MANAGED_BRANCH_RE = /^wstack\/ap\/[A-Za-z0-9._/-]+$/;

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
 */
export class WorktreeWebSocketHandler {
  private readonly clients = new Set<WebSocket>();
  private readonly handles = new Map<string, WorktreeHandleView>();
  private baseBranch = '';
  /**
   * Change-detection pair for the 2s resync interval: every state mutation
   * bumps `stateVersion`, every broadcast records it in `broadcastVersion`,
   * so the interval only re-sends when something actually changed.
   */
  private stateVersion = 0;
  private broadcastVersion = 0;
  private broadcastInterval: ReturnType<typeof setInterval> | null = null;
  private readonly offs: Array<() => void> = [];
  /**
   * Single-flight guard for orphan scans. Two concurrent `scanAndBroadcast()`
   * calls would race: the first call reads `wt.listManaged()`, then the
   * second call's mutation completes (e.g. `removeOne`), then the first call
   * broadcasts a stale orphan list — the user sees a row persist and clicks
   * Remove a second time, hitting "remove failed (not a managed worktree?)".
   *
   * We coalesce concurrent triggers: while a scan is in flight, additional
   * callers are remembered as "need a re-scan" and exactly one follow-up
   * scan runs after the in-flight one finishes. The re-scan picks up any
   * mutations that landed during the previous scan's `listManaged()` window.
   */
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
    this.clients.add(ws);
    ws.on('close', () => this.clients.delete(ws));
    ws.on('error', () => this.clients.delete(ws));
    this.send(ws, this.stateMessage());
    // Push the current orphan inventory to the freshly-connected client.
    void this.scanAndBroadcast();
  }

  /** Handle worktree-panel control messages (scan / clean / per-row ops). */
  async handleMessage(msg: { type: string; payload?: Record<string, unknown> }): Promise<boolean> {
    if (msg.type === 'worktree.scan') {
      await this.scanAndBroadcast();
      return true;
    }
    if (msg.type === 'worktree.cleanup') {
      await this.cleanupOrphans();
      return true;
    }
    if (msg.type === 'worktree.remove') {
      await this.removeOne(
        msg.payload?.['dir'] as string | undefined,
        msg.payload?.['branch'] as string | undefined,
      );
      return true;
    }
    if (msg.type === 'worktree.merge') {
      await this.mergeBranch(msg.payload?.['branch'] as string | undefined);
      return true;
    }
    if (msg.type === 'worktree.diff') {
      await this.diffOne(
        msg.payload?.['dir'] as string | undefined,
        msg.payload?.['baseBranch'] as string | undefined,
      );
      return true;
    }
    return false;
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.stopBroadcast();
    this.clients.clear();
    this.handles.clear();
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

  /**
   * Coalesced orphan scan entry point. Multiple concurrent callers share one
   * in-flight scan; if a caller arrives during a scan, a single follow-up
   * scan is scheduled to pick up mutations that landed mid-scan. Returns the
   * shared promise so `await this.scanAndBroadcast()` still works for callers
   * that want to chain after the next broadcast.
   */
  private scanAndBroadcast(): Promise<void> {
    if (this.scanInFlight) {
      this.scanRescanNeeded = true;
      return this.scanInFlight;
    }
    this.scanInFlight = this.runScanAndMaybeRescan();
    return this.scanInFlight;
  }

  /**
   * Run the actual scan, then drain a pending re-scan request if one came in
   * during the scan. The re-scan is bounded (one follow-up) — additional
   * requests that arrive during the follow-up coalesce into the next one.
   */
  private async runScanAndMaybeRescan(): Promise<void> {
    try {
      await this.runScanOnce();
      while (this.scanRescanNeeded) {
        this.scanRescanNeeded = false;
        await this.runScanOnce();
      }
    } finally {
      // Clear the in-flight slot. Any caller arriving after this point will
      // start a fresh scan through `scanAndBroadcast`. The flag is already
      // false here because the while-loop drained it; a new caller during
      // the final `runScanOnce` await would have set it via `scanAndBroadcast`,
      // which short-circuited to the in-flight promise rather than mutating
      // the flag (the flag is only set by callers that arrived after the
      // in-flight promise was published).
      this.scanInFlight = null;
    }
  }

  /**
   * Scan the disk for managed worktrees/branches NOT owned by a live in-session
   * run and broadcast them as orphans, with whether it is safe to clean now.
   * No-op (empty inventory) when management deps were not wired.
   */
  private async runScanOnce(): Promise<void> {
    if (!this.management) {
      this.broadcast({ type: 'worktree.orphans', payload: { orphans: [], canClean: false } });
      return;
    }
    try {
      const wt = new WorktreeManager({ projectRoot: this.management.projectRoot });
      const { worktrees, branches } = await wt.listManaged();
      const live = this.liveActiveBranches();
      const orphans: WorktreeOrphanView[] = [];
      const seenBranches = new Set<string>();
      for (const w of worktrees) {
        if (w.branch && live.has(w.branch)) continue; // owned by a live run
        if (w.branch) seenBranches.add(w.branch);
        orphans.push({ kind: 'worktree', dir: w.dir, branch: w.branch });
      }
      // Branch-only orphans (no checkout) — skip those a live run owns or that a
      // listed worktree already covers.
      for (const b of branches) {
        if (live.has(b) || seenBranches.has(b)) continue;
        orphans.push({ kind: 'branch', branch: b });
      }
      // Safe to clean when no live in-session worktree exists. (The cross-process
      // board guard is additionally enforced at cleanup time.)
      const canClean = this.liveActiveBranches().size === 0;
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
    if (this.liveActiveBranches().size > 0) {
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
    if (branch && this.liveActiveBranches().has(branch)) {
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
    let removed = false;
    if (dir) {
      const wt = new WorktreeManager({ projectRoot: this.management.projectRoot });
      ({ removed } = await wt.removeOne(dir, branch));
    }
    // Drop our handle for this branch/dir.
    let removedMatching = 0;
    for (const [id, h] of [...this.handles]) {
      if ((branch && h.branch === branch) || (dir && h.handleId && dir.endsWith(h.handleId))) {
        this.handles.delete(id);
        removedMatching++;
      }
    }
    if (removedMatching > 0) this.stateVersion++;
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
    if (this.liveActiveBranches().has(branch)) {
      this.broadcast({
        type: 'worktree.merge_result',
        payload: { ok: false, branch, reason: 'a run is live on this worktree — stop it first' },
      });
      return;
    }
    const wt = new WorktreeManager({ projectRoot: this.management.projectRoot });
    const res = await wt.mergeBranch(branch);
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
        this.patch(e.handleId, { status: 'failed' });
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
