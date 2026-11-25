import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { resolveWstackPaths } from '@wrongstack/core/utils';
import { aggregateAll } from './aggregate.js';
import { computeHarnessFingerprint } from './fingerprint.js';
import {
  type BenchProfile,
  cleanupSandbox,
  createSandbox,
  LEAN_BENCH_TOOL_NAMES,
  prepareWorkdir,
} from './isolation.js';
import { type QualityReviewPolicy, reviewTranscript } from './quality-review.js';
import { mapWithConcurrency, runWstack } from './runner.js';
import { reapProcessesUnder, sandboxRootsFor } from './sandbox-reaper.js';
import { readSessionLogEvents, readTokenMetrics, readToolMetrics } from './session-metrics.js';
import { safePrefix } from './string-boundaries.js';
import { evaluateTraceEval } from './trace-eval.js';
import type {
  BenchConfig,
  BenchReport,
  BenchSuite,
  BenchTask,
  GradeResult,
  HarnessFingerprint,
  ModelCell,
  TaskResult,
} from './types.js';

export interface RunBenchmarkOptions {
  suite: BenchSuite;
  /** Suite-specific deterministic grader. */
  grade: (args: {
    workdir: string;
    task: BenchTask;
    cell: ModelCell;
    timeoutMs: number;
    /** Aborts with the run (Ctrl-C): kill the test command, the row is dropped. */
    signal?: AbortSignal | undefined;
  }) => Promise<GradeResult>;
  config: BenchConfig;
  reviewPolicy?: QualityReviewPolicy | undefined;
  cliVersion: string;
  /** Host tool names; lean runs always fingerprint LEAN_BENCH_TOOL_NAMES. */
  toolNames: string[];
  /** Tool names + schemas/descriptions/usage hints hash, when available. */
  toolManifestHash?: string | undefined;
  /** Built system prompt hash, when available. */
  systemPromptHash?: string | undefined;
  /**
   * Additional behavior-affecting config hash. When omitted the sandbox
   * computes one from the config the child CLI will actually read, so an
   * operator-local harness difference cannot masquerade as a model difference.
   */
  configHash?: string | undefined;
  /** Node executable. */
  nodeBin: string;
  /** Path to the wstack CLI entry. */
  wstackEntry: string;
  /** Cap the number of tasks (cheap smoke runs). */
  limit?: number | undefined;
  /** Where the sandbox is created (default OS temp). */
  sandboxBaseDir?: string | undefined;
  /** Extra env for the subprocess (provider keys are inherited from process.env). */
  env?: NodeJS.ProcessEnv | undefined;
  /**
   * Operator `WRONGSTACK_HOME`. Copied into the sandbox (vault + providers +
   * models cache) so custom providers resolve the same way as an interactive
   * `wstack --provider --model` run. Sessions stay isolated.
   */
  hostHomeDir?: string | undefined;
  /** Harness profile for the sandbox. Defaults to `lean`; see {@link BenchProfile}. */
  profile?: BenchProfile | undefined;
  /** Config deep-merged over the lean profile; see `createSandbox`. */
  harnessOverlay?: Record<string, unknown> | undefined;
  /** Wait before retrying a run whose CLI failed to load. Default 20 s; tests pass 0. */
  bootRetryDelayMs?: number | undefined;
  /** Keep the sandbox on disk after the run (debugging). */
  keepSandbox?: boolean | undefined;
  /** Progress callback (one line per event). */
  onProgress?: ((msg: string) => void) | undefined;
  /**
   * Called as each (task × cell × attempt) row lands. A full matrix can run for
   * hours; streaming rows out lets the caller persist them so a crash, a
   * Ctrl-C, or a dead laptop battery does not throw the whole run away.
   * Failures here are swallowed — persistence must never fail a benchmark.
   */
  onResult?: ((result: TaskResult) => void | Promise<void>) | undefined;
  /** Injected clock for the report timestamp (tests pass a fixed value). */
  now?: (() => string) | undefined;
  /**
   * Stops the run: nothing new starts, in-flight agents and test commands are
   * killed, and their rows are dropped instead of scored. The report covers
   * what finished and says it is incomplete.
   */
  signal?: AbortSignal | undefined;
  /**
   * Rows an interrupted run already recorded. Their units are skipped, and
   * the report folds them in as if this run had made them.
   */
  priorResults?: TaskResult[] | undefined;
  /** Called once the fingerprint and the planned unit count are known. */
  onStart?:
    | ((info: {
        fingerprint: HarnessFingerprint;
        subsetId: string;
        planned: number;
      }) => void | Promise<void>)
    | undefined;
  /** Interval of the "still running" progress line. Default 60 s. */
  heartbeatMs?: number | undefined;
  /**
   * After every unit has run, grade each failed row of this run once more on
   * its untouched workdir (no new agent run). Default true; see
   * {@link TaskResult.lastChance}.
   */
  lastChanceRegrade?: boolean | undefined;
}

/**
 * Run the full benchmark: load the task subset, fan every (task × cell) cell
 * out through isolated subprocesses, grade deterministically, and fold into a
 * fingerprint-stamped report.
 */
export async function runBenchmark(opts: RunBenchmarkOptions): Promise<BenchReport> {
  if (opts.reviewPolicy) reviewTranscript([], '0'.repeat(64), opts.reviewPolicy);
  const progress = opts.onProgress ?? (() => {});
  const nowFn = opts.now ?? (() => new Date().toISOString());

  const tasks = await opts.suite.loadTasks({ limit: opts.limit });
  if (tasks.length === 0) {
    throw new Error(`suite "${opts.suite.id}" produced no tasks (check the data directory)`);
  }
  const subsetId = opts.suite.subsetId(tasks);
  const repeats = Math.max(1, Math.floor(opts.config.repeats ?? 1));

  const sandbox = await createSandbox({
    baseDir: opts.sandboxBaseDir,
    maxIterations: opts.config.maxIterations,
    yolo: true,
    hostHomeDir: opts.hostHomeDir,
    profile: opts.profile,
    harnessOverlay: opts.harnessOverlay,
  });

  const fingerprint = computeHarnessFingerprint({
    cliVersion: opts.cliVersion,
    toolNames: opts.profile === 'host' ? opts.toolNames : [...LEAN_BENCH_TOOL_NAMES],
    maxIterations: opts.config.maxIterations,
    yolo: true,
    subsetId,
    toolManifestHash: opts.toolManifestHash,
    systemPromptHash: opts.systemPromptHash,
    configHash: opts.configHash ?? sandbox.configHash,
    profile: opts.profile ?? 'lean',
  });

  // The unit of work is one (task × cell × attempt). Fanning out at this
  // granularity keeps all cores busy even when one cell is much slower than
  // another, and lets repeats of the same task run in parallel.
  const units: Array<{ task: BenchTask; cell: ModelCell; attempt: number }> = [];
  for (const task of tasks) {
    for (const cell of opts.config.cells) {
      for (let attempt = 1; attempt <= repeats; attempt++) {
        units.push({ task, cell, attempt });
      }
    }
  }

  // Resume: a unit that already has a row is not run again.
  const prior = opts.priorResults ?? [];
  const done = new Set(prior.map((row) => unitKey(row.taskId, row.cell.label, row.attempt)));
  const pending = units.filter((u) => !done.has(unitKey(u.task.id, u.cell.label, u.attempt)));

  progress(
    `suite=${opts.suite.id} tasks=${tasks.length} cells=${opts.config.cells.length} ` +
      `repeats=${repeats} runs=${units.length}` +
      `${prior.length > 0 ? ` (resuming: ${prior.length} done, ${pending.length} to go)` : ''}` +
      ` fp=${fingerprint.hash}`,
  );
  let completed = prior.length;
  let passedSoFar = prior.filter((row) => row.grade.passed).length;
  const aborted = () => opts.signal?.aborted === true;

  // Nothing prints while every slot is busy with a 10-minute task; a periodic
  // line says what is still running and roughly how long the rest will take.
  const inflight = new Map<string, number>();
  const startedAt = Date.now();
  // What a last-chance re-grade needs per graded unit of this run. Rows a
  // resume carried in have no workdir left, so they are never re-graded.
  const regradable = new Map<
    string,
    { workdir: string; task: BenchTask; run: TaskResult['run'] }
  >();
  const heartbeat = setInterval(() => {
    if (inflight.size === 0 || aborted()) return;
    progress(
      heartbeatLine({
        completed,
        planned: units.length,
        finishedThisRun: completed - prior.length,
        inflight,
        now: Date.now(),
        startedAt,
      }),
    );
  }, opts.heartbeatMs ?? 60_000);
  heartbeat.unref?.();

  try {
    await opts.onStart?.({ fingerprint, subsetId, planned: units.length });
    const fresh = await mapWithConcurrency(pending, opts.config.concurrency, async (unit) => {
      // Stopped: start nothing new, and drop what was in flight — a row cut
      // short by Ctrl-C is not a measurement. Resume runs those units again.
      if (aborted()) return undefined;
      const label = `${unit.cell.label} · ${unit.task.id}${repeats > 1 ? ` #${unit.attempt}` : ''}`;
      inflight.set(label, Date.now());
      try {
        const row = await runUnit(unit);
        return aborted() ? undefined : row;
      } finally {
        inflight.delete(label);
      }
    });
    let freshRows = fresh.filter((row): row is TaskResult => row !== undefined);
    if (opts.lastChanceRegrade !== false && !aborted()) {
      freshRows = await lastChance(freshRows);
    }
    const results = [...prior, ...freshRows];

    const cells = aggregateAll(opts.config.cells, results);
    return {
      suite: opts.suite.id,
      finishedAt: nowFn(),
      fingerprint,
      cells,
      results,
      progress: { planned: units.length, completed: results.length, interrupted: aborted() },
    };
  } finally {
    clearInterval(heartbeat);
    await reapProcessesUnder([sandbox.root]);
    if (!opts.keepSandbox) await cleanupSandbox(sandbox);
  }

  /**
   * Grade each failed row once more, after every unit has run, on the workdir
   * the agent left. Only rows the grader judged: a crash already forced FAIL,
   * and a re-grade cannot change it. A Ctrl-C keeps the first verdicts.
   */
  async function lastChance(rows: TaskResult[]): Promise<TaskResult[]> {
    const candidates = rows.filter((row) => {
      const ctx = regradable.get(unitKey(row.taskId, row.cell.label, row.attempt));
      return !row.grade.passed && ctx !== undefined && ctx.run.status !== 'crashed';
    });
    if (candidates.length === 0) return rows;
    progress(
      `  ↻ last chance: grading ${candidates.length} failed row(s) again (no new agent run)`,
    );
    const regraded = new Map<TaskResult, TaskResult>();
    let rescued = 0;
    await mapWithConcurrency(candidates, opts.config.concurrency, async (row) => {
      if (aborted()) return;
      const key = unitKey(row.taskId, row.cell.label, row.attempt);
      const ctx = regradable.get(key)!;
      let grade: GradeResult;
      try {
        grade = await opts.grade({
          workdir: ctx.workdir,
          task: ctx.task,
          cell: row.cell,
          timeoutMs: opts.config.timeoutMs,
          signal: opts.signal,
        });
      } catch (err) {
        /* v8 ignore next -- graders reject with Error; the String(err) branch is defensive. */
        grade = {
          passed: false,
          detail: `grader error: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      if (aborted()) return;
      grade = withRunReason(ctx.run, grade);
      const label = `${row.cell.label} · ${row.taskId}${repeats > 1 ? ` #${row.attempt ?? 1}` : ''}`;
      if (grade.passed) {
        rescued++;
        progress(`  ↻ ${label} → PASS on last chance (first grade failed)`);
      }
      regraded.set(row, {
        ...row,
        grade: grade.passed ? grade : row.grade,
        lastChance: { passed: grade.passed, firstDetail: row.grade.detail },
      });
    });
    progress(`  ↻ last chance: ${rescued}/${candidates.length} passed on the second grade`);
    return rows.map((row) => regraded.get(row) ?? row);
  }

  async function runUnit(unit: {
    task: BenchTask;
    cell: ModelCell;
    attempt: number;
  }): Promise<TaskResult | undefined> {
    {
      const { task, cell, attempt } = unit;
      let workdir: string;
      try {
        workdir = await prepareWorkdir(
          sandbox,
          task.templateDir,
          task.id,
          cell.label,
          task.templateExclude,
          attempt,
        );
        await task.prepareWorkdir?.(workdir);
      } catch (err) {
        // A task whose template cannot be copied (missing/broken template dir,
        // fs error) must not abort the whole benchmark — persist the failure as
        // a crashed, ungraded row so the report shows WHAT was skipped while the
        // rest of the matrix keeps running. Mirrors the contained grader-error
        // handling below.
        const detail = `template copy failed: ${err instanceof Error ? err.message : String(err)}`;
        const result: TaskResult = {
          taskId: task.id,
          cell,
          ...(repeats > 1 ? { attempt } : {}),
          run: {
            status: 'crashed',
            finalText: null,
            iterations: 0,
            tokensIn: 0,
            tokensOut: 0,
            costUsd: 0,
            elapsedMs: 0,
            exitCode: null,
            crashDetail: detail,
          },
          grade: { passed: false, graded: false, detail },
          tools: {
            totalCalls: 0,
            editCalls: 0,
            editErrors: 0,
            rateLimitRetries: 0,
            subagentSpawns: 0,
          },
        };
        if (aborted()) return undefined;
        completed++;
        progress(
          `  [${completed}/${units.length} · ${passedSoFar} pass] ${cell.label} · ${task.id}` +
            `${repeats > 1 ? ` #${attempt}` : ''} → FAIL (template copy failed)`,
        );
        if (opts.onResult) {
          try {
            await opts.onResult(result);
          } catch {
            // Persisting a row must never fail the benchmark it is recording.
          }
        }
        return result;
      }

      const runOnce = () =>
        runWstack({
          nodeBin: opts.nodeBin,
          wstackEntry: opts.wstackEntry,
          homeDir: sandbox.homeDir,
          workdir,
          cell,
          prompt: task.prompt,
          timeoutMs: opts.config.timeoutMs,
          env: opts.env,
          signal: opts.signal,
          profile: opts.profile,
        });
      let run = await runOnce();
      if (aborted()) return undefined;
      // A CLI that could not even load (a concurrent rebuild of the checkout
      // briefly removed a dist file) or died booting before its first model
      // request (the project SAGE server missing its 5 s ping under a loaded
      // machine) made no attempt; scoring it would charge the model for the
      // machine. Retry on a fresh workdir instead.
      for (
        let retry = 1;
        retry <= BOOT_CRASH_RETRIES &&
        !aborted() &&
        (isBootCrash(run) ||
          (run.status === 'crashed' &&
            (await readTokenMetrics({ homeDir: sandbox.homeDir, workdir })).requests === 0));
        retry++
      ) {
        progress(
          `  ↻ ${cell.label} · ${task.id}: CLI failed to load, retry ${retry}/${BOOT_CRASH_RETRIES}`,
        );
        await new Promise((resolve) => setTimeout(resolve, opts.bootRetryDelayMs ?? 20_000));
        workdir = await prepareWorkdir(
          sandbox,
          task.templateDir,
          task.id,
          cell.label,
          task.templateExclude,
          attempt,
        );
        await task.prepareWorkdir?.(workdir);
        run = await runOnce();
      }
      if (aborted()) return undefined;

      const tools = await readToolMetrics({ homeDir: sandbox.homeDir, workdir });
      const tokens = await readTokenMetrics({ homeDir: sandbox.homeDir, workdir });
      const traceEval = task.traceEval
        ? await evaluateTraceEval({
            homeDir: sandbox.homeDir,
            workdir,
            spec: task.traceEval,
          })
        : undefined;

      let grade: GradeResult;
      try {
        grade = await opts.grade({
          workdir,
          task,
          cell,
          timeoutMs: opts.config.timeoutMs,
          signal: opts.signal,
        });
      } catch (err) {
        grade = {
          passed: false,
          /* v8 ignore next -- graders reject with Error; the String(err) branch is defensive. */
          detail: `grader error: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      // The run and its grading are done: whatever this task's project still
      // has running (daemons past their idle window) only crowds later tasks.
      const projectHome = path.dirname(
        resolveWstackPaths({ projectRoot: workdir, globalRoot: sandbox.homeDir }).projectSessions,
      );
      await reapProcessesUnder(sandboxRootsFor(workdir, projectHome));
      if (aborted()) return undefined;
      // Prepend the harness-level reason so a failed row in the report is
      // diagnosable. Without this a `failed`/`timeout` row said only "fail".
      // The grader stays authoritative on pass/fail — a run that hit the
      // iteration cap but left passing code IS a pass. Only a crash overrides
      // it, because then no meaningful attempt was made in the workdir.
      grade = withRunReason(run, grade);
      regradable.set(unitKey(task.id, cell.label, attempt), {
        workdir,
        task,
        run,
      });

      completed++;
      if (grade.passed) passedSoFar++;
      progress(
        `  [${completed}/${units.length} · ${passedSoFar} pass] ${cell.label} · ${task.id}` +
          `${repeats > 1 ? ` #${attempt}` : ''} → ${grade.passed ? 'PASS' : 'FAIL'}  ` +
          resultSummary(run, tokens, tools.totalCalls),
      );
      if (!grade.passed) progress(`      ↳ ${failureHint(grade.detail)}`);

      const result: TaskResult = { taskId: task.id, cell, run, grade, tools, tokens };
      if (repeats > 1) result.attempt = attempt;
      if (traceEval) result.traceEval = traceEval;
      if (opts.reviewPolicy) {
        const events = await readSessionLogEvents({ homeDir: sandbox.homeDir, workdir });
        if (events.length)
          result.qualityReview = reviewTranscript(
            events,
            createHash('sha256').update(JSON.stringify(events)).digest('hex'),
            opts.reviewPolicy,
            'event-array',
          );
      }
      if (opts.onResult) {
        try {
          await opts.onResult(result);
        } catch {
          // Persisting a row must never fail the benchmark it is recording.
        }
      }
      return result;
    }
  }
}

/** The grade with the run's failure reason prepended; a crash forces FAIL. */
function withRunReason(run: TaskResult['run'], grade: GradeResult): GradeResult {
  const reason = runFailureReason(run);
  if (!reason) return grade;
  return {
    ...grade,
    passed: run.status === 'crashed' ? false : grade.passed,
    detail: grade.detail ? `${reason}\n${grade.detail}` : reason,
  };
}

/** Identity of one (task × cell × attempt); a single-attempt row has no `attempt`. */
export function unitKey(taskId: string, cellLabel: string, attempt: number | undefined): string {
  return `${taskId}\u0000${cellLabel}\u0000${attempt ?? 1}`;
}

/**
 * Split a stopped run's rows for `--resume --rerun`: rows whose task id starts
 * with one of `prefixes` are dropped so their units run again. A harness fault
 * (a grader on the wrong JDK) records FAIL rows a plain resume would keep.
 */
export function partitionRerunRows<T extends { taskId: string }>(
  rows: T[],
  prefixes: string[],
): { kept: T[]; dropped: T[] } {
  const kept: T[] = [];
  const dropped: T[] = [];
  for (const row of rows) {
    (prefixes.some((p) => row.taskId.startsWith(p)) ? dropped : kept).push(row);
  }
  return { kept, dropped };
}

/** The periodic "still running" line. Exported for tests. */
export function heartbeatLine(state: {
  completed: number;
  planned: number;
  finishedThisRun: number;
  inflight: ReadonlyMap<string, number>;
  now: number;
  startedAt: number;
}): string {
  let longest: [string, number] | undefined;
  for (const [label, since] of state.inflight) {
    if (!longest || since < longest[1]) longest = [label, since];
  }
  const parts = [`${state.completed}/${state.planned} done`, `${state.inflight.size} running`];
  if (longest) parts.push(`longest ${longest[0]} ${fmtElapsed(state.now - longest[1])}`);
  const remaining = state.planned - state.completed;
  if (state.finishedThisRun > 0 && remaining > 0) {
    const perUnit = (state.now - state.startedAt) / state.finishedThisRun;
    parts.push(`~${fmtElapsed(perUnit * remaining)} left`);
  }
  return `  ⏳ ${parts.join(' · ')}`;
}

function fmtElapsed(ms: number): string {
  const s = Number.isFinite(ms) ? Math.max(0, Math.round(ms / 1000)) : 0;
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

const BOOT_CRASH_RETRIES = 2;

/**
 * The live progress line's numbers for one finished row — what the persisted
 * results.jsonl row holds, readable while a multi-hour run is still going.
 * Exported for tests.
 */
export function resultSummary(
  run: TaskResult['run'],
  tokens: { total: number; input: number; cacheRead: number } | undefined,
  toolCalls: number,
): string {
  const elapsedMs = Number.isFinite(run.elapsedMs) ? Math.max(0, run.elapsedMs) : 0;
  const parts = [`${run.status}`, `${Math.round(elapsedMs / 1000)}s`, `${run.iterations} it`];
  if (tokens && Number.isFinite(tokens.total) && tokens.total > 0) {
    const input = Number.isFinite(tokens.input) && tokens.input > 0 ? tokens.input : 0;
    const cacheRead =
      Number.isFinite(tokens.cacheRead) && tokens.cacheRead > 0 ? tokens.cacheRead : 0;
    const prompt = input + cacheRead;
    const cache = prompt > 0 ? ` (cache ${Math.round((cacheRead / prompt) * 100)}%)` : '';
    parts.push(`${(tokens.total / 1000).toFixed(1)}k tok${cache}`);
  }
  parts.push(`${toolCalls} tools`);
  if (Number.isFinite(run.costUsd) && run.costUsd > 0) parts.push(`$${run.costUsd.toFixed(3)}`);
  return parts.join(' · ');
}

/**
 * One line saying why a row failed: the harness reason when there is one,
 * else the most telling line of the test output (jest's `●` header, a pytest
 * `FAILED`, a summary), ANSI-stripped. Exported for tests.
 */
export function failureHint(detail: string | undefined): string {
  if (!detail) return 'no detail';
  const lines = detail
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split(/\r?\n/)
    .map((line) => line.trim());
  const meaningful = lines.filter((line) => line.length > 0 && !line.startsWith('…'));
  const pick =
    (meaningful[0]?.startsWith('agent ') ? meaningful[0] : undefined) ??
    meaningful.find((line) => /^(●|FAILED|Error|AssertionError|setup failed)|Tests:/.test(line)) ??
    meaningful.at(-1) ??
    'no detail';
  return pick.length > 160 ? `${safePrefix(pick, 157)}…` : pick;
}

/**
 * A crash before the agent loop started because the CLI could not resolve
 * one of its own modules. Exported for tests.
 */
export function isBootCrash(run: TaskResult['run']): boolean {
  return run.status === 'crashed' && /ERR_MODULE_NOT_FOUND/.test(run.crashDetail ?? '');
}

/**
 * Human-readable reason a run did not complete normally, or undefined when the
 * agent finished its loop (a plain grader failure then speaks for itself).
 * Exported so the reason strings are pinned by tests rather than by eyeball.
 */
export function runFailureReason(run: TaskResult['run']): string | undefined {
  switch (run.status) {
    case 'crashed':
      return `agent crashed: ${run.crashDetail ?? 'no --output-json payload'}`;
    case 'timeout':
      return 'agent timed out (killed; tokens come from the transcript, cost is unknown)';
    case 'max_iterations':
      return `agent hit the iteration cap after ${run.iterations} iterations`;
    case 'aborted':
      return 'agent aborted';
    case 'failed':
      return `agent reported failure${run.errorMessage ? `: ${run.errorMessage}` : ''}`;
    default:
      // 'completed' normally means the loop finished. But if the subprocess
      // exited non-zero AFTER printing a completed payload (a wrapper crash, a
      // signal, or an error path that still wrote the report), that abnormal
      // exit must not be silently graded as a clean pass — surface it so the
      // report carries the diagnostic while the grader stays authoritative on
      // pass/fail.
      if (run.status === 'completed' && run.exitCode !== 0 && run.exitCode != null) {
        return `agent exited with code ${run.exitCode} after reporting completed`;
      }
      return undefined;
  }
}
