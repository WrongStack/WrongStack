import * as path from 'node:path';
import type { Agent } from '@wrongstack/core/agent';
import type { AgentFactory, BrainArbiter } from '@wrongstack/core/coordination';
import type { EventBus } from '@wrongstack/core/kernel';
import { DefaultTaskStore, type TaskStore, TaskTracker } from '@wrongstack/core/tasking';
import type { TaskGraph } from '@wrongstack/core/types';
import { ToolValidationError } from '@wrongstack/core/types';
import { WorktreeManager } from '@wrongstack/core/worktree';
import {
  cleanupStaleSddWorktrees,
  createKanbanSddSessionPersistence,
  decomposeNonAtomicTasks,
  gatherProjectContext,
  makeAcceptanceCriteriaVerifier,
  makeCommandVerifier,
  makeCompositeVerifier,
  makeLlmSubtaskGenerator,
  makePlanningDecomposer,
  SddBoardStore,
  SddInterviewDriver,
  type SddRunHandle,
  SddRunRegistry,
  SddSupervisor,
  SpecStore,
  startSddRun,
  TaskGraphStore,
} from '@wrongstack/sdd';
import { isGitWorkTree } from './git-process.js';
import type { SddRunStartOpts, SddWizardDeps } from './sdd-wizard-ws-handler.js';

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
  /** Persist task status transitions so a replacement process can resume. */
  taskStore?: TaskStore | undefined;
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
      const t = new TaskTracker({ store: deps.taskStore ?? new DefaultTaskStore() });
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
      stateTransport: 'kanban',
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
    /** Legacy interview session file imported into project workflow state. */
    projectSddSession?: string | undefined;
  };
}

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

/**
 * Build the {@link SddWizardDeps} shared by both webui servers from a single
 * per-task `subagentFactory`. Gathers project context asynchronously (exposed
 * via `ensureReady`) so the first interview turn always sees package/src layout.
 */
export function buildSddWizardDeps(opts: SddWizardWiringOptions): SddWizardDeps {
  const registry = new SddRunRegistry();
  let isolatedSeq = 0;
  let projectContext = '';
  const contextReady = gatherProjectContext(opts.projectRoot)
    .then((ctx) => {
      projectContext = ctx;
    })
    .catch(() => {
      projectContext = '';
    });

  // Legacy session files are imported once; project-scoped IPC owns all new
  // interview state shared by CLI and standalone WebUI.
  const legacySessionPath =
    opts.paths.projectSddSession ?? path.join(opts.paths.projectDir, 'sdd-session.json');
  const sessionPersistence = createKanbanSddSessionPersistence(opts.projectRoot, legacySessionPath);
  const specStore = new SpecStore({ baseDir: opts.paths.projectSpecs });
  const graphStore = new TaskGraphStore({ baseDir: opts.paths.projectTaskGraphs });

  /**
   * Run one self-contained, read-only LLM turn on a fresh isolated agent (off the
   * main chat bus). Shared by the interview and the supervisor's subtask splitter.
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

  const makeDriver = (): SddInterviewDriver =>
    new SddInterviewDriver({
      specStore,
      graphStore,
      sessionPersistence,
      projectContext,
    });

  const launchFromGraph = async (
    graph: TaskGraph,
    config: SddRunStartOpts,
    tracker?: TaskTracker,
  ): Promise<{ runId: string }> => {
    const handle = await startSddRunFromGraph(
      graph,
      {
        agent: opts.agent,
        events: opts.events,
        projectRoot: opts.projectRoot,
        subagentFactory: opts.subagentFactory,
        projectSddBoards: opts.paths.projectSddBoards,
        taskStore: graphStore,
        registry,
        runIsolatedTurn,
        ...(opts.brain ? { brain: opts.brain } : {}),
      },
      {
        ...(config.parallelSlots !== undefined ? { parallelSlots: config.parallelSlots } : {}),
        ...(config.defaultModel !== undefined ? { defaultModel: config.defaultModel } : {}),
        ...(config.defaultProvider !== undefined
          ? { defaultProvider: config.defaultProvider }
          : {}),
        ...(config.fallbackModels !== undefined ? { fallbackModels: config.fallbackModels } : {}),
        ...(config.worktrees !== undefined ? { worktrees: config.worktrees } : {}),
        ...(config.planDecompose !== undefined ? { planDecompose: config.planDecompose } : {}),
      },
      tracker,
    );
    void handle.completion.catch(() => {});
    return { runId: handle.runId };
  };

  return {
    makeDriver,
    ensureReady: () => contextReady,

    runInterviewTurn: (prompt: string): Promise<string> =>
      runIsolatedTurn(prompt, 'Spec Architect'),

    startRun: async (driver, config) => {
      const graph = driver.getGraph();
      const tracker = driver.getTracker();
      if (!graph || !tracker) {
        throw new ToolValidationError({
          message: 'No task graph to run — finish the interview first.',
          field: 'taskGraph',
        });
      }
      return launchFromGraph(graph, config, tracker);
    },

    startRunFromGraphId: async (graphId, config) => {
      const graph = await graphStore.load(graphId);
      if (!graph) {
        throw new ToolValidationError({
          message: `Task graph not found: ${graphId}`,
          field: 'graphId',
        });
      }
      return launchFromGraph(graph, config);
    },

    resolveGraphIdForSpec: async (specId) => {
      const entry = (await graphStore.list()).find((g) => g.specId === specId);
      return entry?.id ?? null;
    },
  };
}
