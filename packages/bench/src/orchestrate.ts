import { aggregateAll } from './aggregate.js';
import { computeHarnessFingerprint } from './fingerprint.js';
import { cleanupSandbox, createSandbox, prepareWorkdir } from './isolation.js';
import { mapWithConcurrency, runWstack } from './runner.js';
import { readToolMetrics } from './session-metrics.js';
import { evaluateTraceEval } from './trace-eval.js';
import type {
  BenchConfig,
  BenchReport,
  BenchSuite,
  BenchTask,
  GradeResult,
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
  }) => Promise<GradeResult>;
  config: BenchConfig;
  cliVersion: string;
  /** Tool names available to the agent — folded into the fingerprint. */
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
}

/**
 * Run the full benchmark: load the task subset, fan every (task × cell) cell
 * out through isolated subprocesses, grade deterministically, and fold into a
 * fingerprint-stamped report.
 */
export async function runBenchmark(opts: RunBenchmarkOptions): Promise<BenchReport> {
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
  });

  const fingerprint = computeHarnessFingerprint({
    cliVersion: opts.cliVersion,
    toolNames: opts.toolNames,
    maxIterations: opts.config.maxIterations,
    yolo: true,
    subsetId,
    toolManifestHash: opts.toolManifestHash,
    systemPromptHash: opts.systemPromptHash,
    configHash: opts.configHash ?? sandbox.configHash,
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

  progress(
    `suite=${opts.suite.id} tasks=${tasks.length} cells=${opts.config.cells.length} ` +
      `repeats=${repeats} runs=${units.length} fp=${fingerprint.hash}`,
  );
  let completed = 0;

  try {
    const results = await mapWithConcurrency(units, opts.config.concurrency, async (unit) => {
      const { task, cell, attempt } = unit;
      const workdir = await prepareWorkdir(
        sandbox,
        task.templateDir,
        task.id,
        cell.label,
        task.templateExclude,
        attempt,
      );

      const run = await runWstack({
        nodeBin: opts.nodeBin,
        wstackEntry: opts.wstackEntry,
        homeDir: sandbox.homeDir,
        workdir,
        cell,
        prompt: task.prompt,
        timeoutMs: opts.config.timeoutMs,
        env: opts.env,
      });

      const tools = await readToolMetrics({ homeDir: sandbox.homeDir, workdir });
      const traceEval = task.traceEval
        ? await evaluateTraceEval({
            homeDir: sandbox.homeDir,
            workdir,
            spec: task.traceEval,
          })
        : undefined;

      let grade: GradeResult;
      try {
        grade = await opts.grade({ workdir, task, cell, timeoutMs: opts.config.timeoutMs });
      } catch (err) {
        grade = {
          passed: false,
          /* v8 ignore next -- graders reject with Error; the String(err) branch is defensive. */
          detail: `grader error: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      // Prepend the harness-level reason so a failed row in the report is
      // diagnosable. Without this a `failed`/`timeout` row said only "fail".
      // The grader stays authoritative on pass/fail — a run that hit the
      // iteration cap but left passing code IS a pass. Only a crash overrides
      // it, because then no meaningful attempt was made in the workdir.
      const reason = runFailureReason(run);
      if (reason) {
        grade = {
          ...grade,
          passed: run.status === 'crashed' ? false : grade.passed,
          detail: grade.detail ? `${reason}\n${grade.detail}` : reason,
        };
      }

      completed++;
      progress(
        `  [${completed}/${units.length}] ${cell.label} · ${task.id}` +
          `${repeats > 1 ? ` #${attempt}` : ''} → ${grade.passed ? 'PASS' : 'fail'} ` +
          `(${run.status}, ${run.iterations} it, $${run.costUsd.toFixed(3)})`,
      );

      const result: TaskResult = { taskId: task.id, cell, run, grade, tools };
      if (repeats > 1) result.attempt = attempt;
      if (traceEval) result.traceEval = traceEval;
      if (opts.onResult) {
        try {
          await opts.onResult(result);
        } catch {
          // Persisting a row must never fail the benchmark it is recording.
        }
      }
      return result;
    });

    const cells = aggregateAll(opts.config.cells, results);
    return {
      suite: opts.suite.id,
      finishedAt: nowFn(),
      fingerprint,
      cells,
      results,
    };
  } finally {
    if (!opts.keepSandbox) await cleanupSandbox(sandbox);
  }
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
      return 'agent timed out (killed; token/cost telemetry unrecoverable)';
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
