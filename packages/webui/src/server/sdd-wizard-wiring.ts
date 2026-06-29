import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  type Agent,
  type AgentFactory,
  type BrainArbiter,
  cleanupStaleSddWorktrees,
  type EventBus,
  makeCommandVerifier,
  makeLlmSubtaskGenerator,
  SddBoardStore,
  SddInterviewDriver,
  SddRunRegistry,
  SddSupervisor,
  SpecStore,
  startSddRun,
  TaskGraphStore,
  WorktreeManager,
  ToolValidationError,
} from '@wrongstack/core';
import type { SddWizardDeps } from './sdd-wizard-ws-handler.js';

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

      // Per-task git-worktree isolation. The per-run UI toggle wins; when it is
      // omitted we fall back to the env default (disable with
      // WRONGSTACK_SDD_WORKTREES=0). Mirrors the CLI /sdd execute path.
      const worktreesEnabled = useWorktrees ?? process.env['WRONGSTACK_SDD_WORKTREES'] !== '0';
      let worktrees: WorktreeManager | undefined;
      if (worktreesEnabled) {
        const inGit =
          spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
            cwd: opts.projectRoot,
            encoding: 'utf8',
            windowsHide: true,
          }).stdout?.trim() === 'true';
        if (inGit) {
          // Clean slate: sweep any orphaned worktrees/branches a prior crashed or
          // abandoned run left behind BEFORE this run allocates. Liveness-guarded
          // so it never touches a run that is still live in another process.
          await cleanupStaleSddWorktrees({
            projectRoot: opts.projectRoot,
            boardsDir: opts.paths.projectSddBoards,
          }).catch(() => undefined);
          worktrees = new WorktreeManager({
            projectRoot: opts.projectRoot,
            events: opts.events,
            sessionId: () => opts.agent.ctx.session?.id,
          });
        }
      }

      const boardStore = new SddBoardStore({ baseDir: opts.paths.projectSddBoards });

      // Parity with the CLI `/sdd parallel` path: gate completion on a per-task
      // verificationCommand and let the Brain rescue a retry-exhausted task
      // instead of dead-ending. Both are shared with cli-main.ts.
      const verifyTask = makeCommandVerifier();
      const superviseFailure = opts.brain
        ? new SddSupervisor({
            brain: opts.brain,
            // The run-level fallback chain (chosen in the wizard) doubles as the
            // supervisor's reassign options — a `reassign` verdict rotates the
            // worker model on retry. Empty/undefined → reassign option dropped.
            reassignModels: fallbackModels,
            // LLM auto-split: decompose a retry-exhausted task into smaller
            // sub-tasks on an isolated read-only turn. Heavily validated +
            // bounded; an empty result degrades the split into a retry.
            generateSubtasks: makeLlmSubtaskGenerator({
              run: (prompt) => runIsolatedTurn(prompt, 'Task Splitter'),
            }),
            // The standalone brain is a tiered policy→LLM arbiter with NO
            // human-escalation wrapper (see index.ts), so it never blocks on a
            // human prompt — an unresolved verdict degrades to a bounded retry.
            // Safe to let the LLM layer actually pick reassign/split.
            requestLlmVerdict: true,
          }).superviseFailure
        : undefined;

      const handle = startSddRun({
        tracker,
        graph,
        agent: opts.agent,
        projectRoot: opts.projectRoot,
        events: opts.events,
        sessionId: () => opts.agent.ctx.session?.id,
        subagentFactory: opts.subagentFactory,
        worktrees,
        boardStore,
        registry,
        parallelSlots,
        defaultModel,
        defaultProvider,
        fallbackModels,
        verifyTask,
        superviseFailure,
      });
      // The board surfaces progress (events + disk); we don't block the wizard
      // on completion. Swallow rejections so a failed run can't crash the server.
      void handle.completion.catch(() => {});
      return { runId: handle.runId };
    },
  };
}
