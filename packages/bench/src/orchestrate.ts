import { aggregateAll } from './aggregate.js';
import { computeHarnessFingerprint } from './fingerprint.js';
import { cleanupSandbox, createSandbox, prepareWorkdir } from './isolation.js';
import { mapWithConcurrency, runWstack } from './runner.js';
import { readToolMetrics } from './session-metrics.js';
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
  /** Additional behavior-affecting config hash, when available. */
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
  /** Keep the sandbox on disk after the run (debugging). */
  keepSandbox?: boolean | undefined;
  /** Progress callback (one line per event). */
  onProgress?: ((msg: string) => void) | undefined;
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
  const fingerprint = computeHarnessFingerprint({
    cliVersion: opts.cliVersion,
    toolNames: opts.toolNames,
    maxIterations: opts.config.maxIterations,
    yolo: true,
    subsetId,
    toolManifestHash: opts.toolManifestHash,
    systemPromptHash: opts.systemPromptHash,
    configHash: opts.configHash,
  });

  progress(
    `suite=${opts.suite.id} tasks=${tasks.length} cells=${opts.config.cells.length} fp=${fingerprint.hash}`,
  );

  const sandbox = await createSandbox({
    baseDir: opts.sandboxBaseDir,
    maxIterations: opts.config.maxIterations,
    yolo: true,
  });

  // The unit of work is one (task × cell) pair. Fanning out at this granularity
  // keeps all cores busy even when one cell is much slower than another.
  const units: Array<{ task: BenchTask; cell: ModelCell }> = [];
  for (const task of tasks) {
    for (const cell of opts.config.cells) {
      units.push({ task, cell });
    }
  }

  try {
    const results = await mapWithConcurrency(units, opts.config.concurrency, async (unit) => {
      const { task, cell } = unit;
      const workdir = await prepareWorkdir(
        sandbox,
        task.templateDir,
        task.id,
        cell.label,
        task.templateExclude,
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

      progress(
        `  ${cell.label} · ${task.id} → ${grade.passed ? 'PASS' : 'fail'} ` +
          `(${run.status}, ${run.iterations} it, $${run.costUsd.toFixed(3)})`,
      );

      const result: TaskResult = { taskId: task.id, cell, run, grade, tools };
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
