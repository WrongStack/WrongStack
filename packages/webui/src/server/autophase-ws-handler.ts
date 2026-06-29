import { spawnSync } from 'node:child_process';
import type { WebSocket } from 'ws';
import { toErrorMessage } from '@wrongstack/core/utils';
import {
  assignNickname,
  AutoPhasePlanner,
  PhaseGraphBuilder,
  PhaseOrchestrator,
  PhaseStore,
  WorktreeManager,
  type PhaseGraph,
  type PhaseTemplate,
} from '@wrongstack/core';
import type { Agent, Context, EventBus, Logger } from '@wrongstack/core';

/**
 * Derive a short, single-line heading from a (possibly multi-paragraph) goal
 * prompt. Takes the first non-empty line, trims to its first sentence, and caps
 * the length so AutoPhase headers stay readable. The full prompt is preserved
 * separately as the graph description.
 */
function deriveTitle(goal: string): string {
  const firstLine = goal
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  if (!firstLine) return 'AutoPhase';
  const sentence = firstLine.split(/(?<=[.!?])\s/)[0] ?? firstLine;
  const trimmed = sentence.length <= 64 ? sentence : `${sentence.slice(0, 63).trimEnd()}…`;
  return trimmed || 'AutoPhase';
}

function isGitRepo(cwd: string): boolean {
  try {
    const r = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd, encoding: 'utf8', windowsHide: true });
    return r.status === 0 && r.stdout.trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * List the commits on `branch` since `baseSha` (oldest → newest, the order they
 * landed). Used by `autophase.revert` to feed WorktreeManager.revertCommits,
 * which reverses them. Returns [] on any git error.
 */
function commitsSince(cwd: string, baseSha: string, branch: string): string[] {
  try {
    const r = spawnSync('git', ['log', '--reverse', '--format=%H', `${baseSha}..${branch}`], {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
    });
    if (r.status !== 0) return [];
    return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

interface WSClient {
  ws: WebSocket;
  id: string;
}

interface AutoPhaseWSMessage {
  type: string;
  payload?: Record<string, unknown>;
}

/**
 * AutoPhaseWebSocketHandler — WebSocket-based AutoPhase control.
 *
 * Message types:
 *   autophase.start   → { title, phases?, autonomous? }
 *   autophase.pause   → {}
 *   autophase.resume  → {}
 *   autophase.stop    → {}
 *   autophase.status  → {}
 *   autophase.selectPhase → { phaseId }
 *   autophase.taskStatus  → { taskId, status }
 */
export class AutoPhaseWebSocketHandler {
  private orchestrator: PhaseOrchestrator | null = null;
  private graph: PhaseGraph | null = null;
  private store: PhaseStore;
  private clients = new Set<WSClient>();
  private broadcastInterval: ReturnType<typeof setInterval> | null = null;
  /** Aborts in-flight task agents AND the planning turn when the run is stopped. */
  private abort: AbortController | null = null;
  /** Set the instant a stop/clear/revert is requested, so a planning turn that
   *  resolves afterwards never launches the orchestrator (the abort alone can't
   *  cover the window between the LLM call resolving and the orchestrator start). */
  private stopping = false;
  /** Optional per-phase git-worktree isolation (lazily created at start). */
  private worktrees: WorktreeManager | null = null;
  /** Base branch + tip SHA captured at run start so a revert can git-revert the
   *  run's squash commits (history-preserving) instead of a destructive reset. */
  private runBase: { branch: string; sha: string } | null = null;
  /** Per-run worker identities so the board can show "who is on what". */
  private usedNicknames = new Set<string>();

  constructor(
    private agent: Agent,
    private context: Context,
    private logger: Logger,
    storeDir: string,
    private events?: EventBus | undefined,
    private projectRoot?: string | undefined,
  ) {
    this.store = new PhaseStore({ baseDir: storeDir });
  }

  addClient(ws: WebSocket): void {
    const client: WSClient = { ws, id: crypto.randomUUID() };
    this.clients.add(client);

    ws.on('close', () => this.clients.delete(client));
    ws.on('error', () => this.clients.delete(client));

    // Send current state
    this.sendState(client);
  }

  async handleMessage(msg: AutoPhaseWSMessage): Promise<void> {
    switch (msg.type) {
      case 'autophase.start':
        await this.handleStart(msg.payload);
        break;
      case 'autophase.pause':
        this.orchestrator?.pause();
        this.broadcast({ type: 'autophase.paused', payload: {} });
        break;
      case 'autophase.resume':
        this.orchestrator?.resume();
        this.broadcast({ type: 'autophase.resumed', payload: {} });
        break;
      case 'autophase.stop':
        await this.handleStop();
        break;
      case 'autophase.clear':
        await this.handleClear();
        break;
      case 'autophase.revert':
        await this.handleRevert();
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
      case 'autophase.moveTask': {
        const { taskId, toPhaseId } = msg.payload as { taskId: string; toPhaseId: string };
        if (this.orchestrator?.moveTask(taskId, toPhaseId)) this.afterBoardMutation();
        break;
      }
      case 'autophase.assignTask': {
        const { taskId, agentId, agentName } = msg.payload as {
          taskId: string;
          agentId?: string;
          agentName?: string;
        };
        if (this.orchestrator?.setTaskAssignee(taskId, agentId, agentName)) this.afterBoardMutation();
        break;
      }
      case 'autophase.addTask': {
        const { phaseId, title, description, type, priority } = msg.payload as {
          phaseId: string;
          title: string;
          description?: string;
          type?: import('@wrongstack/core').TaskNode['type'];
          priority?: import('@wrongstack/core').TaskNode['priority'];
        };
        if (title?.trim() && this.orchestrator?.addTask(phaseId, { title: title.trim(), description, type, priority })) {
          this.afterBoardMutation();
        }
        break;
      }
      case 'autophase.retryTask':
      case 'autophase.runTask': {
        const { taskId } = msg.payload as { taskId: string };
        if (this.orchestrator?.requeueTask(taskId)) this.afterBoardMutation();
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
    // The caller sends the operator's full prompt as the goal. We keep it intact
    // as the graph `description` and derive a short, human-readable `title` for
    // headers / the board switcher — pasting the whole prompt as the title made
    // the AutoPhase header unreadable.
    const goal = (payload?.goal as string) || (payload?.title as string) || 'Untitled Project';
    const title = deriveTitle(goal);
    const autonomous = (payload?.autonomous as boolean) ?? true;

    // Fresh abort for THIS run, created BEFORE planning so a stop pressed during
    // the (long) planning turn actually cancels it. Previously the controller was
    // created only after planning, so a stop while "starting" was a no-op and the
    // run launched anyway.
    this.abort = new AbortController();
    this.stopping = false;

    // Phase plan resolution:
    //   1. explicit phases in the payload win (caller override);
    //   2. otherwise the LLM plans phases+todos for the goal;
    //   3. failing that, fall back to the generic default phases.
    const phases = Array.isArray(payload?.phases)
      ? (payload.phases as PhaseTemplate[])
      : await this.planPhases(goal, this.abort.signal);

    // Stop requested during planning → never launch the orchestrator. The abort
    // may not have interrupted the in-flight LLM call promptly, so the `stopping`
    // flag is the authoritative guard for the resolve-after-stop window.
    if (this.stopping || this.abort.signal.aborted) {
      this.broadcast({ type: 'autophase.stopped', payload: { title } });
      return;
    }

    this.logger.info(`[AutoPhase] Starting: ${title}`);

    // Build the graph up-front so we have a reference for live broadcasts and
    // persistence *before* the (long-running) build begins.
    const graph = await new PhaseGraphBuilder({ title, description: goal, phases, autonomous }).build();
    this.graph = graph;
    await this.store.save(graph);

    // Per-phase git-worktree isolation, when enabled and inside a git repo.
    // The shared agent/context means we can't run phases in parallel here
    // (we swap a single context.cwd per task), so phases stay sequential —
    // but each phase still commits + squash-merges back through its own
    // worktree, and the lifecycle events drive the live swim-lane/DAG view.
    // Per-run worktree-isolation override from the UI wins; omitted → env default
    // (disable with WRONGSTACK_AUTOPHASE_WORKTREES=0). false → run on the current branch.
    const useWorktrees =
      (payload?.worktrees as boolean | undefined) ??
      process.env['WRONGSTACK_AUTOPHASE_WORKTREES'] !== '0';
    if (
      !this.worktrees &&
      this.events &&
      this.projectRoot &&
      useWorktrees &&
      isGitRepo(this.projectRoot)
    ) {
      this.worktrees = new WorktreeManager({
        projectRoot: this.projectRoot,
        events: this.events,
        sessionId: () => this.context.session?.id,
      });
    }
    // Capture the pre-run base tip so `autophase.revert` can git-revert exactly
    // the commits this run lands on the base branch.
    if (this.worktrees) {
      this.runBase = await this.worktrees.currentBase();
    }

    // NOTE: this interactive-board orchestrator deliberately omits the CLI host's
    // `verifyPhase`/`repairPhase`/`resolveConflict` hooks. The WebUI run is
    // human-supervised (live kanban + manual task moves), so it trusts the task
    // agents + the operator rather than running an autonomous typecheck/lint gate
    // and repair/conflict-resolver subagents. Worktree isolation + squash-merge
    // still happen (above); an unresolved merge conflict simply parks the worktree
    // for review (mergeOne's default). The fully-autonomous gate lives in the CLI
    // host (`packages/cli/src/autophase-host.ts`). Keep these two in mind when
    // changing phase-completion semantics.
    this.orchestrator = new PhaseOrchestrator({
      graph,
      ctx: {
        executeTask: async (task, phaseId, env) => {
          this.logger.info(`[AutoPhase] [${phaseId}] Executing: ${task.title}`);
          const result = await this.executeTaskWithAgent(task, phaseId, env);
          this.logger.info(`[AutoPhase] [${phaseId}] Completed: ${task.title}`);
          return result;
        },
        onPhaseComplete: (phase) => {
          this.logger.info(`[AutoPhase] Phase completed: ${phase.name}`);
          void this.store.save(graph);
          this.broadcastState();
        },
        onPhaseFail: (phase, error) => {
          this.logger.error(`[AutoPhase] Phase failed: ${phase.name} — ${error.message}`);
          void this.store.save(graph);
          this.broadcastState();
        },
      },
      worktrees: this.worktrees ?? undefined,
      autonomous,
      // Must stay 1: phase tasks run on the single shared context whose cwd we
      // swap per phase, so parallel phases would race on context.cwd.
      maxConcurrentPhases: 1,
      // Sequential within a phase: each todo is a full-tool agent editing the
      // phase worktree, so running two at once risks concurrent writes.
      maxConcurrentTasks: 1,
    });

    // Start the live broadcast immediately, then run the orchestrator in the
    // background. Awaiting start() would block until the *entire* build
    // finishes — the periodic broadcast (below) reads the mutating graph, so
    // clients see live progress while it runs.
    this.startBroadcast();
    this.broadcastState();

    void this.orchestrator
      .start()
      .then(() => {
        this.orchestrator?.stop(); // clear the autonomous tick interval
        void this.store.save(graph);
        this.stopBroadcast();
        const failed = graph.failedPhaseIds.length > 0;
        this.broadcast(
          failed
            ? { type: 'autophase.failed', payload: { title } }
            : { type: 'autophase.completed', payload: { title } },
        );
        this.broadcastState();
      })
      .catch((err: unknown) => {
        this.logger.error(`[AutoPhase] Aborted: ${toErrorMessage(err)}`);
        this.stopBroadcast();
        this.broadcast({ type: 'autophase.failed', payload: { title, error: String(err) } });
      });
  }

  /**
   * Halt the run NOW — at any phase. Sets `stopping` (so a planning turn that
   * resolves afterwards bails), aborts in-flight agents, stops the orchestrator
   * tick, and ends the live broadcast. The board is kept for review; use
   * `autophase.clear` to reset or `autophase.revert` to undo the changes.
   */
  private async handleStop(): Promise<void> {
    this.stopping = true;
    this.abort?.abort();
    this.orchestrator?.stop();
    this.stopBroadcast();
    if (this.graph) await this.store.save(this.graph).catch(() => undefined);
    this.broadcast({ type: 'autophase.stopped', payload: { title: this.graph?.title } });
  }

  /**
   * Stop + wipe: tear down phase worktrees and reset to an empty board so the UI
   * returns to the start screen ("new one"). Does NOT touch already-merged commits
   * on the base branch — that is `autophase.revert`.
   */
  private async handleClear(): Promise<void> {
    await this.handleStop();
    if (this.worktrees) await this.worktrees.cleanupAllManaged().catch(() => undefined);
    this.orchestrator = null;
    this.graph = null;
    this.runBase = null;
    this.usedNicknames.clear();
    this.broadcast({ type: 'autophase.cleared', payload: {} });
    // Empty state → board/wizard falls back to the goal-entry screen.
    this.broadcast({ type: 'autophase.state', payload: this.buildState() });
  }

  /**
   * Stop + undo: remove phase worktrees, then history-preservingly `git revert`
   * every commit this run landed on the base branch (captured `runBase`..HEAD),
   * then reset to an empty board. Refuses (reports a reason) on a dirty tree or a
   * conflicting revert rather than leaving the tree half-reverted.
   */
  private async handleRevert(): Promise<void> {
    await this.handleStop();
    if (!this.worktrees || !this.runBase || !this.projectRoot) {
      this.broadcast({
        type: 'autophase.reverted',
        payload: { ok: false, reverted: 0, reason: 'no git baseline was captured for this run' },
      });
      return;
    }
    await this.worktrees.cleanupAllManaged().catch(() => undefined);
    const shas = commitsSince(this.projectRoot, this.runBase.sha, this.runBase.branch);
    const res = await this.worktrees.revertCommits(this.runBase.branch, shas);
    this.broadcast({ type: 'autophase.reverted', payload: res });
    if (res.ok) {
      this.orchestrator = null;
      this.graph = null;
      this.runBase = null;
      this.broadcast({ type: 'autophase.cleared', payload: {} });
      this.broadcast({ type: 'autophase.state', payload: this.buildState() });
    }
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

  /** Plan phases+todos for the goal via the LLM; fall back to defaults on failure.
   *  The caller passes the run's abort signal so a stop during planning cancels
   *  the LLM turn (the previous fresh, never-aborted controller made planning
   *  uninterruptible). */
  private async planPhases(goal: string, signal?: AbortSignal): Promise<PhaseTemplate[]> {
    try {
      const planner = new AutoPhasePlanner({
        goal,
        runOnce: async (prompt) => {
          const result = (await this.agent.run(prompt, {
            signal: signal ?? new AbortController().signal,
          })) as {
            status: string;
            finalText?: string | undefined;
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
      this.logger.error(`[AutoPhase] Planning failed, using defaults: ${toErrorMessage(err)}`);
    }
    return this.defaultPhases();
  }

  private async executeTaskWithAgent(
    task: import('@wrongstack/core').TaskNode,
    phaseId: string,
    env?: { cwd?: string | undefined; branch?: string | undefined },
  ): Promise<unknown> {
    // Give the task a human worker identity (reuse a manual assignment if one
    // exists) so the board shows who is running it; reflect it on the node and
    // push a live state update before the (long) run begins.
    if (!task.assignee) {
      const nick = assignNickname('executor', this.usedNicknames);
      this.usedNicknames.add(nick.key);
      task.assignee = nick.display.replace(/\s*\([^)]*\)\s*$/, '');
      task.updatedAt = Date.now();
      this.broadcastState();
    }

    // Execute task with agent
    const prompt = `Execute task: ${task.title}\n\nDescription: ${task.description}\nPhase: ${phaseId}\nPriority: ${task.priority}\nType: ${task.type}`;
    const signal = this.abort?.signal ?? new AbortController().signal;
    // Redirect the shared context's cwd at the phase worktree for the duration
    // of this task. Safe because phases/tasks run strictly sequentially here;
    // tools read `ctx.cwd` live, so the agent operates inside the worktree.
    const prevCwd = this.context.cwd;
    if (env?.cwd) this.context.cwd = env.cwd;
    try {
      return await this.agent.run(prompt, { signal });
    } finally {
      this.context.cwd = prevCwd;
    }
  }

  /** Persist + broadcast after an interactive board mutation. */
  private afterBoardMutation(): void {
    if (this.graph) void this.store.save(this.graph);
    this.broadcastState();
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
      const progress = this.orchestrator?.getProgress();
      if (progress) this.broadcast({ type: 'autophase.progress', payload: progress });
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

    // Shared task → board-card mapper. Carries assignee/timestamps so the kanban
    // can show who is on each card and how long it has been running.
    const mapTask = (t: import('@wrongstack/core').TaskNode) => ({
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
    });

    const phaseItems = phases.map((p) => {
      const nodes = Array.from(p.taskGraph.nodes.values());
      const done = nodes.filter((t) => t.status === 'completed').length;
      return {
        id: p.id,
        name: p.name,
        description: p.description,
        status: p.status,
        priority: p.priority,
        estimateHours: p.estimateHours,
        actualDurationMs: p.actualDurationMs,
        startedAt: p.startedAt,
        completedAt: p.completedAt,
        progressPercent: nodes.length > 0 ? Math.round((done / nodes.length) * 100) : 0,
        taskCount: nodes.length,
        completedTasks: done,
        assignedAgents: p.assignedAgents,
        isActive: p.id === currentActiveId,
        // Every phase carries its full task list so the board can render each
        // phase as a column (not just the selected one).
        tasks: nodes.map(mapTask),
      };
    });

    // Back-compat: the chat-area TaskBoard still reads the flat active-phase list.
    const taskItems = activePhase ? Array.from(activePhase.taskGraph.nodes.values()).map(mapTask) : [];

    const completedPhases = phases.filter((p) => p.status === 'completed').length;
    const failedPhases = phases.filter((p) => p.status === 'failed').length;
    const failedTasks = phases.reduce(
      (sum, p) => sum + Array.from(p.taskGraph.nodes.values()).filter((t) => t.status === 'failed').length,
      0,
    );

    // Surface the most recent failure so the board can show it (the store keeps a
    // `lastError` field the UI renders). Prefer the worktree integration error,
    // else a generic phase-failure note.
    const lastFailed = phases.filter((p) => p.status === 'failed').sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
    const lastError = lastFailed
      ? `${lastFailed.name}: ${(lastFailed.metadata?.integrationError as string | undefined) ?? 'phase failed'}`
      : null;

    return {
      title: this.graph.title,
      // Full operator prompt, shown verbatim in a dedicated goal block (the
      // title is only a short derived heading). Fall back to the title for
      // legacy boards saved before the title/goal split.
      goal: this.graph.description || this.graph.title,
      phases: phaseItems,
      tasks: taskItems,
      activePhaseId: currentActiveId,
      overallPercent: phases.length > 0 ? Math.round((completedPhases / phases.length) * 100) : 0,
      autonomous: this.graph.autonomous,
      totalTasks,
      completedTasks,
      // Structured progress + lastError consumed by the autophase store (were
      // defined client-side but never sent, so they stayed null on the board).
      progress: {
        totalPhases: phases.length,
        completed: completedPhases,
        failed: failedPhases,
        totalTasks,
        completedTasks,
        failedTasks,
      },
      lastError,
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
