import type { WebSocket } from 'ws';
import { computeTaskProgress } from '@wrongstack/core/tasking';
import type { Specification, TaskGraph, TaskNode } from '@wrongstack/core/types';
import { SpecStore, TaskGraphStore } from '@wrongstack/sdd';
import { sendSerialized } from './ws-utils.js';

/**
 * Runtime guard for the `TaskStatus` union in `@wrongstack/core/types`. Kept as
 * a literal set rather than derived, so widening the union is a deliberate
 * two-line change here and cannot silently admit a new status over the wire.
 */
const VALID_TASK_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'in_progress',
  'blocked',
  'failed',
  'review',
  'completed',
]);

interface WSClient {
  ws: WebSocket;
  id: string;
}

interface SpecsWSMessage {
  type: string;
  payload?: Record<string, unknown>;
}

/** A task as rendered on the FORGE-style dependency board. */
interface BoardTask {
  id: string;
  shortId: string;
  title: string;
  description: string;
  priority: TaskNode['priority'];
  type: TaskNode['type'];
  status: TaskNode['status'];
  /** Derived label for the legend: 'queued' = pending with all blockers done. */
  displayStatus: TaskNode['status'] | 'queued';
  deps: string[];
}

/**
 * SpecsWebSocketHandler — read-only-ish browser of persisted SDD specs and their
 * task graphs, rendered as a FORGE-style dependency board (topological phase
 * columns + dependency refs). Shared by both webui servers via specs-routes.
 *
 * Message types:
 *   specs.list                       → all specs + progress
 *   specs.get { specId }             → one spec's dependency board
 *   specs.taskStatus { graphId, taskId, status } → update + rebroadcast
 */
export class SpecsWebSocketHandler {
  private specStore: SpecStore;
  private graphStore: TaskGraphStore;
  private clients = new Set<WSClient>();

  constructor(specsDir: string, taskGraphsDir: string) {
    this.specStore = new SpecStore({ baseDir: specsDir });
    this.graphStore = new TaskGraphStore({ baseDir: taskGraphsDir });
  }

  addClient(ws: WebSocket): void {
    const client: WSClient = { ws, id: crypto.randomUUID() };
    this.clients.add(client);
    ws.on('close', () => this.clients.delete(client));
    ws.on('error', () => this.clients.delete(client));
    // Best-effort: `sendList` reads and parses the on-disk spec + graph
    // stores, so one truncated/corrupt file turned the next browser refresh
    // into an unhandled rejection — and under Node 22 that kills the server.
    // No message is needed to trigger it; merely CONNECTING is enough.
    // Same shape as sdd-board-ws-handler.ts:140, which already guards.
    void this.sendList(client).catch((err: unknown) => {
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'specs.initial_send_failed',
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    });
  }

  dispose(): void {
    this.clients.clear();
  }

  async handleMessage(msg: SpecsWSMessage): Promise<void> {
    switch (msg.type) {
      case 'specs.list':
        await this.broadcastList();
        break;
      case 'specs.get': {
        const specId = msg.payload?.specId as string | undefined;
        if (specId) await this.broadcastDetail(specId);
        break;
      }
      case 'specs.taskStatus': {
        const { graphId, taskId, status } = msg.payload as {
          graphId: string;
          taskId: string;
          status: TaskNode['status'];
        };
        // The cast above is a compile-time assertion only — this payload comes
        // off the wire. Without the check a caller could flip a task straight to
        // `completed` (skipping a gating run) or write an entirely
        // out-of-union value into persisted state.
        if (!VALID_TASK_STATUSES.has(status as string)) {
          throw new Error(`Invalid task status: ${JSON.stringify(status)}`);
        }
        if (typeof graphId !== 'string' || typeof taskId !== 'string') {
          throw new Error('specs.taskStatus requires string graphId and taskId');
        }
        await this.updateTaskStatus(graphId, taskId, status);
        break;
      }
    }
  }

  // ── List ──────────────────────────────────────────────────────────────────

  private async buildList(): Promise<unknown[]> {
    const [specs, graphs] = await Promise.all([this.specStore.list(), this.graphStore.list()]);
    return specs.map((s, i) => {
      const graph = graphs.find((g) => g.specId === s.id);
      return {
        id: s.id,
        // FORGE-style display id (spec-001…). The real UUID stays in `id`.
        displayId: `spec-${String(i + 1).padStart(3, '0')}`,
        title: s.title,
        status: s.status,
        graphId: graph?.id,
        total: graph?.nodeCount ?? 0,
        completed: graph?.completedCount ?? 0,
      };
    });
  }

  private async broadcastList(): Promise<void> {
    this.broadcast({ type: 'specs.list', payload: { specs: await this.buildList() } });
  }

  private async sendList(client: WSClient): Promise<void> {
    this.send(client, { type: 'specs.list', payload: { specs: await this.buildList() } });
  }

  // ── Detail (dependency board) ───────────────────────────────────────────────

  private async broadcastDetail(specId: string): Promise<void> {
    const spec = await this.specStore.load(specId);
    const graph = await this.findGraphForSpec(specId);
    if (!spec || !graph) {
      this.broadcast({ type: 'specs.detail', payload: { specId, columns: [], notFound: true } });
      return;
    }
    this.broadcast({ type: 'specs.detail', payload: this.buildDetail(spec, graph) });
  }

  private async findGraphForSpec(specId: string): Promise<TaskGraph | null> {
    const entry = (await this.graphStore.list()).find((g) => g.specId === specId);
    if (!entry) return null;
    return this.graphStore.load(entry.id);
  }

  private buildDetail(spec: Specification, graph: TaskGraph): Record<string, unknown> {
    const nodes = Array.from(graph.nodes.values()).sort((a, b) => a.createdAt - b.createdAt);
    // Stable short ids (t01, t02, …) in creation order, FORGE-style.
    const shortId = new Map<string, string>();
    nodes.forEach((n, i) => {
      shortId.set(n.id, `t${String(i + 1).padStart(2, '0')}`);
    });

    // Blockers per node (depends_on edges pointing at the node).
    const blockers = new Map<string, string[]>();
    for (const n of nodes) blockers.set(n.id, []);
    for (const e of graph.edges) {
      if (e.type === 'depends_on') blockers.get(e.to)?.push(e.from);
    }

    const statusOf = (id: string) => graph.nodes.get(id)?.status;
    const depthCache = new Map<string, number>();
    const depthOf = (id: string, seen = new Set<string>()): number => {
      const cached = depthCache.get(id);
      if (cached !== undefined) return cached;
      if (seen.has(id)) return 0; // cycle guard
      seen.add(id);
      const deps = blockers.get(id) ?? [];
      const d = deps.length === 0 ? 0 : 1 + Math.max(...deps.map((b) => depthOf(b, seen)));
      depthCache.set(id, d);
      return d;
    };

    const toBoardTask = (n: TaskNode): BoardTask => {
      const deps = blockers.get(n.id) ?? [];
      const allDepsDone = deps.every((b) => statusOf(b) === 'completed');
      const displayStatus =
        n.status === 'pending' && deps.length > 0 && allDepsDone ? 'queued' : n.status;
      return {
        id: n.id,
        shortId: shortId.get(n.id) ?? n.id.slice(0, 6),
        title: n.title,
        description: n.description,
        priority: n.priority,
        type: n.type,
        status: n.status,
        displayStatus,
        deps: deps.map((b) => shortId.get(b) ?? b.slice(0, 6)),
      };
    };

    // Group into topological columns: depth 0 → "Start", depth k → "Phase k".
    const byDepth = new Map<number, BoardTask[]>();
    for (const n of nodes) {
      const d = depthOf(n.id);
      if (!byDepth.has(d)) byDepth.set(d, []);
      byDepth.get(d)?.push(toBoardTask(n));
    }
    const columns = [...byDepth.keys()]
      .sort((a, b) => a - b)
      .map((d) => ({ label: d === 0 ? 'Start' : `Phase ${d}`, tasks: byDepth.get(d) ?? [] }));

    const progress = computeTaskProgress(graph);
    return {
      specId: spec.id,
      graphId: graph.id,
      title: spec.title,
      overview: spec.overview,
      status: spec.status,
      total: progress.total,
      completed: progress.completed,
      running: progress.inProgress,
      pending: progress.pending,
      columns,
    };
  }

  private async updateTaskStatus(
    graphId: string,
    taskId: string,
    status: TaskNode['status'],
  ): Promise<void> {
    const graph = await this.graphStore.load(graphId);
    const node = graph?.nodes.get(taskId);
    if (!graph || !node) return;
    node.status = status;
    node.updatedAt = Date.now();
    graph.updatedAt = Date.now();
    await this.graphStore.save(graph);
    this.broadcastDetail(graph.specId).catch(() => {});
    await this.broadcastList();
  }

  // ── Transport ───────────────────────────────────────────────────────────────

  private broadcast(msg: { type: string; payload: unknown }): void {
    const data = JSON.stringify(msg);
    for (const client of this.clients) {
      sendSerialized(client.ws, data);
    }
  }

  private send(client: WSClient, msg: { type: string; payload: unknown }): void {
    if (!this.clients.has(client)) return;
    sendSerialized(client.ws, JSON.stringify(msg));
  }
}
