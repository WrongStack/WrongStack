import { isGitRepo, runCmd } from './goal-commands.js';

export { configureGoalPolicy, isGoalCommandAllowed, resetGoalPolicy } from './goal-commands.js';

/**
 * Goal host wiring for the CLI.
 *
 * Turns a free-text goal into a real, LLM-driven phase run:
 *   1. PLAN   — a one-shot subagent generates a phase-by-phase plan where each
 *               phase carries many concrete todos (GoalPlanner).
 *   2. BUILD  — PhaseGraphBuilder materializes the plan into a PhaseGraph with a
 *               populated TaskGraph per phase, persisted as per-project JSON.
 *   3. RUN    — PhaseOrchestrator drives the graph in the background; every task
 *               is executed by a fresh subagent (full tool access). Phase/task
 *               events flow on the shared EventBus so the TUI PhaseMonitor stays
 *               live, and the graph is re-persisted as phases complete.
 *
 * This is "SDD logic but different": phased, persisted task-lists like SDD, but
 * driven by the autonomous orchestrator + concurrent subagents rather than
 * single-thread turn injection.
 */

import { assignNickname } from '@wrongstack/core/coordination';
import {
  GoalPlanner,
  GoalRunLeaseBusyError,
  GoalRunPersistence,
  type PhaseGraph,
  PhaseGraphBuilder,
  PhaseOrchestrator,
  PhaseStore,
  prepareGoalGraphForResume,
  prepareGoalWorkspace,
  verifyGoalProject,
} from '@wrongstack/goal';

import { WorktreeManager } from '@wrongstack/core/worktree';

/** Tasks share one phase worktree, so concurrency is opt-in rather than implicit. */
const DEFAULT_TASK_CONCURRENCY = 1;

/** Resolve per-phase task concurrency from env, clamped to a sane range. */
function resolveTaskConcurrency(): number {
  const value = process.env['WRONGSTACK_GOAL_TASK_CONCURRENCY']?.trim() ?? '';
  if (!/^\d+$/.test(value)) return DEFAULT_TASK_CONCURRENCY;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_TASK_CONCURRENCY;
  return Math.min(8, Math.max(1, parsed));
}

import { buildConflictPrompt, buildRepairPrompt, buildTaskPrompt } from './goal-host-prompts.js';
import type {
  ActiveRun,
  GoalHostDeps,
  GoalHostHooks,
  GoalStartResult,
  RunResult,
} from './goal-host-types.js';
import { createWorktreeCommandHost } from './worktree-command-host.js';

export type { GoalHostDeps } from './goal-host-types.js';

/** Default parallel-phase concurrency once worktree isolation is available. */
const WORKTREE_PHASE_CONCURRENCY = 4;

export function createGoalHost(deps: GoalHostDeps): GoalHostHooks {
  const store = new PhaseStore({ baseDir: deps.storeDir });
  const persistence = new GoalRunPersistence(store);
  let active: ActiveRun | null = null;
  let starting = false;
  let startingAbort: AbortController | null = null;
  const log = deps.log ?? (() => {});
  const worktreeHost = createWorktreeCommandHost({
    projectRoot: deps.projectRoot,
    events: deps.events,
    isGoalRunActive: () => starting || Boolean(active?.orchestrator.isRunning()),
    acquireGoalRunLease: (ownerId) => store.acquireRunLease(ownerId),
    sddBoardsDir: deps.sddBoardsDir,
  });

  /** Run a single prompt to completion in a throwaway subagent; return its text. */
  async function runOnce(
    prompt: string,
    label: string,
    signal: AbortSignal,
    cwd?: string | undefined,
  ): Promise<string> {
    const factory = deps.multiAgentHost.makeSubagentFactory(deps.getConfig());
    const built = await factory({ name: label, cwd });
    try {
      const result = (await built.agent.run(prompt, { signal })) as RunResult;
      if (result.status !== 'done') {
        throw new Error(result.error?.message ?? `subagent ended with status "${result.status}"`);
      }
      return result.finalText ?? '';
    } finally {
      await built.dispose?.();
    }
  }

  /**
   * Verify a phase's working tree. Runs the project's `typecheck` + `lint` scripts
   * (or a custom `WRONGSTACK_GOAL_VERIFY_CMD`) in `cwd`. Returns ok:true when
   * all pass, or when verification cannot meaningfully run (no deps / no scripts) —
   * the gate never blocks on things it can't actually check.
   */
  async function runVerify(
    cwd: string,
  ): Promise<{ ok: boolean; output?: string | undefined; skipped?: boolean | undefined }> {
    const custom = process.env['WRONGSTACK_GOAL_VERIFY_CMD']?.trim();
    if (custom) {
      const res = await runCmd(custom, [], cwd, true);
      return res.code === 0
        ? { ok: true }
        : { ok: false, output: `[verify] exited ${res.code}\n${res.out}` };
    }

    return verifyGoalProject({ cwd, projectRoot: deps.projectRoot });
  }

  async function persist(graph: PhaseGraph): Promise<void> {
    try {
      await persistence.save(graph);
    } catch (err) {
      log(`⚠ Goal save failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function activateRun(
    graph: PhaseGraph,
    orchestrator: PhaseOrchestrator,
    abort: AbortController,
    releaseRunLease: () => Promise<void>,
    onStartError: (error: unknown) => void,
  ): void {
    let finalizing: Promise<void> | null = null;
    const finalize = (): Promise<void> => {
      if (finalizing) return finalizing;
      if (active?.graph.id !== graph.id) return Promise.resolve();
      const finished = active;
      finished.unsubscribe();
      finalizing = (async () => {
        try {
          await Promise.resolve();
          await finished.runPromise?.catch(() => undefined);
          await persist(graph);
          await finished.releaseRunLease();
        } catch (err) {
          log(`⚠ Goal run cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          if (active === finished) active = null;
        }
      })();
      return finalizing;
    };
    const onDone = (payload: unknown) => {
      if ((payload as { graphId?: string })?.graphId !== graph.id) return;
      graph.runState = 'completed';
      log(`🎉 Goal complete: ${graph.title}`);
      void finalize();
    };
    const onFailed = (payload: unknown) => {
      if ((payload as { graphId?: string })?.graphId !== graph.id) return;
      graph.runState = 'failed';
      void finalize();
    };
    const bus = deps.events as unknown as {
      on(event: string, handler: (payload: unknown) => void): void;
      off(event: string, handler: (payload: unknown) => void): void;
    };
    bus.on('graph.completed', onDone);
    bus.on('graph.failed', onFailed);
    const unsubscribe = () => {
      bus.off('graph.completed', onDone);
      bus.off('graph.failed', onFailed);
    };
    active = { graph, orchestrator, abort, unsubscribe, releaseRunLease };
    const runPromise = orchestrator.start();
    active.runPromise = runPromise;
    void runPromise.catch((err) => {
      onStartError(err);
      void finalize();
    });
  }

  return {
    async onGoalStart({ goal, projectContext }): Promise<GoalStartResult> {
      if (starting || active) {
        return {
          ok: false,
          error: 'A Goal run is already in progress. Use /goal stop first.',
        };
      }
      starting = true;
      const abort = new AbortController();
      startingAbort = abort;
      const goalId = crypto.randomUUID();
      const ownerSessionId = deps.getSessionId?.();
      let releaseRunLease: (() => Promise<void>) | undefined;
      let planningGraph: PhaseGraph | undefined;
      try {
        const isolated =
          deps.worktrees !== false &&
          process.env['WRONGSTACK_GOAL_WORKTREES'] !== '0' &&
          (await isGitRepo(deps.projectRoot));
        const ownerId = `cli:${process.pid}:${goalId}`;
        releaseRunLease = isolated
          ? await store.acquireGoalRunLease(goalId, ownerId)
          : await store.acquireRunLease(ownerId);
        if (abort.signal.aborted) return { ok: false, error: 'Goal start was stopped.' };
        planningGraph = await new PhaseGraphBuilder({
          title: goal,
          description: goal,
          phases: [],
        }).build();
        planningGraph.id = goalId;
        planningGraph.sessionId = ownerSessionId;
        planningGraph.runState = 'planning';
        planningGraph.leaseScope = isolated ? 'goal' : 'project';
        await persist(planningGraph);
        // Stable per-run worker identities, so the board can show "who is on what".
        const usedNicknames = new Set<string>();

        // 1) PLAN
        log(`🧠 Planning phases for: ${goal}`);
        let phases;
        try {
          const planner = new GoalPlanner({
            goal,
            projectContext,
            runOnce: (p) => runOnce(p, 'goal-planner', abort.signal, deps.projectRoot),
          });
          const result = await planner.plan();
          if (result.parseFailed || result.phases.length === 0) {
            return {
              ok: false,
              error: 'The planner did not produce a usable phase plan. Try a more specific goal.',
            };
          }
          phases = result.phases;
        } catch (err) {
          return {
            ok: false,
            error: `Planning failed: ${err instanceof Error ? err.message : String(err)}`,
          };
        }

        const todoCount = phases.reduce((n, p) => n + (p.taskTemplates?.length ?? 0), 0);
        if (todoCount === 0) {
          return {
            ok: false,
            error:
              'The planner produced phases without executable tasks. Refine the goal and try again.',
          };
        }
        log(`📋 Plan ready: ${phases.length} phases, ${todoCount} todos.`);

        // 2) BUILD + persist
        const graph = await new PhaseGraphBuilder({
          title: goal,
          phases,
          autonomous: true,
        }).build();
        graph.sessionId = ownerSessionId;
        graph.id = goalId;
        graph.runState = 'running';
        graph.leaseScope = isolated ? 'goal' : 'project';
        planningGraph = graph;
        if (abort.signal.aborted) return { ok: false, error: 'Goal start was stopped.' };
        const runRoot = isolated
          ? await prepareGoalWorkspace(deps.projectRoot, graph, deps.events)
          : deps.projectRoot;
        await persist(graph);

        // Per-phase git-worktree isolation. When enabled and inside a git repo,
        // each phase runs in its own worktree+branch so parallelizable phases
        // execute concurrently and merge back sequentially. Otherwise fall back
        // to the legacy single-tree, single-phase, single-task behavior.
        const worktreesEnabled =
          deps.worktrees !== false && process.env['WRONGSTACK_GOAL_WORKTREES'] !== '0';
        let worktrees: WorktreeManager | undefined;
        if (worktreesEnabled && isolated) {
          worktrees = new WorktreeManager({
            projectRoot: runRoot,
            events: deps.events,
            sessionId: graph.sessionId,
          });
          log(
            `🌿 Worktree isolation on — up to ${deps.maxConcurrentPhases ?? WORKTREE_PHASE_CONCURRENCY} phases run in parallel.`,
          );
        }

        // Per-phase verification gate. After a phase's todos all succeed, run the
        // project's typecheck/lint in the phase worktree before merging; on failure
        // a repair subagent gets the output and fixes the tree, then we re-verify.
        // Disable with WRONGSTACK_GOAL_VERIFY=0.
        const verifyEnabled = process.env['WRONGSTACK_GOAL_VERIFY'] !== '0';
        graph.worktrees = Boolean(worktrees);
        graph.verifyTasks = verifyEnabled;
        if (worktrees) graph.runBase = (await worktrees.currentBase()) ?? undefined;
        await persist(graph);
        if (abort.signal.aborted) {
          graph.runState = 'stopped';
          await persist(graph);
          return { ok: false, error: 'Goal start was stopped.' };
        }
        if (verifyEnabled) {
          log(`🔎 Verify gate on — phases must pass typecheck/lint before merging.`);
        }

        // Merge-conflict resolution. Only meaningful with worktree isolation (the
        // only path that merges). On conflict a resolver subagent edits the base
        // tree to clear the markers; if it fails the worktree is parked for review
        // as before. Disable with WRONGSTACK_GOAL_RESOLVE=0.
        const resolveEnabled = !!worktrees && process.env['WRONGSTACK_GOAL_RESOLVE'] !== '0';

        // 3) RUN (background)
        const orchestrator = new PhaseOrchestrator({
          graph,
          ctx: {
            executeTask: async (task, phaseId, env, signal) => {
              const phase = graph.phases.get(phaseId);
              const phaseName = phase?.name ?? phaseId;
              // Give the task a human worker identity (reuse a manual assignment if
              // one exists) and reflect it onto the node so the board shows who is
              // running it — both via the periodic state and a live taskAssigned event.
              let agentName = task.assignee;
              if (!agentName) {
                const nick = assignNickname('executor', usedNicknames);
                usedNicknames.add(nick.key);
                agentName = nick.display.replace(/\s*\([^)]*\)\s*$/, '');
                active?.orchestrator.setTaskAssignee(task.id, undefined, agentName);
              }
              return runOnce(
                buildTaskPrompt(task, phaseName, goal),
                `goal-${agentName}`.slice(0, 48),
                signal ? AbortSignal.any([abort.signal, signal]) : abort.signal,
                env?.cwd ?? runRoot,
              );
            },
            verifyPhase: verifyEnabled
              ? async (_phase, env) => runVerify(env?.cwd ?? runRoot)
              : undefined,
            verifyGoal: verifyEnabled ? async () => runVerify(runRoot) : undefined,
            repairPhase: verifyEnabled
              ? async (phase, failure, attempt, env) => {
                  log(`🔧 Repairing "${phase.name}" (attempt ${attempt}) after verify failure…`);
                  await runOnce(
                    buildRepairPrompt(phase.name, failure, goal),
                    `goal-repair-${phase.name}`.slice(0, 48),
                    abort.signal,
                    env?.cwd ?? runRoot,
                  );
                }
              : undefined,
            resolveConflict: resolveEnabled
              ? async (_phase, info) => {
                  log(`🔀 Resolving merge conflict in ${info.conflictFiles.length} file(s)…`);
                  try {
                    await runOnce(
                      buildConflictPrompt(info.conflictFiles, goal),
                      'goal-conflict',
                      abort.signal,
                      info.cwd,
                    );
                    return true;
                  } catch {
                    return false;
                  }
                }
              : undefined,
            sessionId: graph.sessionId,
            brain: deps.brain,
            onTaskUpdate: () => {
              void persist(graph);
            },
            onPhaseComplete: (phase) => {
              log(`✅ Phase completed: ${phase.name}`);
              void persist(graph);
            },
            onPhaseFail: (phase, error) => {
              log(`❌ Phase failed: ${phase.name} — ${error.message}`);
              void persist(graph);
            },
          },
          events: deps.events,
          worktrees,
          autonomous: true,
          // With isolation, parallelizable phases run concurrently; without it,
          // stay strictly sequential to protect the shared working tree.
          maxConcurrentPhases: worktrees
            ? (deps.maxConcurrentPhases ?? WORKTREE_PHASE_CONCURRENCY)
            : 1,
          // Within a phase, todos share the phase worktree. Keep writes sequential
          // by default; explicitly raise WRONGSTACK_GOAL_TASK_CONCURRENCY only for
          // a task plan whose file ownership is known not to overlap.
          maxConcurrentTasks: resolveTaskConcurrency(),
          stopOnFailure: true,
        });

        activateRun(graph, orchestrator, abort, releaseRunLease, (err) => {
          log(`💥 Goal aborted: ${err instanceof Error ? err.message : String(err)}`);
        });
        releaseRunLease = undefined;

        return { ok: true, graph };
      } catch (err) {
        return {
          ok: false,
          error:
            err instanceof GoalRunLeaseBusyError
              ? err.message
              : `Goal start failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      } finally {
        if (releaseRunLease && planningGraph) {
          planningGraph.runState = abort.signal.aborted ? 'stopped' : 'failed';
          await persist(planningGraph);
        }
        starting = false;
        if (startingAbort === abort) startingAbort = null;
        await releaseRunLease?.();
      }
    },

    onGoalPause() {
      active?.orchestrator.pause();
      if (active) {
        active.graph.runState = 'paused';
        void persist(active.graph);
      }
    },

    onGoalResume() {
      active?.orchestrator.resume();
      if (active) {
        active.graph.runState = 'running';
        void persist(active.graph);
      }
    },

    onGoalResumeFromGraph: async (graph: PhaseGraph): Promise<GoalStartResult> => {
      if (starting || active) {
        return {
          ok: false,
          error: 'A Goal run is already in progress. Use /goal stop first.',
        };
      }
      starting = true;
      const abort = new AbortController();
      startingAbort = abort;
      // Older saved graphs have no owner; attribute them to the resuming session.
      if (!graph.sessionId) graph.sessionId = deps.getSessionId?.();
      let releaseRunLease: (() => Promise<void>) | undefined;
      try {
        const ownerId = `cli-resume:${process.pid}:${graph.id}`;
        releaseRunLease = graph.workspace
          ? await store.acquireGoalRunLease(graph.id, ownerId)
          : await store.acquireRunLease(ownerId);
        if (abort.signal.aborted) return { ok: false, error: 'Goal resume was stopped.' };
        const runRoot = graph.workspace
          ? await prepareGoalWorkspace(deps.projectRoot, graph, deps.events)
          : deps.projectRoot;
        const usedNicknames = new Set<string>();
        const log = deps.log ?? (() => {});
        const title = graph.title;
        log('🔄 Resuming: ' + title);
        const worktreesEnabled =
          graph.worktrees !== false &&
          deps.worktrees !== false &&
          process.env['WRONGSTACK_GOAL_WORKTREES'] !== '0';
        let worktrees;
        if (worktreesEnabled && (await isGitRepo(runRoot))) {
          worktrees = new WorktreeManager({
            projectRoot: runRoot,
            events: deps.events,
            sessionId: graph.sessionId,
          });
        }
        await prepareGoalGraphForResume(graph, worktrees);
        if (abort.signal.aborted) return { ok: false, error: 'Goal resume was stopped.' };
        graph.runState = 'running';
        await persist(graph);
        // `/goal stop` may land during that save; activating anyway ran the
        // tasks the user just stopped (the start path re-checks here too).
        if (abort.signal.aborted) {
          graph.runState = 'stopped';
          await persist(graph);
          return { ok: false, error: 'Goal resume was stopped.' };
        }
        const verifyEnabled = graph.verifyTasks ?? process.env['WRONGSTACK_GOAL_VERIFY'] !== '0';
        const resolveEnabled = !!worktrees && process.env['WRONGSTACK_GOAL_RESOLVE'] !== '0';
        const orchestrator = new PhaseOrchestrator({
          graph,
          ctx: {
            executeTask: async (task, phaseId, env, signal) => {
              const phase = graph.phases.get(phaseId);
              const phaseName = phase?.name ?? phaseId;
              let agentName = task.assignee;
              if (!agentName) {
                const nick = assignNickname('executor', usedNicknames);
                usedNicknames.add(nick.key);
                agentName = nick.display.replace(/\s*\([^)]*\)\s*$/, '');
                active?.orchestrator.setTaskAssignee(task.id, undefined, agentName);
              }
              return runOnce(
                buildTaskPrompt(task, phaseName, title),
                'goal-' + agentName.slice(0, 48),
                signal ? AbortSignal.any([abort.signal, signal]) : abort.signal,
                env?.cwd ?? runRoot,
              );
            },
            verifyPhase: verifyEnabled
              ? async (_phase, env) => runVerify(env?.cwd ?? runRoot)
              : undefined,
            verifyGoal: verifyEnabled ? async () => runVerify(runRoot) : undefined,
            repairPhase: verifyEnabled
              ? async (phase, failure, attempt, env) => {
                  log(
                    '🔧 Repairing ' +
                      phase.name +
                      ' (attempt ' +
                      attempt +
                      ') after verify failure...',
                  );
                  await runOnce(
                    buildRepairPrompt(phase.name, failure, title),
                    'goal-repair-' + phase.name.slice(0, 48),
                    abort.signal,
                    env?.cwd ?? runRoot,
                  );
                }
              : undefined,
            resolveConflict: resolveEnabled
              ? async (_phase, info) => {
                  log(
                    '🔀 Resolving merge conflict in ' + info.conflictFiles.length + ' file(s)...',
                  );
                  try {
                    await runOnce(
                      buildConflictPrompt(info.conflictFiles, title),
                      'goal-conflict',
                      abort.signal,
                      info.cwd,
                    );
                    return true;
                  } catch {
                    return false;
                  }
                }
              : undefined,
            sessionId: graph.sessionId,
            brain: deps.brain,
            onTaskUpdate: () => {
              void persist(graph);
            },
            onPhaseComplete: (phase) => {
              log('✅ Phase completed: ' + phase.name);
              void persist(graph);
            },
            onPhaseFail: (phase, error) => {
              log('❌ Phase failed: ' + phase.name + ' - ' + error.message);
              void persist(graph);
            },
          },
          events: deps.events,
          worktrees,
          autonomous: true,
          maxConcurrentPhases: worktrees
            ? (deps.maxConcurrentPhases ?? WORKTREE_PHASE_CONCURRENCY)
            : 1,
          maxConcurrentTasks: resolveTaskConcurrency(),
          stopOnFailure: true,
        });
        activateRun(graph, orchestrator, abort, releaseRunLease, (err) => {
          log('❌ Goal orchestrator error: ' + (err instanceof Error ? err.message : String(err)));
        });
        releaseRunLease = undefined;
        return { ok: true, graph };
      } catch (err) {
        return {
          ok: false,
          error:
            err instanceof GoalRunLeaseBusyError
              ? err.message
              : `Goal resume failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      } finally {
        starting = false;
        if (startingAbort === abort) startingAbort = null;
        await releaseRunLease?.();
      }
    },

    onGoalStop() {
      startingAbort?.abort();
      if (!active) return;
      const stopped = active;
      stopped.graph.runState = 'stopped';
      stopped.abort.abort();
      stopped.orchestrator.stop();
      stopped.unsubscribe();
      active = null;
      void (async () => {
        try {
          await stopped.runPromise?.catch(() => undefined);
          await persist(stopped.graph);
          await stopped.releaseRunLease();
        } catch (err) {
          log(`⚠ Goal stop cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      })();
    },

    getGoalRunner() {
      if (!active) return null;
      const a = active;
      return {
        graph: a.graph,
        getProgress: () => a.orchestrator.getProgress(),
        isRunning: () => a.orchestrator.isRunning(),
      };
    },

    onGoalMoveTask(taskId, toPhaseId) {
      if (!active) return false;
      const ok = active.orchestrator.moveTask(taskId, toPhaseId);
      if (ok) void persist(active.graph);
      return ok;
    },

    onGoalAssignTask(taskId, agentId, agentName) {
      if (!active) return false;
      const ok = active.orchestrator.setTaskAssignee(taskId, agentId, agentName);
      if (ok) void persist(active.graph);
      return ok;
    },

    onGoalAddTask(phaseId, spec) {
      if (!active) return null;
      const id = active.orchestrator.addTask(phaseId, spec);
      if (id) void persist(active.graph);
      return id;
    },

    onGoalRetryTask(taskId) {
      if (!active) return false;
      const ok = active.orchestrator.requeueTask(taskId);
      if (ok) void persist(active.graph);
      return ok;
    },

    onWorktree: worktreeHost.onWorktree,
  };
}
