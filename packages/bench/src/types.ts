/**
 * Core contracts for the model-independent benchmark harness.
 *
 * The guiding principle: WrongStack is the *harness* (system prompt + tool set
 * + agent loop + scaffolding). The model is the swappable variable. Grading is
 * deterministic (the suite's own tests decide pass/fail — never an LLM), and
 * every report is stamped with a {@link HarnessFingerprint} so rows are only
 * comparable when the harness is identical.
 */

/** A single model under test — one column in the leaderboard. */
export interface ModelCell {
  /** Short human label shown in the report (e.g. "opus-4.8"). Must be unique. */
  label: string;
  /** Provider id passed to `wstack --provider` (e.g. "anthropic"). */
  provider: string;
  /** Model id passed to `wstack --model` (e.g. "claude-opus-4-8"). */
  model: string;
}

/** Loaded `bench.config.json`. */
export interface BenchConfig {
  /** Per-task iteration cap (seeded into the isolated config). Default 40. */
  maxIterations: number;
  /** How many cells/tasks run concurrently. Default 4. */
  concurrency: number;
  /** Per-task wall-clock timeout in milliseconds. Default 600_000 (10m). */
  timeoutMs: number;
  /** The models to benchmark. At least one. */
  cells: ModelCell[];
}

/** One unit of work: a single benchmark exercise/issue. */
export interface BenchTask {
  /** Stable id, unique within the suite (e.g. "polyglot/python/bowling"). */
  id: string;
  /** Suite this task belongs to. */
  suite: SuiteId;
  /** The instruction text handed to the agent via `--prompt`. */
  prompt: string;
  /**
   * Absolute path to a template directory. The runner copies it into an
   * isolated workdir before each cell so parallel runs never collide.
   */
  templateDir: string;
  /**
   * Top-level entry names to omit when copying the template (e.g. `.meta` so
   * the agent never sees the reference solution). Matched against each path's
   * segments. Defaults to none.
   */
  templateExclude?: string[] | undefined;
  /** Opaque per-suite data the grader needs (test command, language, etc.). */
  meta: Record<string, unknown>;
}

export type SuiteId = 'polyglot' | 'swebench' | 'local';

/** A suite knows how to enumerate its tasks and grade a finished workdir. */
export interface BenchSuite {
  id: SuiteId;
  /** Discover tasks. `limit` caps the count (for cheap smoke runs). */
  loadTasks(opts: { limit?: number | undefined }): Promise<BenchTask[]>;
  /** A stable id for the exact task subset, folded into the fingerprint. */
  subsetId(tasks: BenchTask[]): string;
}

/** Deterministic grader verdict for one finished workdir. */
export interface GradeResult {
  /** Did the suite's own tests pass? This is the headline correctness signal. */
  passed: boolean;
  /**
   * Whether a verdict was actually produced. Defaults to true. SWE-bench sets
   * this false when it only exported a prediction for offline grading by the
   * official harness — such rows are excluded from the pass rate so they don't
   * masquerade as failures.
   */
  graded?: boolean | undefined;
  /** Optional detail (failing test names, compiler error, etc.). */
  detail?: string | undefined;
}

/** Raw telemetry parsed from a single `wstack` subprocess run. */
export interface RawRun {
  /** RunResult.status from `--output-json`, or a harness-level status. */
  status: 'completed' | 'failed' | 'aborted' | 'max_iterations' | 'timeout' | 'crashed';
  finalText: string | null;
  iterations: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  elapsedMs: number;
  /** Process exit code (null when killed by timeout). */
  exitCode: number | null;
}

/** Per-(task × cell) result: telemetry + deterministic grade + tool metrics. */
export interface TaskResult {
  taskId: string;
  cell: ModelCell;
  run: RawRun;
  grade: GradeResult;
  /** Tool-call metrics parsed from the isolated session JSONL. */
  tools: ToolMetrics;
}

/** Tool-level metrics derived from the session log (model-free). */
export interface ToolMetrics {
  totalCalls: number;
  /** edit/write tool invocations. */
  editCalls: number;
  /** edit/write invocations that returned an error (failed to apply). */
  editErrors: number;
  /** provider 429 / retry events. */
  rateLimitRetries: number;
}

/** Folded results for one model cell across all its tasks. */
export interface CellResult {
  cell: ModelCell;
  taskCount: number;
  /** How many tasks produced an actual graded verdict (graded !== false). */
  gradedCount: number;
  /** Fraction in [0,1] of GRADED tasks whose grader passed (pass@1). */
  passRate: number;
  /** Fraction in [0,1] of edit/write calls that applied cleanly. */
  editApplyRate: number;
  avgCostUsd: number;
  avgTokensIn: number;
  avgTokensOut: number;
  /** Median iterations across tasks. */
  p50Iterations: number;
  /** Median wall-clock per task, ms. */
  p50ElapsedMs: number;
  /** Fraction in [0,1] of tasks that hit the timeout. */
  timeoutRate: number;
  totalRateLimitRetries: number;
}

/**
 * Identifies the harness configuration. Two reports are only comparable when
 * their fingerprints match; a prompt/tool/version change flips the hash and
 * marks older rows stale.
 */
export interface HarnessFingerprint {
  cliVersion: string;
  /** Sorted, comma-joined tool names available to the agent. */
  toolNames: string[];
  maxIterations: number;
  yolo: boolean;
  /** Suite subset id (the exact task set). */
  subsetId: string;
  /** Hash of tool names, descriptions, usage hints, schemas, and safety metadata. */
  toolManifestHash?: string | undefined;
  /** Hash of the built system prompt, when the caller can provide it. */
  systemPromptHash?: string | undefined;
  /** Hash of behavior-affecting harness config beyond maxIterations/yolo. */
  configHash?: string | undefined;
  /** sha256 hex (first 12 chars) of the comparable harness fields above. */
  hash: string;
}

/** The full report artifact written to disk. */
export interface BenchReport {
  suite: SuiteId;
  /** ISO timestamp the run finished (stamped by the caller, not the harness). */
  finishedAt: string;
  fingerprint: HarnessFingerprint;
  cells: CellResult[];
  /** Every per-(task × cell) row, for reproducibility. */
  results: TaskResult[];
}
