/**
 * AutoPhase host wiring for the CLI.
 *
 * Turns a free-text goal into a real, LLM-driven phase run:
 *   1. PLAN   — a one-shot subagent generates a phase-by-phase plan where each
 *               phase carries many concrete todos (AutoPhasePlanner).
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

import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Async `fs.access`-style existence check — never throws. */
async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}
import {
  assignNickname,
  AutoPhasePlanner,
  type BrainArbiter,
  buildChildEnv,
  type Config,
  type EventBus,
  type PhaseGraph,
  PhaseGraphBuilder,
  PhaseOrchestrator,
  type PhaseProgress,
  PhaseStore,
  type TaskNode,
  WorktreeManager,
} from '@wrongstack/core';

/** Default concurrent tasks within a single phase (override via env). */
const DEFAULT_TASK_CONCURRENCY = 2;

/** Resolve per-phase task concurrency from env, clamped to a sane range. */
function resolveTaskConcurrency(): number {
  const raw = Number.parseInt(process.env['WRONGSTACK_AUTOPHASE_TASK_CONCURRENCY'] ?? '', 10);
  if (!Number.isFinite(raw)) return DEFAULT_TASK_CONCURRENCY;
  return Math.min(8, Math.max(1, raw));
}
import type { MultiAgentHost } from './multi-agent.js';

/** Default parallel-phase concurrency once worktree isolation is available. */
const WORKTREE_PHASE_CONCURRENCY = 4;

/**
 * Cap on captured command output. Verification commands (`pnpm test` across
 * a large monorepo) can emit tens of MB on a verbose run — accumulating the
 * full transcript spikes the host heap for output nothing ever reads in
 * full. runCmd keeps the TAIL (the failure summary lives at the end of a
 * test run); gitText keeps the head (its commands are tiny).
 */
const MAX_CMD_OUTPUT = 200_000;

/** Run a git command, returning trimmed stdout (empty string on failure). */
function gitText(args: string[], cwd: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('git', args, {
        cwd,
        env: buildChildEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
        signal: AbortSignal.timeout(10_000),
        windowsHide: true,
      });
    } catch (err) {
      // spawn throws synchronously when git is not installed.
      reject(err);
      return;
    }
    const chunks: string[] = [];
    let total = 0; // running length — avoids an O(n²) chunks.join() per data event
    const emit = (c: Buffer) => {
      if (total < MAX_CMD_OUTPUT) {
        const s = c.toString();
        chunks.push(s);
        total += s.length;
      }
    };
    child.stdout?.on('data', emit);
    child.stderr?.on('data', emit);
    child.on('error', () => resolve({ code: 1, out: chunks.join('') }));
    child.on('close', (code) => resolve({ code: code ?? 1, out: chunks.join('').trim() }));
  });
}

async function isGitRepo(cwd: string): Promise<boolean> {
  const { code, out } = await gitText(['rev-parse', '--is-inside-work-tree'], cwd);
  return code === 0 && out.trim() === 'true';
}

// Commands allowed for autonomous autophase verification. Intentionally NARROW:
// autophase runs WITHOUT user confirmation, so its base set is just the
// package-manager script runners — far narrower than the `exec` tool's default
// allowlist (which includes build tools like go/cargo/make that execute
// arbitrary build scripts; fine when each call is user-confirmed, not for
// autonomous runs).
const AUTOPHASE_BASE_SAFE_CMDS: ReadonlySet<string> = new Set(['pnpm', 'npm', 'yarn', 'bun']);

// Effective autonomous allowlist = base ∪ the user's EXPLICIT trusted
// `tools.exec.allow` − `tools.exec.deny`. We extend by the user's explicit
// opt-ins only (not exec's broadened defaults), and only from trusted config —
// `tools.exec.allow` is stripped from untrusted in-project repo config by the
// config loader, so a repo cannot widen what runs autonomously here.
let autophaseAllowed: Set<string> = new Set(AUTOPHASE_BASE_SAFE_CMDS);

/**
 * Extend/trim the autonomous autophase command allowlist from the user's exec
 * policy. Mirrors `configureExecPolicy` but keeps autophase's narrower base.
 * Idempotent (always rebuilt from the base).
 */
export function configureAutophasePolicy(
  opts: { allow?: readonly string[] | undefined; deny?: readonly string[] | undefined } = {},
): void {
  const next = new Set(AUTOPHASE_BASE_SAFE_CMDS);
  for (const c of opts.allow ?? []) {
    const n = c.trim();
    if (n) next.add(n);
  }
  for (const c of opts.deny ?? []) next.delete(c.trim());
  autophaseAllowed = next;
}

/** Reset the autophase allowlist to its built-in base (tests / re-init). */
export function resetAutophasePolicy(): void {
  autophaseAllowed = new Set(AUTOPHASE_BASE_SAFE_CMDS);
}

/** Whether `cmd` may run in autonomous autophase verification. */
export function isAutophaseCommandAllowed(cmd: string): boolean {
  return autophaseAllowed.has(cmd.trim());
}

// Destructive shell patterns that must never execute autonomously.
// Mirrors the yolo-risk.ts pattern set for autophase context.
const DESTRUCTIVE_PATTERNS: readonly RegExp[] = [
  /\brm\s+-rf\s+\//,
  /\bdangerously\s+(?:force|reset|--hard)\b/,
  /\bgit\s+clean\s+-[xdf]{2,}/,
  /\bgit\s+reset\s+--hard\b/,
  /([;&|]\s*)(?!\s*$)/, // command chaining (; && || |)
  /`[^`]+`/, // backtick subshell
  /\$\(/, // $(...) subshell
];

/** Run an arbitrary command, capturing combined stdout+stderr. */
function runCmd(
  cmd: string,
  args: string[],
  cwd: string,
  shell = false,
): Promise<{ code: number; out: string }> {
  // ── allowlist gate ──────────────────────────────────────────────────
  if (!isAutophaseCommandAllowed(cmd)) {
    return Promise.resolve({
      code: 1,
      out:
        `autophase: command "${cmd}" not in autonomous safe-commands allowlist. ` +
        `Allowed: ${[...autophaseAllowed].join(', ')}. ` +
        `Add it to tools.exec.allow in ~/.wrongstack/config.json (trusted config only), ` +
        `or set WRONGSTACK_AUTOPHASE_VERIFY_CMD to an allowed command.`,
    });
  }

  // ── destructive-pattern gate ────────────────────────────────────────
  const fullCmd = [cmd, ...args].join(' ');
  for (const pat of DESTRUCTIVE_PATTERNS) {
    if (pat.test(fullCmd)) {
      return Promise.resolve({
        code: 1,
        out: `autophase: rejected destructive command pattern: ${fullCmd}`,
      });
    }
  }

  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    let child;
    try {
      child = spawn(cmd, args, {
        cwd,
        env: buildChildEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
        // Pass through explicitly — allowlist validation already runs above,
        // so the caller's shell preference is authoritative.
        shell,
        signal: AbortSignal.timeout(30_000),
        windowsHide: true,
      });
    } catch (err) {
      reject(err);
      return;
    }
    // Tail-keep: a failing `pnpm test` prints its summary at the end, which
    // is what the verify failure message feeds back to the agent.
    const append = (c: Buffer) => {
      chunks.push(c.toString());
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.on('error', (e) => resolve({ code: 1, out: `${chunks.join('')}${String(e)}` }));
    child.on('close', (code) => {
      let out = chunks.join('');
      if (out.length > MAX_CMD_OUTPUT) out = out.slice(-MAX_CMD_OUTPUT);
      resolve({ code: code ?? 1, out: out.trim() });
    });
  });
}

/**
 * Detect the project's package manager from lockfiles at the repo root.
 * Async so the verify-step boot path doesn't block the event loop on `stat`
 * for missing files in CWD or in monorepo setups where the lockfile lives
 * several levels up.
 */
async function detectPackageManager(root: string): Promise<string> {
  // Probe all three in parallel — every branch is a single stat each, and the
  // failure mode for a missing file is identical (EACCES/ENOENT). The first
  // hit wins; we don't care which one because only one lockfile is canonical
  // per project.
  const [pnpm, yarn, bun] = await Promise.all([
    pathExists(join(root, 'pnpm-lock.yaml')),
    pathExists(join(root, 'yarn.lock')),
    pathExists(join(root, 'bun.lockb')),
  ]);
  if (pnpm) return 'pnpm';
  if (yarn) return 'yarn';
  if (bun) return 'bun';
  return 'npm';
}

/** Read package.json scripts for a directory (empty on any failure). */
async function readScripts(cwd: string): Promise<Record<string, string>> {
  try {
    const raw = await readFile(join(cwd, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
    return pkg.scripts ?? {};
  } catch {
    return {};
  }
}

export interface AutoPhaseHostDeps {
  multiAgentHost: MultiAgentHost;
  /** Read the *current* Config lazily (it may be patched, e.g. YOLO toggles). */
  getConfig: () => Config;
  /** Shared app EventBus — orchestrator events feed the TUI PhaseMonitor. */
  events: EventBus;
  /** Current parent session id for worktree lifecycle events. */
  getSessionId?: (() => string | undefined) | undefined;
  /** Directory for per-project phase-graph JSON (wpaths.projectAutophase). */
  storeDir: string;
  /** Project root — base for git-worktree isolation. */
  projectRoot: string;
  /**
   * Enable per-phase git-worktree isolation (default true). When on and the
   * project is a git repo, parallelizable phases run in isolated worktrees and
   * merge back sequentially. Disable with WRONGSTACK_AUTOPHASE_WORKTREES=0.
   */
  worktrees?: boolean | undefined;
  /** Max parallel phases when worktrees are active (default 4). */
  maxConcurrentPhases?: number | undefined;
  /** Optional global Brain arbiter for AutoPhase policy decisions. */
  brain?: BrainArbiter | undefined;
  /** Optional progress logger (rendered to the user during start). */
  log?: ((line: string) => void) | undefined;
}

/** A live, read-only view of the running AutoPhase, exposed to slash commands. */
export interface AutoPhaseRunnerView {
  graph: PhaseGraph;
  getProgress: () => PhaseProgress | null;
  isRunning: () => boolean;
}

export type AutoPhaseStartResult = { ok: true; graph: PhaseGraph } | { ok: false; error: string };

export interface AutoPhaseHostHooks {
  onAutoPhaseStart: (opts: {
    goal: string;
    projectContext?: string | undefined;
  }) => Promise<AutoPhaseStartResult>;
  onAutoPhasePause: () => void;
  onAutoPhaseResume: () => void;
  onAutoPhaseStop: () => void;
  getAutoPhaseRunner: () => AutoPhaseRunnerView | null;
  /** Interactive board: move a task to another phase. */
  onAutoPhaseMoveTask: (taskId: string, toPhaseId: string) => boolean;
  /** Interactive board: (re)assign a task to a specific agent (clear with both omitted). */
  onAutoPhaseAssignTask: (taskId: string, agentId?: string, agentName?: string) => boolean;
  /** Interactive board: add a new task to a phase. Returns the new task id. */
  onAutoPhaseAddTask: (
    phaseId: string,
    spec: { title: string; description?: string; type?: TaskNode['type']; priority?: TaskNode['priority'] },
  ) => string | null;
  /** Interactive board: requeue a task to pending so it (re)runs. */
  onAutoPhaseRetryTask: (taskId: string) => boolean;
  /** Backs the /worktree slash command (list / merge / prune / clean). */
  onWorktree: (action: 'list' | 'merge' | 'prune' | 'clean', target?: string) => Promise<string>;
}

interface ActiveRun {
  graph: PhaseGraph;
  orchestrator: PhaseOrchestrator;
  abort: AbortController;
  unsubscribe: () => void;
}

/** Minimal shape of an agent.run result we depend on. */
interface RunResult {
  status: string;
  finalText?: string | undefined;
  error?: { message?: string | undefined };
}

export function createAutoPhaseHost(deps: AutoPhaseHostDeps): AutoPhaseHostHooks {
  const store = new PhaseStore({ baseDir: deps.storeDir });
  let active: ActiveRun | null = null;
  const log = deps.log ?? (() => {});

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

  function buildTaskPrompt(task: TaskNode, phaseName: string, goal: string): string {
    return [
      `You are executing one task inside an autonomous, phase-based build.`,
      `Overall goal: ${goal}`,
      `Current phase: ${phaseName}`,
      '',
      `TASK: ${task.title}`,
      task.description ? `Details: ${task.description}` : '',
      `Type: ${task.type} · Priority: ${task.priority}`,
      '',
      `Do the work now using your tools (read, edit, write, bash, …). Make the`,
      `change real — do not just describe it. When finished, end with a one-line`,
      `summary of what you changed. If the task is impossible or already done,`,
      `say so explicitly.`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  function buildRepairPrompt(phaseName: string, failure: string, goal: string): string {
    return [
      `You are repairing a FAILED verification inside an autonomous, phase-based build.`,
      `Overall goal: ${goal}`,
      `Phase: ${phaseName}`,
      '',
      `The phase's code changes were applied, but verification (typecheck/lint)`,
      `failed in this working directory. Verifier output:`,
      '```',
      failure.slice(0, 4000),
      '```',
      '',
      `Fix the code in THIS working directory so verification passes. Use your tools`,
      `(read, edit, write, bash). Fix the root cause — do NOT delete code, weaken`,
      `types, or disable lint rules just to silence the error. When finished, end`,
      `with a one-line summary of what you changed.`,
    ].join('\n');
  }

  function buildConflictPrompt(files: string[], goal: string): string {
    const fileList = files.length
      ? files.map((f) => `  - ${f}`).join('\n')
      : '  (run `git diff --check` or search for "<<<<<<<" to find them)';
    return [
      `A git squash-merge hit conflicts while integrating an autonomous build phase`,
      `into the base branch. Overall goal: ${goal}`,
      '',
      `These files contain conflict markers (<<<<<<<, =======, >>>>>>>) in the`,
      `current working directory:`,
      fileList,
      '',
      `Resolve every conflict by correctly combining BOTH sides — keep the intent of`,
      `the base branch AND the phase's changes; do not blindly discard either side.`,
      `Remove all conflict markers from every affected file. Do NOT run \`git commit\``,
      `or \`git add\` — just leave the resolved files on disk. If a conflict cannot be`,
      `resolved safely, say so explicitly. End with a one-line summary.`,
    ].join('\n');
  }

  /**
   * Verify a phase's working tree. Runs the project's `typecheck` + `lint` scripts
   * (or a custom `WRONGSTACK_AUTOPHASE_VERIFY_CMD`) in `cwd`. Returns ok:true when
   * all pass, or when verification cannot meaningfully run (no deps / no scripts) —
   * the gate never blocks on things it can't actually check.
   */
  async function runVerify(cwd: string): Promise<{ ok: boolean; output?: string | undefined }> {
    // Script commands need resolvable node_modules. A nested git worktree resolves
    // upward to the repo-root node_modules, so accept either location.
    if (
      !(await pathExists(join(cwd, 'node_modules'))) &&
      !(await pathExists(join(deps.projectRoot, 'node_modules')))
    ) {
      return { ok: true, output: 'verify skipped: node_modules not found' };
    }

    const custom = process.env['WRONGSTACK_AUTOPHASE_VERIFY_CMD']?.trim();
    if (custom) {
      const res = await runCmd(custom, [], cwd, true);
      return res.code === 0
        ? { ok: true }
        : { ok: false, output: `[verify] exited ${res.code}\n${res.out}` };
    }

    const pm = await detectPackageManager(deps.projectRoot);
    const scripts = await readScripts(cwd);
    const steps = (['typecheck', 'lint'] as const).filter((s) => typeof scripts[s] === 'string');
    if (steps.length === 0) return { ok: true, output: 'verify skipped: no typecheck/lint script' };

    for (const step of steps) {
      const res = await runCmd(pm, ['run', step], cwd);
      if (res.code !== 0) {
        return { ok: false, output: `[${step}] exited ${res.code}\n${res.out}` };
      }
    }
    return { ok: true };
  }

  async function persist(graph: PhaseGraph): Promise<void> {
    try {
      await store.save(graph);
    } catch (err) {
      log(`⚠ AutoPhase save failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    async onAutoPhaseStart({ goal, projectContext }): Promise<AutoPhaseStartResult> {
      if (active?.orchestrator.isRunning()) {
        return {
          ok: false,
          error: 'An AutoPhase run is already in progress. Use /autophase stop first.',
        };
      }

      const abort = new AbortController();
      // Stable per-run worker identities, so the board can show "who is on what".
      const usedNicknames = new Set<string>();

      // 1) PLAN
      log(`🧠 Planning phases for: ${goal}`);
      let phases;
      try {
        const planner = new AutoPhasePlanner({
          goal,
          projectContext,
          runOnce: (p) => runOnce(p, 'autophase-planner', abort.signal),
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
      log(`📋 Plan ready: ${phases.length} phases, ${todoCount} todos.`);

      // 2) BUILD + persist
      const graph = await new PhaseGraphBuilder({
        title: goal,
        phases,
        autonomous: true,
      }).build();
      await persist(graph);

      // Per-phase git-worktree isolation. When enabled and inside a git repo,
      // each phase runs in its own worktree+branch so parallelizable phases
      // execute concurrently and merge back sequentially. Otherwise fall back
      // to the legacy single-tree, single-phase, single-task behavior.
      const worktreesEnabled =
        deps.worktrees !== false && process.env['WRONGSTACK_AUTOPHASE_WORKTREES'] !== '0';
      let worktrees: WorktreeManager | undefined;
      if (worktreesEnabled && (await isGitRepo(deps.projectRoot))) {
        worktrees = new WorktreeManager({
          projectRoot: deps.projectRoot,
          events: deps.events,
          sessionId: deps.getSessionId,
        });
        log(
          `🌿 Worktree isolation on — up to ${deps.maxConcurrentPhases ?? WORKTREE_PHASE_CONCURRENCY} phases run in parallel.`,
        );
      }

      // Per-phase verification gate. After a phase's todos all succeed, run the
      // project's typecheck/lint in the phase worktree before merging; on failure
      // a repair subagent gets the output and fixes the tree, then we re-verify.
      // Disable with WRONGSTACK_AUTOPHASE_VERIFY=0.
      const verifyEnabled = process.env['WRONGSTACK_AUTOPHASE_VERIFY'] !== '0';
      if (verifyEnabled) {
        log(`🔎 Verify gate on — phases must pass typecheck/lint before merging.`);
      }

      // Merge-conflict resolution. Only meaningful with worktree isolation (the
      // only path that merges). On conflict a resolver subagent edits the base
      // tree to clear the markers; if it fails the worktree is parked for review
      // as before. Disable with WRONGSTACK_AUTOPHASE_RESOLVE=0.
      const resolveEnabled = !!worktrees && process.env['WRONGSTACK_AUTOPHASE_RESOLVE'] !== '0';

      // 3) RUN (background)
      const orchestrator = new PhaseOrchestrator({
        graph,
        ctx: {
          executeTask: async (task, phaseId, env) => {
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
              `autophase-${agentName}`.slice(0, 48),
              abort.signal,
              env?.cwd,
            );
          },
          verifyPhase: verifyEnabled
            ? async (_phase, env) => runVerify(env?.cwd ?? deps.projectRoot)
            : undefined,
          repairPhase: verifyEnabled
            ? async (phase, failure, attempt, env) => {
                log(`🔧 Repairing "${phase.name}" (attempt ${attempt}) after verify failure…`);
                await runOnce(
                  buildRepairPrompt(phase.name, failure, goal),
                  `autophase-repair-${phase.name}`.slice(0, 48),
                  abort.signal,
                  env?.cwd,
                );
              }
            : undefined,
          resolveConflict: resolveEnabled
            ? async (_phase, info) => {
                log(`🔀 Resolving merge conflict in ${info.conflictFiles.length} file(s)…`);
                try {
                  await runOnce(
                    buildConflictPrompt(info.conflictFiles, goal),
                    'autophase-conflict',
                    abort.signal,
                    info.cwd,
                  );
                  return true;
                } catch {
                  return false;
                }
              }
            : undefined,
          brain: deps.brain,
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
        // Within a phase, todos share the phase worktree. Default to a small
        // amount of parallelism so multiple agents genuinely pick up different
        // tasks at once (visible on the board); raise/lower via
        // WRONGSTACK_AUTOPHASE_TASK_CONCURRENCY (1 = strictly sequential).
        maxConcurrentTasks: resolveTaskConcurrency(),
      });

      // Re-persist on terminal graph events. NOTE: call through `deps.events`
      // as the receiver — detaching the method (`const f = deps.events.on`)
      // loses `this`, and EventBus.on/off are plain prototype methods, so the
      // detached call throws "Cannot read properties of undefined (reading
      // 'listeners')". The arrow wrappers keep `this` bound to the bus.
      const busOn = deps.events as unknown as {
        on(event: string, handler: (payload: unknown) => void): void;
        off(event: string, handler: (payload: unknown) => void): void;
      };
      const onUntyped = (event: string, handler: (payload: unknown) => void): void =>
        busOn.on(event, handler);
      const offUntyped = (event: string, handler: (payload: unknown) => void): void =>
        busOn.off(event, handler);
      const finalizeActiveRun = () => {
        if (active?.graph.id !== graph.id) return;
        active.unsubscribe();
        active = null;
      };
      const onDone = () => {
        log(`🎉 AutoPhase complete: ${graph.title}`);
        void persist(graph);
        finalizeActiveRun();
      };
      const onFailed = () => {
        void persist(graph);
        finalizeActiveRun();
      };
      onUntyped('graph.completed', onDone);
      onUntyped('graph.failed', onFailed);
      const unsubscribe = () => {
        offUntyped('graph.completed', onDone);
        offUntyped('graph.failed', onFailed);
      };

      active = { graph, orchestrator, abort, unsubscribe };

      // Fire-and-forget: orchestrator.start() resolves only when the whole
      // graph finishes, so we must NOT await it here or the slash command
      // would block until the entire project is built.
      void orchestrator.start().catch((err) => {
        log(`💥 AutoPhase aborted: ${err instanceof Error ? err.message : String(err)}`);
        void persist(graph);
        finalizeActiveRun();
      });

      return { ok: true, graph };
    },

    onAutoPhasePause() {
      active?.orchestrator.pause();
    },

    onAutoPhaseResume() {
      active?.orchestrator.resume();
    },

    onAutoPhaseStop() {
      if (!active) return;
      active.abort.abort();
      active.orchestrator.stop();
      active.unsubscribe();
      void persist(active.graph);
      active = null;
    },

    getAutoPhaseRunner() {
      if (!active) return null;
      const a = active;
      return {
        graph: a.graph,
        getProgress: () => a.orchestrator.getProgress(),
        isRunning: () => a.orchestrator.isRunning(),
      };
    },

    onAutoPhaseMoveTask(taskId, toPhaseId) {
      if (!active) return false;
      const ok = active.orchestrator.moveTask(taskId, toPhaseId);
      if (ok) void persist(active.graph);
      return ok;
    },

    onAutoPhaseAssignTask(taskId, agentId, agentName) {
      if (!active) return false;
      const ok = active.orchestrator.setTaskAssignee(taskId, agentId, agentName);
      if (ok) void persist(active.graph);
      return ok;
    },

    onAutoPhaseAddTask(phaseId, spec) {
      if (!active) return null;
      const id = active.orchestrator.addTask(phaseId, spec);
      if (id) void persist(active.graph);
      return id;
    },

    onAutoPhaseRetryTask(taskId) {
      if (!active) return false;
      const ok = active.orchestrator.requeueTask(taskId);
      if (ok) void persist(active.graph);
      return ok;
    },

    async onWorktree(action, target) {
      const root = deps.projectRoot;
      if (!(await isGitRepo(root))) return '⚠ Not a git repository — worktrees unavailable.';

      switch (action) {
        case 'list': {
          const { out } = await gitText(['worktree', 'list'], root);
          return out || 'No worktrees.';
        }
        case 'prune': {
          await gitText(['worktree', 'prune'], root);
          const { out } = await gitText(['worktree', 'list'], root);
          return `Pruned stale worktree entries.\n${out}`;
        }
        case 'merge': {
          if (!target) return 'Usage: /worktree merge <branch>';
          if (target.startsWith('-')) return `Refusing unsafe branch name: ${target}`;
          const base = (await gitText(['rev-parse', '--abbrev-ref', 'HEAD'], root)).out || 'HEAD';
          await gitText(['merge', '--squash', target], root);
          const commit = await gitText(['commit', '-m', `merge ${target} (squash)`], root);
          if (commit.code !== 0 && !/nothing to commit/i.test(commit.out)) {
            await gitText(['reset', '--hard', 'HEAD'], root);
            return `⚠ Merge of "${target}" into ${base} hit conflicts and was rolled back.\n${commit.out}`;
          }
          return `✓ Merged "${target}" into ${base} (squash).`;
        }
        case 'clean': {
          // Remove all wstack-managed worktrees + branches.
          const list = (await gitText(['worktree', 'list', '--porcelain'], root)).out;
          const dirs = list
            .split('\n')
            .filter((l) => l.startsWith('worktree '))
            .map((l) => l.slice('worktree '.length))
            .filter((d) => d.includes('.wrongstack') && d.includes('worktrees'));
          for (const d of dirs) await gitText(['worktree', 'remove', '--force', d], root);
          await gitText(['worktree', 'prune'], root);
          const branches = (await gitText(['branch', '--list', 'wstack/ap/*'], root)).out
            .split('\n')
            .map((b) => b.replace(/^[*+]?\s*/, '').trim())
            .filter(Boolean);
          for (const b of branches) await gitText(['branch', '-D', b], root);
          return `🧹 Removed ${dirs.length} worktree(s) and ${branches.length} branch(es).`;
        }
        default:
          return `Unknown worktree action: ${action}`;
      }
    },
  };
}
