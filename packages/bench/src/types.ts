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
  /**
   * How many independent attempts each (task × cell) gets. Default 1.
   *
   * Agentic runs are stochastic: a single attempt per task turns run-to-run
   * noise into a leaderboard position. With `repeats > 1` the pass rate is
   * measured over every attempt (an unbiased pass@1 estimate) and the report
   * additionally exposes pass@k and a per-task flakiness count, so a lucky
   * run cannot be mistaken for a better model.
   *
   * Optional so a hand-built config literal stays valid; absent means 1.
   */
  repeats?: number | undefined;
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
  /**
   * Optional three-stage trace evaluation. These cases are mined from a real
   * session transcript and make retrieval, model recall/intent, and edit-tool
   * application independently observable.
   */
  traceEval?: TranscriptEvalSpec | undefined;
}

export type SuiteId = 'polyglot' | 'swebench' | 'local' | 'smoke' | 'core';

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
  /**
   * `error.message` from the CLI's `--output-json` payload. Present only when
   * the agent loop itself reported a failure; without it a `failed` row in the
   * report is a dead end for whoever has to diagnose it.
   */
  errorMessage?: string | undefined;
  /** Stderr tail when the subprocess produced no `--output-json` payload. */
  crashDetail?: string | undefined;
}

/** Per-(task × cell) result: telemetry + deterministic grade + tool metrics. */
export interface TaskResult {
  taskId: string;
  cell: ModelCell;
  /**
   * 1-based attempt index when `BenchConfig.repeats > 1`. Absent (treated as
   * 1) in single-attempt runs and in artifacts written before repeats existed.
   */
  attempt?: number | undefined;
  run: RawRun;
  grade: GradeResult;
  /** Tool-call metrics parsed from the isolated session JSONL. */
  tools: ToolMetrics;
  /** Present only for real-transcript trace evaluation cases. */
  traceEval?: TraceEvalResult | undefined;
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

/** Immutable provenance for an evaluation case mined from a real session. */
export interface TranscriptCaseSource {
  /** Session id recorded by the original JSONL transcript. */
  sessionId: string;
  /** Absolute path after the manifest loader resolves the source path. */
  transcriptPath: string;
  /** SHA-256 of the original transcript, preventing silent source drift. */
  sha256: string;
  /** Inclusive zero-based JSONL event range used to curate the case. */
  eventStart: number;
  eventEnd: number;
}

/** Evidence that a retrieval tool must surface for a trace-eval case. */
export interface RetrievalExpectation {
  /** Text that must occur in a successful tool result. */
  contains: string;
  /** Optional case-insensitive allow-list of retrieval tools. */
  toolNames?: string[] | undefined;
}

/** A deterministic marker for the model's intended edit. */
export interface RecallExpectation {
  /** Edit tool names eligible to express the intended change. */
  toolNames?: string[] | undefined;
  /** All strings must occur in one matching tool input JSON payload. */
  inputContains: string[];
}

/**
 * Stage specifications tied to a real session transcript.
 *
 * At runtime the benchmark evaluates a fresh session in this order:
 * retrieval succeeds when all expected evidence is observed; recall succeeds
 * when the model produces the expected edit intent; application succeeds when
 * that exact tool-use id later ends with `ok: true`.
 */
export interface TranscriptEvalSpec {
  source: TranscriptCaseSource;
  retrieval: RetrievalExpectation[];
  recall: RecallExpectation;
}

/** Result of applying a {@link TranscriptEvalSpec} to one benchmark run. */
export interface TraceEvalResult {
  sourceSessionId: string;
  retrievalPassed: boolean;
  recallPassed: boolean;
  /** True only when a correct-intent edit invocation applied successfully. */
  editApplicationPassed: boolean;
}

/** A numerator/denominator metric; absent rates are never converted to 100%. */
export interface ConditionalRate {
  eligible: number;
  passed: number;
  rate: number | undefined;
}

/**
 * Ordered diagnostic funnel for transcript-mined cases. Each downstream rate
 * is conditional on the preceding stage, so a tooling failure cannot be
 * attributed to retrieval or model reasoning.
 */
export interface TraceEvalMetrics {
  retrieval: ConditionalRate;
  recallGivenRetrieval: ConditionalRate;
  editApplicationGivenRecall: ConditionalRate;
}

/** Folded results for one model cell across all its tasks. */
export interface CellResult {
  cell: ModelCell;
  /** Distinct tasks folded into this row (NOT the attempt count). */
  taskCount: number;
  /**
   * Total attempts folded in (`taskCount × repeats` when nothing was skipped).
   * Absent in artifacts written before repeats existed — read it as
   * `attemptCount ?? taskCount`.
   */
  attemptCount?: number | undefined;
  /** Attempts per task this run used. Absent in pre-repeats artifacts (=1). */
  repeats?: number | undefined;
  /**
   * Attempts that produced no `--output-json` payload (timeout / crash). Their
   * token and cost telemetry is unrecoverable, so a non-zero count means the
   * cost and token averages below are UNDER-stated.
   */
  incompleteCount?: number | undefined;
  /** Tasks whose attempts were not unanimous — the flakiness signal. Requires repeats > 1. */
  flakyTaskCount?: number | undefined;
  /** pass@k: fraction of tasks with at least one passing attempt. */
  passAnyRate?: number | undefined;
  /** Fraction of tasks where EVERY graded attempt passed (reliability). */
  passAllRate?: number | undefined;
  /** How many attempts produced an actual graded verdict (graded !== false). */
  gradedCount: number;
  /** Fraction in [0,1] of GRADED attempts whose grader passed (pass@1). */
  passRate: number;
  /** Fraction in [0,1] of edit/write calls that applied cleanly. */
  editApplyRate: number;
  /** Three-stage diagnostic metrics for transcript-mined cases, when any ran. */
  traceEval?: TraceEvalMetrics | undefined;
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
