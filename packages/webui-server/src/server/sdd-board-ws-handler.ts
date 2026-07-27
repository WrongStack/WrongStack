import type { EventBus } from '@wrongstack/core/kernel';
import { listBoards } from '@wrongstack/kanban';
import {
  applySddLifecycle,
  type SddBoardSnapshot,
  SddBoardStore,
  type SddLifecycleOp,
} from '@wrongstack/sdd';
import type { WebSocket } from 'ws';
import { sendSerialized } from './ws-utils.js';

interface WSClient {
  ws: WebSocket;
  id: string;
}

interface SddBoardWSMessage {
  type: string;
  payload?: Record<string, unknown>;
}

/**
 * Commands appended to `<runId>.control.jsonl` and drained by the live run
 * (start-sdd-run's in-process timer). Only meaningful while the run is active —
 * the drain timer is gone once it finishes.
 */
const CONTROL_TYPES = new Set([
  'pause',
  'resume',
  'stop',
  'retry',
  'retry_all_failed',
  'reassign',
  // Per-task model / fallback / verification assignment + stop/delete (drained by start-sdd-run).
  'set_task_model',
  'set_task_fallbacks',
  'set_task_verification',
  'cancel_task',
  'delete_task',
  'split_task',
]);

/**
 * Post-run lifecycle ops applied DIRECTLY from disk by this handler (not via the
 * control file — nothing drains it once the run settles). Each operates on git +
 * on-disk state and is gated on "no active run". `destroy` accepts a
 * `revertMerged` flag to also undo merged commits.
 */
const LIFECYCLE_TYPES = new Set<SddLifecycleOp>(['cleanup_worktrees', 'rollback', 'destroy']);

/** Project paths the handler needs to apply lifecycle ops directly. */
export interface SddBoardLifecycleDeps {
  projectRoot: string;
  paths: {
    projectSpecs: string;
    projectTaskGraphs: string;
    projectSddSession: string;
    projectSddBoards: string;
  };
}

/**
 * SddBoardWebSocketHandler — streams the live SDD multi-agent board to clients
 * and relays control commands back to the CLI-owned run.
 *
 * Two observe modes (one class, shared by both webui servers):
 *  • in-process (CLI-hosted): subscribe the shared EventBus `sdd.board.snapshot`
 *    for instant updates;
 *  • standalone (separate process): poll the on-disk snapshot store (the CLI
 *    run persists JSON every change).
 *
 * Control is uniform + cross-process: every command is appended to the run's
 * `<runId>.control.jsonl`, which the CLI run drains and applies — so the run
 * stays the single driver and nothing races on shared state.
 */
export class SddBoardWebSocketHandler {
  private readonly store: SddBoardStore;
  private readonly clients = new Set<WSClient>();
  private readonly lifecycle?: SddBoardLifecycleDeps | undefined;
  private readonly diskPollingEnabled: boolean;
  private latest: SddBoardSnapshot | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private pollInFlight = false;
  private unsub: (() => void) | null = null;

  constructor(boardsDir: string, events?: EventBus, lifecycle?: SddBoardLifecycleDeps) {
    this.store = new SddBoardStore({ baseDir: boardsDir });
    this.lifecycle = lifecycle;
    this.diskPollingEnabled = events === undefined;

    if (events) {
      // Instant updates in the CLI-hosted server (shared bus).
      const handler = (e: { runId: string; snapshot: SddBoardSnapshot }) => {
        this.latest = e.snapshot;
        this.broadcast({ type: 'sdd.board.snapshot', payload: e.snapshot });
      };
      this.unsub = events.on('sdd.board.snapshot', handler as (p: unknown) => void);
    }
  }

  addClient(ws: WebSocket): void {
    const client: WSClient = { ws, id: crypto.randomUUID() };
    this.clients.add(client);
    const remove = () => {
      this.clients.delete(client);
      if (this.clients.size === 0) this.stopPolling();
    };
    ws.on('close', remove);
    ws.on('error', remove);
    this.startPolling();
    // Send the current board immediately (from memory or disk). Best-effort:
    // a corrupt/locked snapshot must not become an unhandled rejection.
    void this.sendCurrent(client).catch((err) => {
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'sdd_board.initial_send_failed',
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    });
  }

  async handleMessage(msg: SddBoardWSMessage): Promise<void> {
    if (msg.type === 'sdd.board.get') {
      await this.broadcastCurrent();
      return;
    }
    if (msg.type === 'sdd.board.list') {
      const boards = await this.store.list();
      this.broadcast({ type: 'sdd.board.list', payload: { boards } });
      return;
    }
    const action = msg.type.replace(/^sdd\.board\./, '');

    // Post-run lifecycle ops are applied here, directly from disk — the run's
    // control-file drain timer is gone once it finishes, so routing these
    // through control.jsonl (as the old Clean/Rollback buttons did) was a no-op.
    if (LIFECYCLE_TYPES.has(action as SddLifecycleOp)) {
      await this.applyLifecycle(action as SddLifecycleOp, msg.payload);
      return;
    }

    if (CONTROL_TYPES.has(action)) {
      const runId =
        (msg.payload?.runId as string | undefined) ??
        this.latest?.runId ??
        (await this.store.list())[0]?.runId;
      if (runId) {
        await this.store.appendControl(runId, {
          ts: Date.now(),
          type: action,
          payload: msg.payload,
        });
      }
    }
  }

  /**
   * Apply a cleanup/rollback/destroy from disk and broadcast a structured
   * `sdd.board.lifecycle_result`. Refuses (no-op) while a run is still active —
   * the user must stop it first; the UI gates the buttons on `!active` and the
   * Destroy flow auto-stops then waits before sending `destroy`.
   */
  private async applyLifecycle(op: SddLifecycleOp, payload?: Record<string, unknown>): Promise<void> {
    if (!this.lifecycle) {
      this.broadcast({
        type: 'sdd.board.lifecycle_result',
        payload: { op, ok: false, reason: 'Lifecycle operations are not available in this session.' },
      });
      return;
    }
    // Refuse while live — these force-remove worktrees / rewrite the base branch.
    if (this.latest && (this.latest.status === 'running' || this.latest.status === 'paused')) {
      this.broadcast({
        type: 'sdd.board.lifecycle_result',
        payload: { op, ok: false, reason: 'Stop the run first, then retry.' },
      });
      return;
    }

    const runId = (payload?.runId as string | undefined) ?? this.latest?.runId;
    const result = await applySddLifecycle(op, {
      projectRoot: this.lifecycle.projectRoot,
      paths: this.lifecycle.paths,
      runId,
      revertMerged: payload?.revertMerged === true,
    });

    this.broadcast({ type: 'sdd.board.lifecycle_result', payload: result });

    // A destroy wipes the board; clear the in-memory snapshot and push an empty
    // board so every client returns to the "No active SDD run" state.
    if (op === 'destroy' && result.ok) {
      this.latest = null;
      this.broadcast({ type: 'sdd.board.snapshot', payload: null });
      // Refresh the Kanban list so mirror boards removed by destroySddProject
      // disappear from the UI without a manual reload.
      if (this.lifecycle) {
        try {
          const boards = await listBoards(this.lifecycle.projectRoot);
          this.broadcast({
            type: 'kanban.list',
            payload: { success: true, data: boards },
          });
        } catch {
          // best-effort
        }
      }
    }
  }

  dispose(): void {
    this.stopPolling();
    this.unsub?.();
    this.unsub = null;
  }

  // ── internal ────────────────────────────────────────────────────────────

  private async pollLatest(): Promise<void> {
    if (this.pollInFlight) return;
    this.pollInFlight = true;
    try {
      const entry = await this.store.latest();
      if (!entry) return;
      if (
        this.latest &&
        this.latest.updatedAt >= entry.updatedAt &&
        this.latest.runId === entry.runId
      ) {
        return; // nothing newer
      }
      const snap = await this.store.load(entry.runId);
      if (snap) {
        this.latest = snap;
        this.broadcast({ type: 'sdd.board.snapshot', payload: snap });
      }
    } finally {
      this.pollInFlight = false;
    }
  }

  private startPolling(): void {
    if (!this.diskPollingEnabled || this.poll !== null || this.clients.size === 0) return;
    this.poll = setInterval(() => void this.pollLatest(), 1000);
    this.poll.unref?.();
  }

  private stopPolling(): void {
    if (this.poll === null) return;
    clearInterval(this.poll);
    this.poll = null;
  }

  private async sendCurrent(client: WSClient): Promise<void> {
    const snap = this.latest ?? (await this.loadLatestFromDisk());
    if (snap) this.send(client, { type: 'sdd.board.snapshot', payload: snap });
  }

  private async broadcastCurrent(): Promise<void> {
    const snap = this.latest ?? (await this.loadLatestFromDisk());
    if (snap) this.broadcast({ type: 'sdd.board.snapshot', payload: snap });
  }

  private async loadLatestFromDisk(): Promise<SddBoardSnapshot | null> {
    const entry = await this.store.latest();
    return entry ? this.store.load(entry.runId) : null;
  }

  private broadcast(msg: { type: string; payload: unknown }): void {
    const data = JSON.stringify(msg);
    for (const client of this.clients) {
      sendSerialized(client.ws, data);
    }
  }

  private send(client: WSClient, msg: { type: string; payload: unknown }): void {
    sendSerialized(client.ws, JSON.stringify(msg));
  }
}
