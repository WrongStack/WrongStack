import type { EventBus } from '@wrongstack/contracts/kernel';
import type { Logger } from '@wrongstack/contracts/types';
import type { Context } from '@wrongstack/core/agent';
import {
  type GoalRunPersistence,
  type PhaseExecutionContext,
  type PhaseGraph,
  PhaseGraphBuilder,
  type PhaseNode,
  PhaseOrchestrator,
  type PhaseTemplate,
  prepareGoalWorkspace,
  verifyGoalProject,
} from '@wrongstack/goal';
import { toErrorMessage } from '@wrongstack/core/utils';
import { WorktreeManager } from '@wrongstack/core/worktree';
import { isGitWorkTree } from './git-process.js';

/**
 * Derive a short, single-line heading from a (possibly multi-paragraph) goal
 * prompt. Takes the first non-empty line, trims to its first sentence, and caps
 * the length so Goal headers stay readable. The full prompt is preserved
 * separately as the graph description.
 */
function deriveTitle(goal: string): string {
  const firstLine = goal
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  if (!firstLine) return 'Goal';
  const sentence = firstLine.split(/(?<=[.!?])\s/)[0] ?? firstLine;
  const trimmed = sentence.length <= 64 ? sentence : `${sentence.slice(0, 63).trimEnd()}…`;
  return trimmed || 'Goal';
}

export interface GoalRunHost {
  readonly goalId?: string | undefined;
  abort: AbortController | null;
  planPhases(goal: string, signal?: AbortSignal): Promise<PhaseTemplate[]>;
  readonly stopping: boolean;
  broadcast(msg: { type: string; payload: unknown }): void;
  runStatus: 'idle' | 'running' | 'paused' | 'completed' | 'failed' | 'stopped';
  readonly logger: Logger;
  graph: PhaseGraph | null;
  worktrees: WorktreeManager | null;
  runBase: { branch: string; sha: string } | null;
  readonly events: EventBus | undefined;
  readonly projectRoot: string | undefined;
  readonly context: Context;
  readonly persistence: GoalRunPersistence;
  runRepairPhase(
    phase: PhaseNode,
    failure: string,
    attempt: number,
    env?: { cwd?: string | undefined; branch?: string | undefined },
  ): Promise<void>;
  executeTaskWithAgent(
    task: import('@wrongstack/contracts/types').TaskNode,
    phaseId: string,
    env?: { cwd?: string | undefined; branch?: string | undefined },
    signal?: AbortSignal | undefined,
  ): Promise<unknown>;
  runChimeraReview(
    task: import('@wrongstack/contracts/types').TaskNode,
    phaseId: string,
    result: unknown,
    cwd?: string | undefined,
  ): Promise<void>;
  persistDetached(graph: PhaseGraph): void;
  broadcastState(activePhaseId?: string): void;
  orchestrator: PhaseOrchestrator | null;
  startBroadcast(): void;
  runPromise: Promise<void> | null;
  stopBroadcast(): void;
  releaseActiveRunLease(): Promise<void>;
}

export async function startGoalRun(
  host: GoalRunHost,
  payload?: Record<string, unknown>,
  resumeGraph?: PhaseGraph,
): Promise<void> {
  // The caller sends the operator's full prompt as the goal. We keep it intact
  // as the graph `description` and derive a short, human-readable `title` for
  // headers / the board switcher — pasting the whole prompt as the title made
  // the Goal header unreadable.
  const goal =
    resumeGraph?.description ||
    resumeGraph?.title ||
    (payload?.goal as string) ||
    (payload?.title as string) ||
    'Untitled Project';
  const title = resumeGraph?.title ?? deriveTitle(goal);
  const autonomous = resumeGraph?.autonomous ?? (payload?.autonomous as boolean) ?? true;
  const multiBoard = resumeGraph?.multiBoard ?? (payload?.multiBoard as boolean) ?? false;
  const verifyTasks =
    resumeGraph?.verifyTasks ??
    (payload?.verifyTasks as boolean | undefined) ??
    process.env['WRONGSTACK_GOAL_VERIFY'] !== '0';
  const chimeraReview = resumeGraph?.chimeraReview ?? (payload?.chimeraReview as boolean) ?? false;

  // Fresh abort for THIS run, created BEFORE planning so a stop pressed during
  // the (long) planning turn actually cancels it. Previously the controller was
  // created only after planning, so a stop while "starting" was a no-op and the
  // run launched anyway.
  const runAbort = new AbortController();
  host.abort = runAbort;
  const ownerSessionId =
    resumeGraph?.sessionId ??
    (typeof payload?.sessionId === 'string' ? payload.sessionId : host.context.session?.id);
  if (host.goalId && !resumeGraph) {
    const planningGraph = await new PhaseGraphBuilder({
      title,
      description: goal,
      phases: [],
    }).build();
    planningGraph.id = host.goalId;
    planningGraph.runState = 'planning';
    planningGraph.leaseScope = 'goal';
    planningGraph.sessionId = ownerSessionId;
    host.graph = planningGraph;
    await host.persistence.save(planningGraph);
    host.broadcastState();
  }

  // Phase plan resolution:
  //   1. explicit phases in the payload win (caller override);
  //   2. otherwise the LLM plans phases+todos for the goal;
  //   3. an unusable plan is rejected before a graph is created.
  const phases = resumeGraph
    ? []
    : Array.isArray(payload?.phases)
      ? (payload.phases as PhaseTemplate[])
      : await host.planPhases(goal, runAbort.signal);

  // Stop requested during planning → never launch the orchestrator. The abort
  // may not have interrupted the in-flight LLM call promptly, so the `stopping`
  // flag is the authoritative guard for the resolve-after-stop window.
  if (host.stopping || runAbort.signal.aborted) {
    if (host.graph) host.graph.runState = 'stopped';
    host.broadcast({ type: 'goal.stopped', payload: { title } });
    return;
  }

  const taskCount = phases.reduce((count, phase) => count + (phase.taskTemplates?.length ?? 0), 0);
  if (!resumeGraph && (phases.length === 0 || taskCount === 0)) {
    host.abort = null;
    host.runStatus = 'failed';
    if (host.graph) {
      host.graph.runState = 'failed';
      await host.persistence.save(host.graph);
    }
    host.broadcast({
      type: 'goal.error',
      payload: {
        message: 'The planner did not produce executable tasks. Refine the goal and try again.',
        stage: 'planning',
        title,
        ...(ownerSessionId ? { sessionId: ownerSessionId } : {}),
      },
    });
    return;
  }

  host.logger.info(`[Goal] Starting: ${title}`);

  // Build the graph up-front so we have a reference for live broadcasts and
  // persistence *before* the (long-running) build begins.
  const graph =
    resumeGraph ??
    (await new PhaseGraphBuilder({
      title,
      description: goal,
      phases,
      autonomous,
      multiBoard,
      verifyTasks,
      chimeraReview,
    }).build());
  if (host.goalId && !resumeGraph) graph.id = host.goalId;
  graph.sessionId = ownerSessionId;
  graph.runState = 'running';
  graph.leaseScope = host.goalId && !resumeGraph ? 'goal' : graph.leaseScope;
  host.graph = graph;
  const runRoot =
    (host.goalId && !resumeGraph) || graph.workspace
      ? host.projectRoot
        ? await prepareGoalWorkspace(host.projectRoot, graph, host.events)
        : (() => {
            throw new Error('An isolated Goal requires a git project root.');
          })()
      : host.projectRoot;

  // Per-phase git-worktree isolation, when enabled and inside a git repo.
  // The shared agent/context means we can't run phases in parallel here
  // (we swap a single context.cwd per task), so phases stay sequential —
  // but each phase still commits + squash-merges back through its own
  // worktree, and the lifecycle events drive the live swim-lane/DAG view.
  // Per-run worktree-isolation override from the UI wins; omitted → env default
  // (disable with WRONGSTACK_GOAL_WORKTREES=0). false → run on the current branch.
  const useWorktrees = resumeGraph
    ? resumeGraph.worktrees === true
    : ((payload?.worktrees as boolean | undefined) ??
      process.env['WRONGSTACK_GOAL_WORKTREES'] !== '0');
  host.worktrees = null;
  host.runBase = null;
  if (host.events && runRoot && useWorktrees && (await isGitWorkTree(runRoot))) {
    host.worktrees = new WorktreeManager({
      projectRoot: runRoot,
      events: host.events,
      sessionId: graph.sessionId,
    });
  }
  if (resumeGraph?.worktrees && !host.worktrees) {
    throw new Error(
      'Saved Goal requires its git worktrees, but this project is not a git checkout.',
    );
  }
  if (!resumeGraph) graph.worktrees = Boolean(host.worktrees);
  await host.persistence.save(graph);
  // Capture the pre-run base tip so `goal.revert` can git-revert exactly
  // the commits this run lands on the base branch.
  if (host.worktrees) {
    host.runBase = graph.runBase ?? (await host.worktrees.currentBase());
    graph.runBase = host.runBase ?? undefined;
    await host.persistence.save(graph);
  }

  // Last await before launch. A stop during the graph build, worktree setup
  // or saves above has already released the run lease and told clients the
  // run stopped; launching now would run it unleased.
  if (host.stopping || runAbort.signal.aborted) {
    // A resume sets 'running' after its own awaits, possibly after the stop.
    host.runStatus = 'stopped';
    graph.runState = 'stopped';
    await host.persistence.save(graph);
    host.broadcast({ type: 'goal.stopped', payload: { title } });
    return;
  }

  // Verification hooks — conditionally wired when verifyTasks is enabled.
  // When active, the orchestrator runs typecheck after each task and triggers
  // a repair subagent on failure, closing the verify→repair→verify loop.
  const maybeVerify: {
    verifyPhase?: PhaseExecutionContext['verifyPhase'];
    repairPhase?: PhaseExecutionContext['repairPhase'];
  } = {};
  if (verifyTasks && runRoot) {
    maybeVerify.verifyPhase = async (_phase, env) =>
      verifyGoalProject({
        cwd: env?.cwd ?? runRoot,
        projectRoot: host.projectRoot,
      });
    maybeVerify.repairPhase = (phase, failure, attempt, env) =>
      host.runRepairPhase(phase, failure, attempt, env);
  }

  const orchestrator = new PhaseOrchestrator({
    graph,
    ctx: {
      executeTask: async (task, phaseId, env, signal) => {
        host.logger.info(`[Goal] [${phaseId}] Executing: ${task.title}`);
        const taskEnv = { ...env, cwd: env?.cwd ?? runRoot };
        const result = await host.executeTaskWithAgent(task, phaseId, taskEnv, signal);
        host.logger.info(`[Goal] [${phaseId}] Completed: ${task.title}`);

        // This host owns one Agent. Await the review before the next task so
        // the Agent's single-flight guard cannot race a background review.
        if (chimeraReview) {
          await host.runChimeraReview(task, phaseId, result, taskEnv.cwd);
        }

        return result;
      },
      ...maybeVerify,
      verifyGoal:
        maybeVerify.verifyPhase && runRoot
          ? async () => {
              // Empty-phase graphs (e.g. an empty saved graph resumed with
              // verifyTasks on) have no phase context to verify — restored
              // guard, previously `Array.from(graph.phases.values()).at(-1)`.
              if (graph.phases.size === 0) {
                return { ok: false, output: 'Goal graph has no phase to verify.' };
              }
              return verifyGoalProject({ cwd: runRoot, projectRoot: host.projectRoot });
            }
          : undefined,
      onTaskUpdate: () => {
        host.persistDetached(graph);
        host.broadcastState();
      },
      onPhaseComplete: (phase) => {
        host.logger.info(`[Goal] Phase completed: ${phase.name}`);
        host.persistDetached(graph);
        host.broadcastState();
      },
      onPhaseFail: (phase, error) => {
        host.logger.error(`[Goal] Phase failed: ${phase.name} — ${error.message}`);
        host.persistDetached(graph);
        host.broadcastState();
      },
    },
    worktrees: host.worktrees ?? undefined,
    autonomous,
    // Must stay 1: phase tasks run on the single shared context whose cwd we
    // swap per phase, so parallel phases would race on context.cwd.
    maxConcurrentPhases: 1,
    // Sequential within a phase: each todo is a full-tool agent editing the
    // phase worktree, so running two at once risks concurrent writes.
    maxConcurrentTasks: 1,
  });
  host.orchestrator = orchestrator;
  host.runStatus = 'running';

  // Start the live broadcast immediately, then run the orchestrator in the
  // background. Awaiting start() would block until the *entire* build
  // finishes — the periodic broadcast (below) reads the mutating graph, so
  // clients see live progress while it runs.
  host.startBroadcast();
  host.broadcastState();

  const runPromise = orchestrator.start();
  host.runPromise = runPromise;
  void runPromise
    .then(async () => {
      if (host.orchestrator !== orchestrator) return;
      graph.runState =
        graph.failedPhaseIds.length > 0 || graph.finalVerification?.status === 'failed'
          ? 'failed'
          : 'completed';
      let saveError: string | undefined;
      try {
        await host.persistence.save(graph);
      } catch (err) {
        saveError = toErrorMessage(err);
        host.logger.error(`[Goal] Final save failed: ${saveError}`);
      }
      if (host.orchestrator !== orchestrator) return;
      host.stopBroadcast();
      const failed =
        graph.failedPhaseIds.length > 0 ||
        graph.finalVerification?.status === 'failed' ||
        saveError !== undefined;
      host.runStatus = failed ? 'failed' : 'completed';
      graph.runState = host.runStatus;
      host.broadcast(
        failed
          ? { type: 'goal.failed', payload: { title, error: saveError } }
          : { type: 'goal.completed', payload: { title } },
      );
      host.broadcastState();
      host.abort = null;
      await host.releaseActiveRunLease();
      if (host.runPromise === runPromise) host.runPromise = null;
    })
    .catch(async (err: unknown) => {
      if (host.orchestrator !== orchestrator) return;
      host.logger.error(`[Goal] Aborted: ${toErrorMessage(err)}`);
      await host.persistence.save(graph).catch((saveErr: unknown) => {
        host.logger.warn(`[Goal] Failed to save aborted run: ${toErrorMessage(saveErr)}`);
      });
      if (host.orchestrator !== orchestrator) return;
      host.runStatus = 'failed';
      graph.runState = 'failed';
      host.stopBroadcast();
      host.broadcast({ type: 'goal.failed', payload: { title, error: String(err) } });
      host.abort = null;
      await host.releaseActiveRunLease();
      if (host.runPromise === runPromise) host.runPromise = null;
    });
}
