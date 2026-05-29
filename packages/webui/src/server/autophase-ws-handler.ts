import type { WebSocket } from 'ws';
import {
  AutoPhasePlanner,
  AutoPhaseRunner,
  PhaseGraphBuilder,
  PhaseOrchestrator,
  PhaseStore,
  type PhaseGraph,
  type PhaseNode,
  type PhaseProgress,
  type PhaseTemplate,
} from '@wrongstack/core';
import type { Agent, Context, Logger } from '@wrongstack/core';

interface WSClient {
  ws: WebSocket;
  id: string;
}

interface AutoPhaseWSMessage {
  type: string;
  payload?: Record<string, unknown>;
}

/**
 * AutoPhaseWebSocketHandler — WebSocket üzerinden AutoPhase kontrolü.
 *
 * Mesaj tipleri:
 *   autophase.start   → { title, phases?, autonomous? }
 *   autophase.pause   → {}
 *   autophase.resume  → {}
 *   autophase.stop    → {}
 *   autophase.status  → {}
 *   autophase.selectPhase → { phaseId }
 *   autophase.taskStatus  → { taskId, status }
 */
export class AutoPhaseWebSocketHandler {
  private runner: AutoPhaseRunner | null = null;
  private graph: PhaseGraph | null = null;
  private store: PhaseStore;
  private clients = new Set<WSClient>();
  private broadcastInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private agent: Agent,
    private context: Context,
    private logger: Logger,
    storeDir: string,
  ) {
    this.store = new PhaseStore({ baseDir: storeDir });
  }

  addClient(ws: WebSocket): void {
    const client: WSClient = { ws, id: crypto.randomUUID() };
    this.clients.add(client);

    ws.on('close', () => this.clients.delete(client));
    ws.on('error', () => this.clients.delete(client));

    // Anlık durum gönder
    this.sendState(client);
  }

  async handleMessage(msg: AutoPhaseWSMessage): Promise<void> {
    switch (msg.type) {
      case 'autophase.start':
        await this.handleStart(msg.payload);
        break;
      case 'autophase.pause':
        this.runner?.pause();
        this.broadcast({ type: 'autophase.paused', payload: {} });
        break;
      case 'autophase.resume':
        this.runner?.resume();
        this.broadcast({ type: 'autophase.resumed', payload: {} });
        break;
      case 'autophase.stop':
        this.runner?.stop();
        this.stopBroadcast();
        this.broadcast({ type: 'autophase.stopped', payload: {} });
        break;
      case 'autophase.status':
        this.broadcastState();
        break;
      case 'autophase.selectPhase': {
        const phaseId = msg.payload?.phaseId as string;
        if (phaseId && this.graph) {
          this.broadcastState(phaseId);
        }
        break;
      }
      case 'autophase.taskStatus': {
        const { taskId, status } = msg.payload as { taskId: string; status: string };
        await this.handleTaskStatusChange(taskId, status);
        break;
      }
      case 'autophase.toggleAutonomous': {
        const autonomous = (msg.payload?.autonomous as boolean) ?? !this.graph?.autonomous;
        if (this.graph) {
          this.graph.autonomous = autonomous;
          await this.store.save(this.graph);
          this.broadcast({ type: 'autophase.state', payload: this.buildState() });
        }
        break;
      }
      case 'autophase.save': {
        if (this.graph) {
          await this.store.save(this.graph);
          this.broadcast({ type: 'autophase.saved', payload: { graphId: this.graph.id } });
        }
        break;
      }
      case 'autophase.list': {
        const graphs = await this.store.list();
        this.broadcast({ type: 'autophase.list', payload: { graphs } });
        break;
      }
      case 'autophase.load': {
        const graphId = msg.payload?.graphId as string | undefined;
        if (graphId) {
          const graph = await this.store.load(graphId);
          if (graph) {
            this.graph = graph;
            this.broadcast({ type: 'autophase.state', payload: this.buildState() });
          } else {
            this.broadcast({ type: 'autophase.error', payload: { message: `Graph not found: ${graphId}` } });
          }
        }
        break;
      }
    }
  }

  private async handleStart(payload?: Record<string, unknown>): Promise<void> {
    const title = (payload?.goal as string) || (payload?.title as string) || 'Untitled Project';
    const autonomous = (payload?.autonomous as boolean) ?? true;

    // Phase plan resolution:
    //   1. explicit phases in the payload win (caller override);
    //   2. otherwise the LLM plans phases+todos for the goal;
    //   3. failing that, fall back to the generic default phases.
    const phases = Array.isArray(payload?.phases)
      ? (payload.phases as PhaseTemplate[])
      : await this.planPhases(title);

    this.logger.info(`[AutoPhase] Starting: ${title}`);

    this.runner = new AutoPhaseRunner({
      title,
      phases,
      executeTask: async (task, phaseId) => {
        this.logger.info(`[AutoPhase] [${phaseId}] Executing: ${task.title}`);
        // Gerçek AI agent çalıştırma
        const result = await this.executeTaskWithAgent(task, phaseId);
        this.logger.info(`[AutoPhase] [${phaseId}] Completed: ${task.title}`);
        return result;
      },
      onPhaseComplete: (phase) => {
        this.logger.info(`[AutoPhase] Phase completed: ${phase.name}`);
        this.broadcastState();
      },
      onPhaseFail: (phase, error) => {
        this.logger.error(`[AutoPhase] Phase failed: ${phase.name} — ${error.message}`);
        this.broadcastState();
      },
      onProgress: (progress) => {
        this.broadcast({ type: 'autophase.progress', payload: progress });
      },
      onComplete: (graph) => {
        this.logger.info(`[AutoPhase] All phases completed: ${graph.title}`);
        this.stopBroadcast();
        this.broadcast({ type: 'autophase.completed', payload: { title: graph.title } });
      },
      onFail: (graph, phase, error) => {
        this.logger.error(`[AutoPhase] Failed: ${phase.name} — ${error.message}`);
        this.stopBroadcast();
        this.broadcast({ type: 'autophase.failed', payload: { phase: phase.name, error: error.message } });
      },
      autonomous,
      maxConcurrentPhases: 1,
      maxConcurrentTasks: 2,
    });

    this.graph = await this.runner.start();
    await this.store.save(this.graph);

    // Periyodik state broadcast başlat
    this.startBroadcast();
    this.broadcastState();
  }

  /** Generic fallback phases when the LLM planner produces nothing usable. */
  private defaultPhases(): PhaseTemplate[] {
    return [
      { name: 'Discovery', description: 'Requirements gathering', priority: 'high', estimateHours: 2, parallelizable: false },
      { name: 'Design', description: 'Architecture and design', priority: 'critical', estimateHours: 4, parallelizable: false },
      { name: 'Implementation', description: 'Core development', priority: 'critical', estimateHours: 12, parallelizable: false },
      { name: 'Testing', description: 'Unit and integration tests', priority: 'high', estimateHours: 6, parallelizable: true },
      { name: 'Deployment', description: 'Deploy to production', priority: 'medium', estimateHours: 2, parallelizable: false },
    ];
  }

  /** Plan phases+todos for the goal via the LLM; fall back to defaults on failure. */
  private async planPhases(goal: string): Promise<PhaseTemplate[]> {
    try {
      const planner = new AutoPhasePlanner({
        goal,
        runOnce: async (prompt) => {
          const result = (await this.agent.run(prompt, { signal: new AbortController().signal })) as {
            status: string;
            finalText?: string;
          };
          return result.status === 'done' ? (result.finalText ?? '') : '';
        },
      });
      const { phases, parseFailed } = await planner.plan();
      if (!parseFailed && phases.length > 0) {
        const todos = phases.reduce((n, p) => n + (p.taskTemplates?.length ?? 0), 0);
        this.logger.info(`[AutoPhase] Planned ${phases.length} phases / ${todos} todos for: ${goal}`);
        return phases;
      }
      this.logger.info(`[AutoPhase] Planner produced no phases; using defaults for: ${goal}`);
    } catch (err) {
      this.logger.error(`[AutoPhase] Planning failed, using defaults: ${err instanceof Error ? err.message : String(err)}`);
    }
    return this.defaultPhases();
  }

  private async executeTaskWithAgent(task: import('@wrongstack/core').TaskNode, phaseId: string): Promise<unknown> {
    // Task'ı agent'a çalıştır
    const prompt = `Execute task: ${task.title}\n\nDescription: ${task.description}\nPhase: ${phaseId}\nPriority: ${task.priority}\nType: ${task.type}`;
    const result = await this.agent.run(prompt, { signal: new AbortController().signal });
    return result;
  }

  private async handleTaskStatusChange(taskId: string, status: string): Promise<void> {
    if (!this.graph) return;

    for (const phase of this.graph.phases.values()) {
      const task = phase.taskGraph.nodes.get(taskId);
      if (task) {
        task.status = status as import('@wrongstack/core').TaskStatus;
        task.updatedAt = Date.now();
        this.broadcastState();
        return;
      }
    }
  }

  private startBroadcast(): void {
    if (this.broadcastInterval) return;
    this.broadcastInterval = setInterval(() => {
      this.broadcastState();
    }, 2000);
  }

  private stopBroadcast(): void {
    if (this.broadcastInterval) {
      clearInterval(this.broadcastInterval);
      this.broadcastInterval = null;
    }
  }

  private broadcastState(activePhaseId?: string): void {
    if (!this.graph) return;

    const state = this.buildState(activePhaseId);
    this.broadcast({ type: 'autophase.state', payload: state });
  }

  private buildState(activePhaseId?: string): Record<string, unknown> {
    if (!this.graph) {
      return { phases: [], tasks: [], overallPercent: 0, autonomous: true, title: '' };
    }

    const phases = Array.from(this.graph.phases.values());
    const currentActiveId = activePhaseId || phases.find((p) => p.status === 'running')?.id || phases[0]?.id || '';
    const activePhase = this.graph.phases.get(currentActiveId);

    const totalTasks = phases.reduce((sum, p) => sum + p.taskGraph.nodes.size, 0);
    const completedTasks = phases.reduce(
      (sum, p) => sum + Array.from(p.taskGraph.nodes.values()).filter((t) => t.status === 'completed').length,
      0,
    );

    const phaseItems = phases.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      status: p.status,
      priority: p.priority,
      estimateHours: p.estimateHours,
      actualDurationMs: p.actualDurationMs,
      startedAt: p.startedAt,
      completedAt: p.completedAt,
      progressPercent: p.taskGraph.nodes.size > 0
        ? Math.round((Array.from(p.taskGraph.nodes.values()).filter((t) => t.status === 'completed').length / p.taskGraph.nodes.size) * 100)
        : 0,
      taskCount: p.taskGraph.nodes.size,
      completedTasks: Array.from(p.taskGraph.nodes.values()).filter((t) => t.status === 'completed').length,
      assignedAgents: p.assignedAgents,
      isActive: p.id === currentActiveId,
    }));

    const taskItems = activePhase
      ? Array.from(activePhase.taskGraph.nodes.values()).map((t) => ({
          id: t.id,
          title: t.title,
          description: t.description,
          status: t.status,
          priority: t.priority,
          type: t.type,
          estimateHours: t.estimateHours,
          actualHours: t.actualHours,
          assignee: t.assignee,
          tags: t.tags || [],
          startedAt: t.startedAt,
          completedAt: t.completedAt,
        }))
      : [];

    const completedPhases = phases.filter((p) => p.status === 'completed').length;

    return {
      title: this.graph.title,
      phases: phaseItems,
      tasks: taskItems,
      activePhaseId: currentActiveId,
      overallPercent: phases.length > 0 ? Math.round((completedPhases / phases.length) * 100) : 0,
      autonomous: this.graph.autonomous,
      totalTasks,
      completedTasks,
    };
  }

  private sendState(client: WSClient): void {
    if (!this.graph) return;
    const state = this.buildState();
    this.send(client, { type: 'autophase.state', payload: state });
  }

  private broadcast(msg: { type: string; payload: unknown }): void {
    const data = JSON.stringify(msg);
    for (const client of this.clients) {
      if (client.ws.readyState === 1) { // OPEN
        client.ws.send(data);
      }
    }
  }

  private send(client: WSClient, msg: { type: string; payload: unknown }): void {
    if (client.ws.readyState === 1) {
      client.ws.send(JSON.stringify(msg));
    }
  }
}
