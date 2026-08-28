import type { EventBus } from '@wrongstack/core/kernel';
import type { TrustBoundary } from '@wrongstack/core/security';
import type { Logger } from '@wrongstack/core/types';
import {
  enqueueKanbanWorkflowCommand,
  kanbanWorkflowId,
  listBoards,
  listKanbanWorkflowStates,
} from '@wrongstack/kanban';
import {
  applySddLifecycle,
  extractVerificationCommand,
  type SddBoardIndexEntry,
  type SddBoardSnapshot,
  SddBoardStore,
  type SddLifecycleOp,
} from '@wrongstack/sdd';
import type { WebSocket } from 'ws';
import { authorizeWebUIAction } from './privileged-actions.js';
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
 * Commands enqueued through the project-scoped Kanban IPC owner and drained by
 * the live run. Only meaningful while the run is active.
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
 * Post-run lifecycle ops applied directly from durable workflow state by this
 * handler (not via the command queue — nothing drains it once the run settles).
 * Each operates on git + persisted state and is gated on "no active run". `destroy` accepts a
 * `revertMerged` flag to also undo merged commits.
 */
const LIFECYCLE_TYPES = new Set<SddLifecycleOp>(['cleanup_worktrees', 'rollback', 'destroy']);

/**
 * Standalone polling cadence for the SDD board snapshot. Each tick probes the
 * cheap store index first (see `hasNewerSnapshot`) and only loads the full
 * snapshot when something actually changed, so 5s keeps the board feeling
 * live without paying a full snapshot read + parse every second.
 */
const POLL_INTERVAL_MS = 5_000;

/** Project paths the handler needs to apply lifecycle ops directly. */
interface SddBoardLifecycleDeps {
  projectRoot: string;
  /** Explicit compatibility hook for file-codec tests and old integrations. */
  controlTransport?: 'kanban' | 'legacy-file' | undefined;
  /** Explicit compatibility hook for legacy snapshot-file readers. */
  stateTransport?: 'kanban' | 'legacy-file' | undefined;
  paths: {
    projectSpecs: string;
    projectTaskGraphs: string;
    projectSddSession: string;
    projectSddBoards: string;
  };
}

interface SddBoardSecurityDeps {
  trustBoundary: TrustBoundary;
  logger?: Logger | undefined;
}

/**
 * SddBoardWebSocketHandler — streams the live SDD multi-agent board to clients
 * and relays control commands back to the CLI-owned run.
 *
 * Two observe modes (one class, shared by both webui servers):
 *  • in-process (CLI-hosted): subscribe the shared EventBus `sdd.board.snapshot`
 *    for instant updates;
 *  • standalone (separate process): poll the project-scoped Kanban workflow
 *    state owned by the daemon.
 *
 * Control is uniform + cross-process: every command is durably enqueued in the
 * Kanban project daemon, which the CLI run drains and applies — so the run stays
 * the single driver and nothing races on shared state.
 */
export class SddBoardWebSocketHandler {
  private readonly store: SddBoardStore;
  private readonly clients = new Set<WSClient>();
  private readonly lifecycle?: SddBoardLifecycleDeps | undefined;
  private readonly security?: SddBoardSecurityDeps | undefined;
  private readonly standalonePollingEnabled: boolean;
  private latest: SddBoardSnapshot | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private pollInFlight = false;
  private unsub: (() => void) | null = null;
  private disposed = false;

  constructor(
    boardsDir: string,
    events?: EventBus,
    lifecycle?: SddBoardLifecycleDeps,
    security?: SddBoardSecurityDeps,
  ) {
    this.store = new SddBoardStore({ baseDir: boardsDir });
    this.lifecycle = lifecycle;
    this.security = security;
    this.standalonePollingEnabled = events === undefined;

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
    if (this.disposed) return;
    const client: WSClient = { ws, id: crypto.randomUUID() };
    this.clients.add(client);
    const remove = () => {
      this.clients.delete(client);
      if (this.clients.size === 0) this.stopPolling();
    };
    ws.on('close', remove);
    ws.on('error', remove);
    this.startPolling();
    // Send the current board immediately (from memory or project state). Best-effort:
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
      const boards = await this.listBoardEntries();
      this.broadcast({ type: 'sdd.board.list', payload: { boards } });
      return;
    }
    const action = msg.type.replace(/^sdd\.board\./, '');

    // Post-run lifecycle ops are applied here from durable workflow state. The
    // live run's command drain is gone once it finishes, so queueing these
    // operations (as the old Clean/Rollback buttons did) would be a no-op.
    if (LIFECYCLE_TYPES.has(action as SddLifecycleOp)) {
      await this.applyLifecycle(action as SddLifecycleOp, msg.payload);
      return;
    }

    if (CONTROL_TYPES.has(action)) {
      const verificationCommands: Array<{ command: string; operation: string }> = [];
      if (action === 'set_task_verification') {
        const command = msg.payload?.verificationCommand;
        if (command !== undefined && (typeof command !== 'string' || command.length > 8_192))
          return;
        if (typeof command === 'string' && command.trim()) {
          verificationCommands.push({ command, operation: 'sdd.set_task_verification' });
        }
      } else if (action === 'split_task') {
        const subtasks = msg.payload?.subtasks;
        if (Array.isArray(subtasks)) {
          for (const subtask of subtasks) {
            if (!subtask || typeof subtask !== 'object') continue;
            const criterion = (subtask as Record<string, unknown>).successCriterion;
            if (criterion === undefined) continue;
            if (typeof criterion !== 'string') return;
            const command = extractVerificationCommand([criterion]);
            if (!command) continue;
            if (command.length > 8_192) return;
            verificationCommands.push({ command, operation: 'sdd.split_task_verification' });
          }
        }
      }
      for (const { command, operation } of verificationCommands) {
        if (!this.security) return;
        const authorization = await authorizeWebUIAction(
          this.security.trustBoundary,
          {
            capability: 'process.spawn',
            subject: { kind: 'command', id: command },
            risk: 'high',
            cwd: this.lifecycle?.projectRoot,
            metadata: { operation },
          },
          this.security.logger,
        );
        if (!authorization.allowed) return;
      }
      const runId =
        (msg.payload?.runId as string | undefined) ??
        this.latest?.runId ??
        (await this.listBoardEntries())[0]?.runId;
      if (runId) {
        if (this.lifecycle && this.lifecycle.controlTransport !== 'legacy-file') {
          await enqueueKanbanWorkflowCommand(
            this.lifecycle.projectRoot,
            kanbanWorkflowId('sdd', runId),
            { type: action, payload: msg.payload },
          );
        } else {
          await this.store.appendControl(runId, {
            ts: Date.now(),
            type: action,
            payload: msg.payload,
          });
        }
      }
    }
  }

  /**
   * Apply a cleanup/rollback/destroy from durable state and broadcast a structured
   * `sdd.board.lifecycle_result`. Refuses (no-op) while a run is still active —
   * the user must stop it first; the UI gates the buttons on `!active` and the
   * Destroy flow auto-stops then waits before sending `destroy`.
   */
  private async applyLifecycle(
    op: SddLifecycleOp,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    if (!this.lifecycle) {
      this.broadcast({
        type: 'sdd.board.lifecycle_result',
        payload: {
          op,
          ok: false,
          reason: 'Lifecycle operations are not available in this session.',
        },
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
      stateTransport: this.lifecycle.stateTransport ?? 'kanban',
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
    this.disposed = true;
    this.stopPolling();
    this.unsub?.();
    this.unsub = null;
    this.clients.clear();
    this.latest = null;
  }

  // ── internal ────────────────────────────────────────────────────────────

  private async pollLatest(): Promise<void> {
    if (this.pollInFlight) return;
    this.pollInFlight = true;
    try {
      // Cheap freshness probe first: an unchanged board costs one small index
      // read instead of a full snapshot load + parse per tick.
      if (!(await this.hasNewerSnapshot())) return;
      const snap = await this.loadLatestSnapshot();
      if (this.disposed) return;
      if (!snap) return;
      if (
        this.latest &&
        this.latest.updatedAt >= snap.updatedAt &&
        this.latest.runId === snap.runId
      ) {
        return; // nothing newer
      }
      this.latest = snap;
      this.broadcast({ type: 'sdd.board.snapshot', payload: snap });
    } catch (err) {
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'sdd_board.poll_failed',
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    } finally {
      this.pollInFlight = false;
    }
  }

  /**
   * Cheap freshness probe used before the full snapshot load. In kanban mode
   * the workflow-state listing IS the snapshot payload (no cheaper probe
   * exists), so fall through to the load — the post-load `updatedAt` guard
   * still dedups the broadcast. In legacy-file mode the store index carries
   * per-run `updatedAt`, letting an unchanged board skip the snapshot file
   * entirely. Probe failures fall through to the load path.
   */
  private async hasNewerSnapshot(): Promise<boolean> {
    if (this.usesKanbanState()) return true;
    try {
      const entry = await this.store.latest();
      if (!entry) return false;
      return !(
        this.latest &&
        this.latest.runId === entry.runId &&
        this.latest.updatedAt >= entry.updatedAt
      );
    } catch {
      return true;
    }
  }

  private startPolling(): void {
    if (!this.standalonePollingEnabled || this.poll !== null || this.clients.size === 0) return;
    this.poll = setInterval(() => void this.pollLatest(), POLL_INTERVAL_MS);
    this.poll.unref?.();
  }

  private stopPolling(): void {
    if (this.poll === null) return;
    clearInterval(this.poll);
    this.poll = null;
  }

  private async sendCurrent(client: WSClient): Promise<void> {
    const snap = this.latest ?? (await this.loadLatestSnapshot());
    if (snap) this.send(client, { type: 'sdd.board.snapshot', payload: snap });
  }

  private async broadcastCurrent(): Promise<void> {
    const snap = this.latest ?? (await this.loadLatestSnapshot());
    if (snap) this.broadcast({ type: 'sdd.board.snapshot', payload: snap });
  }

  private async loadLatestSnapshot(): Promise<SddBoardSnapshot | null> {
    if (this.usesKanbanState()) {
      const states = await listKanbanWorkflowStates(this.lifecycle!.projectRoot, 'sdd:');
      const snapshots = states
        .map((state) => state.value)
        .filter(isSddBoardSnapshot)
        .sort((a, b) => b.updatedAt - a.updatedAt);
      return snapshots[0] ?? null;
    }
    const entry = await this.store.latest();
    return entry ? this.store.load(entry.runId) : null;
  }

  private async listBoardEntries(): Promise<SddBoardIndexEntry[]> {
    if (!this.usesKanbanState()) return this.store.list();
    const states = await listKanbanWorkflowStates(this.lifecycle!.projectRoot, 'sdd:');
    return states.flatMap((state) => {
      if (!isSddBoardSnapshot(state.value)) return [];
      const snapshot = state.value;
      return [
        {
          runId: snapshot.runId,
          ...(snapshot.specId ? { specId: snapshot.specId } : {}),
          title: snapshot.title,
          status: snapshot.status,
          total: snapshot.progress.total,
          completed: snapshot.progress.completed,
          updatedAt: snapshot.updatedAt,
        },
      ];
    });
  }

  private usesKanbanState(): boolean {
    return Boolean(this.lifecycle && this.lifecycle.stateTransport !== 'legacy-file');
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

function isSddBoardSnapshot(value: unknown): value is SddBoardSnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Partial<SddBoardSnapshot>;
  return (
    typeof snapshot.runId === 'string' &&
    typeof snapshot.title === 'string' &&
    typeof snapshot.status === 'string' &&
    typeof snapshot.updatedAt === 'number' &&
    Array.isArray(snapshot.tasks) &&
    Boolean(snapshot.progress && typeof snapshot.progress.total === 'number')
  );
}
