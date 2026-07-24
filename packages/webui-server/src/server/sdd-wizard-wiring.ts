import * as path from 'node:path';
import {
  type AgentFactory,
  type BrainArbiter,
} from '@wrongstack/core/coordination';
import type { Agent } from '@wrongstack/core/agent';
import {
  DefaultTaskStore,
  TaskTracker,
} from '@wrongstack/core/tasking';
import type { EventBus } from '@wrongstack/core/kernel';
import type { TaskGraph } from '@wrongstack/core/types';
import { ToolValidationError } from '@wrongstack/core/types';
import { WorktreeManager } from '@wrongstack/core/worktree';
import {
  cleanupStaleSddWorktrees,
  decomposeNonAtomicTasks,
  makeAcceptanceCriteriaVerifier,
  makeCommandVerifier,
  makeCompositeVerifier,
  makeLlmSubtaskGenerator,
  makePlanningDecomposer,
  SddBoardStore,
  type SddRunHandle,
  SddInterviewDriver,
  SddRunRegistry,
  SddSupervisor,
  SpecStore,
  startSddRun,
  TaskGraphStore,
} from '@wrongstack/sdd';
import type { SddWizardDeps } from './sdd-wizard-ws-handler.js';
import { isGitWorkTree } from './git-process.js';

/** Config knobs shared by the wizard start and the launch-from-board start. */
export interface StartSddRunFromGraphConfig {
  parallelSlots?: number | undefined;
  defaultModel?: string | undefined;
  defaultProvider?: string | undefined;
  fallbackModels?: string[] | undefined;
  /** Per-run git-worktree isolation. Omit → env default (WRONGSTACK_SDD_WORKTREES). */
  worktrees?: boolean | undefined;
  /**
   * Planning-time proactive decomposition of `needs_decomposition` leaves
   * before the run starts. Omit → env default (WRONGSTACK_SDD_PLAN_DECOMPOSE,
   * off unless set to '1'). Requires deps.runIsolatedTurn.
   */
  planDecompose?: boolean | undefined;
}

export interface StartSddRunFromGraphDeps {
  agent: Agent;
  events: EventBus;
  projectRoot: string;
  subagentFactory: AgentFactory;
  brain?: BrainArbiter | undefined;
  projectSddBoards: string;
  registry?: SddRunRegistry | undefined;
  /** Isolated read-only LLM turn for the supervisor's auto-split. Omit → no split. */
  runIsolatedTurn?: ((prompt: string, name: string) => Promise<string>) | undefined;
}

/**
 * Start a multi-agent SDD run from a ready TaskGraph — the shared core behind
 * BOTH the wizard's `startRun` and launching a run from a kanban board. Builds a
 * TaskTracker from the graph (when none is supplied), sets up worktree isolation,
 * the completion-gate verifier and the Brain failure supervisor, then defers to
 * `startSddRun` (which owns the projector + cross-process control drain, so the
 * run is steerable from any surface). Resolves to the run handle after the
 * non-blocking git worktree capability probe completes.
 */
export async function startSddRunFromGraph(
  graph: TaskGraph,
  deps: StartSddRunFromGraphDeps,
  config: StartSddRunFromGraphConfig = {},
  tracker?: TaskTracker,
): Promise<SddRunHandle> {
  const runTracker =
    tracker ??
    (() => {
      const t = new TaskTracker({ store: new DefaultTaskStore() });
      t.setGraph(graph);
      return t;
    })();

  // Per-task git-worktree isolation (per-run toggle wins; env default otherwise).
  const worktreesEnabled = config.worktrees ?? process.env['WRONGSTACK_SDD_WORKTREES'] !== '0';
  let worktrees: WorktreeManager | undefined;
  if (worktreesEnabled && (await isGitWorkTree(deps.projectRoot))) {
    void cleanupStaleSddWorktrees({
      projectRoot: deps.projectRoot,
      boardsDir: deps.projectSddBoards,
    }).catch(() => undefined);
    worktrees = new WorktreeManager({
      projectRoot: deps.projectRoot,
      events: deps.events,
      sessionId: () => deps.agent.ctx.session?.id,
    });
  }

  // Proactive planning-time decomposition: split leaves the atomicity engine
  // judged too large BEFORE dispatch, using the same graph surgery as run-time
  // splits. Auto mode — the wizard plan was already human-approved. Guarded by
  // config/env and bounded inside decomposeNonAtomicTasks (max 10 per graph).
  const planDecomposeEnabled =
    config.planDecompose ?? process.env['WRONGSTACK_SDD_PLAN_DECOMPOSE'] === '1';
  if (planDecomposeEnabled && deps.runIsolatedTurn) {
    try {
      const decomposition = await decomposeNonAtomicTasks({
        tracker: runTracker,
        decompose: makePlanningDecomposer({
          run: (prompt) => deps.runIsolatedTurn!(prompt, 'Task Splitter'),
        }),
        mode: 'auto',
      });
      for (const applied of decomposition.applied) {
        deps.events.emit('sdd.task.decomposed', {
          graphId: graph.id,
          taskId: applied.nodeId,
          subtaskIds: applied.subtaskIds,
          mode: 'auto',
          phase: 'planning',
        });
      }
    } catch {
      // Planning decomposition is best-effort — a failed splitter turn must
      // never block starting the run.
    }
  }

  const superviseFailure =
    deps.brain && deps.runIsolatedTurn
      ? new SddSupervisor({
          brain: deps.brain,
          reassignModels: config.fallbackModels,
          generateSubtasks: makeLlmSubtaskGenerator({
            run: (prompt) => deps.runIsolatedTurn!(prompt, 'Task Splitter'),
          }),
          requestLlmVerdict: true,
        }).superviseFailure
      : deps.brain
        ? new SddSupervisor({
            brain: deps.brain,
            reassignModels: config.fallbackModels,
            requestLlmVerdict: true,
          }).superviseFailure
        : undefined;

  return startSddRun({
    tracker: runTracker,
    graph,
    agent: deps.agent,
    projectRoot: deps.projectRoot,
    events: deps.events,
    sessionId: () => deps.agent.ctx.session?.id,
    subagentFactory: deps.subagentFactory,
    boardStore: new SddBoardStore({ baseDir: deps.projectSddBoards }),
    registry: deps.registry ?? new SddRunRegistry(),
    // Composite completion gate: the deterministic command check always runs;
    // the LLM acceptance-criteria judge is added only when an isolated-turn
    // runner exists (it degrades open on judge errors, so it can't wedge runs).
    verifyTask: deps.runIsolatedTurn
      ? makeCompositeVerifier([
          makeCommandVerifier(),
          makeAcceptanceCriteriaVerifier({
            run: (prompt) => deps.runIsolatedTurn!(prompt, 'Acceptance Reviewer'),
          }),
        ])
      : makeCommandVerifier(),
    ...(superviseFailure ? { superviseFailure } : {}),
    ...(config.parallelSlots !== undefined ? { parallelSlots: config.parallelSlots } : {}),
    ...(config.defaultModel !== undefined ? { defaultModel: config.defaultModel } : {}),
    ...(config.defaultProvider !== undefined ? { defaultProvider: config.defaultProvider } : {}),
    ...(config.fallbackModels !== undefined ? { fallbackModels: config.fallbackModels } : {}),
    ...(worktrees ? { worktrees } : {}),
  });
}

export interface SddWizardWiringOptions {
  /** Leader agent — seeds the run's default factory + project context. */
  agent: Agent;
  /** Shared EventBus — the board projector emits sdd.board.snapshot on it. */
  events: EventBus;
  projectRoot: string;
  /** Per-task agent factory: CLI's director-backed one, or the runtime light one. */
  subagentFactory: AgentFactory;
  /**
   * Decision authority for the failure supervisor (the server's bound
   * TOKENS.BrainArbiter). Omit to run without a supervisor (plain terminal-fail,
   * matching a bare run) — but parity with the CLI wants it wired.
   */
  brain?: BrainArbiter | undefined;
  /** Persisted-store directories (from resolveWstackPaths). */
  paths: {
    projectSpecs: string;
    projectTaskGraphs: string;
    projectSddBoards: string;
    projectDir: string;
  };
}

/**
 * Build the {@link SddWizardDeps} shared by both webui servers from a single
 * per-task `subagentFactory`. The factory drives BOTH the interview agent (an
 * isolated turn off the main chat bus) and the real multi-agent run, so each
 * server only has to supply the right factory for its process.
 */
/**
 * Prepended to every isolated interview/splitter turn. Keeps the spec interview
 * a pure planning conversation — no file writes, no shell — regardless of how
 * "implement"-flavoured the underlying phase prompt reads.
 */
const PLANNING_ONLY_GUARD =
  'SYSTEM: You are running a PLANNING-ONLY specification interview. Do NOT write, ' +
  'create, or edit any files, and do NOT run shell/terminal commands or use any ' +
  'code-editing tools — they are disabled here and any attempt will fail and waste ' +
  'the turn. Respond with TEXT ONLY: ask your question, or emit the requested spec / ' +
  'plan / task JSON. All code is written later, automatically, once the plan is ' +
  'approved and the multi-agent run starts.\n\n---\n\n';

export function buildSddWizardDeps(opts: SddWizardWiringOptions): SddWizardDeps {
  const registry = new SddRunRegistry();
  let isolatedSeq = 0;

  /**
   * Run one self-contained, read-only LLM turn on a fresh isolated agent (off the
   * main chat bus). Shared by the interview and the supervisor's subtask splitter:
   * both feed a self-embedding prompt, want no shared context, and must NOT edit
   * the repo (restricted to the read-only capability floor; the execute phase is
   * where writes happen). The factory's per-turn cleanup is invoked here because
   * we drive it directly, not via makeAgentSubagentRunner.
   *
   * The interview is PLANNING-ONLY: it must never write code. The read-only
   * capability floor already denies fs.write/shell, but a capable model will
   * still *attempt* a write/bash call when the implementation-planning prompt
   * mentions "implement" — the call then fails and derails the turn. So we belt-
   * and-suspenders it: (1) disable the mutating tools by name, and (2) prepend an
   * explicit text guard so the agent never even tries. Code is written later, by
   * the real run, after the plan is approved.
   */
  const runIsolatedTurn = async (prompt: string, name: string): Promise<string> => {
    const result = await opts.subagentFactory({
      id: `sdd-${name.toLowerCase().replace(/\s+/g, '-')}-${isolatedSeq++}`,
      role: 'executor',
      name,
      disabledTools: ['delegate', 'write', 'edit', 'patch', 'bash', 'exec'],
      allowedCapabilities: ['fs.read', 'net.outbound'],
    });
    try {
      const res = await result.agent.run([{ type: 'text', text: PLANNING_ONLY_GUARD + prompt }]);
      return res.finalText ?? '';
    } finally {
      await result.dispose?.();
    }
  };

  return {
    makeDriver: () =>
      new SddInterviewDriver({
        specStore: new SpecStore({ baseDir: opts.paths.projectSpecs }),
        graphStore: new TaskGraphStore({ baseDir: opts.paths.projectTaskGraphs }),
        sessionPath: path.join(opts.paths.projectDir, 'sdd-wizard-session.json'),
      }),

    runInterviewTurn: (prompt: string): Promise<string> => runIsolatedTurn(prompt, 'Spec Architect'),

    startRun: async (
      driver,
      { parallelSlots, defaultModel, defaultProvider, fallbackModels, worktrees: useWorktrees },
    ) => {
      const graph = driver.getGraph();
      const tracker = driver.getTracker();
      if (!graph || !tracker) {
        throw new ToolValidationError({
          message: 'No task graph to run — finish the interview first.',
          field: 'taskGraph',
        });
      }

      // Shared with launch-from-board: builds worktrees + verifier + supervisor
      // and defers to startSddRun (parity with the CLI /sdd parallel path).
      const handle = await startSddRunFromGraph(
        graph,
        {
          agent: opts.agent,
          events: opts.events,
          projectRoot: opts.projectRoot,
          subagentFactory: opts.subagentFactory,
          projectSddBoards: opts.paths.projectSddBoards,
          registry,
          runIsolatedTurn,
          ...(opts.brain ? { brain: opts.brain } : {}),
        },
        {
          ...(parallelSlots !== undefined ? { parallelSlots } : {}),
          ...(defaultModel !== undefined ? { defaultModel } : {}),
          ...(defaultProvider !== undefined ? { defaultProvider } : {}),
          ...(fallbackModels !== undefined ? { fallbackModels } : {}),
          ...(useWorktrees !== undefined ? { worktrees: useWorktrees } : {}),
        },
        tracker,
      );
      // The board surfaces progress (events + disk); we don't block the wizard
      // on completion. Swallow rejections so a failed run can't crash the server.
      void handle.completion.catch(() => {});
      return { runId: handle.runId };
    },
  };
}
