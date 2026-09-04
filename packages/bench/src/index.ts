/**
 * @wrongstack/bench — model-independent agentic benchmark harness.
 *
 * Holds the WrongStack harness fixed (system prompt + tool set + agent loop +
 * scaffolding) and swaps only the model, then grades the result with the
 * suite's own tests (never an LLM). Every report is stamped with a harness
 * fingerprint so leaderboard rows are comparable only when the harness matches.
 */

export { aggregateAll, aggregateCell, median } from './aggregate.js';
export {
  buildIntraRunInsights,
  type CellDelta,
  type CrossRunTaskDelta,
  compareReports,
  type IntraRunDisagreement,
  type IntraRunInsights,
  outcomeFromResult,
  type RunComparison,
  type TaskOutcome,
} from './compare.js';
export {
  CORE_CONFIG_DEFAULTS,
  configFromCells,
  loadBenchConfig,
  parseBenchConfig,
  parseCellList,
  SMOKE_CONFIG_DEFAULTS,
} from './config.js';
export { type ExecResult, execCommand } from './exec-command.js';
export {
  computeHarnessFingerprint,
  computeStableJsonHash,
  computeTextHash,
  computeToolManifestHash,
  fingerprintLabel,
  type ToolManifestFingerprintInput,
} from './fingerprint.js';
export { gradeLocalManifest } from './graders/local-manifest-grader.js';
// Graders
export { gradePolyglot } from './graders/polyglot-grader.js';
export { gradeSwebench, type SwebenchExternalGrade } from './graders/swebench-grader.js';
export {
  behaviorConfigProjection,
  cleanupSandbox,
  createSandbox,
  prepareWorkdir,
  type Sandbox,
} from './isolation.js';
export { type RunBenchmarkOptions, runBenchmark, runFailureReason } from './orchestrate.js';
export { readResultsJsonl, readRunDir, readSummary, writeJsonArtifacts } from './report/json.js';
export {
  renderComparisonMarkdown,
  renderMarkdownReport,
  reportHeaderLine,
} from './report/markdown.js';
export {
  collectCellPredictions,
  parseResolvedIds,
  type SwebenchPrediction,
  writeInstancePrediction,
  writePredictionsJsonl,
} from './report/predictions.js';
export { mapWithConcurrency, type RunWstackOptions, runWstack } from './runner.js';
export { readSessionLogEvents, readToolMetrics, type SessionLogEvent } from './session-metrics.js';
export {
  CORE_TASK_COUNT,
  createCoreSuite,
  resolveCoreSuiteDir,
} from './suites/core.js';
// Suites
export {
  createLocalManifestSuite,
  DEFAULT_LOCAL_MANIFEST,
  type LocalAssertion,
  type LocalCommandGrader,
  type LocalSuiteOptions,
  type LocalTaskMeta,
} from './suites/local-manifest.js';
export { createPolyglotSuite, LANGUAGE_RUNNERS, type PolyglotMeta } from './suites/polyglot.js';
export {
  createSmokeSuite,
  resolveSmokeSuiteDir,
  SMOKE_TASK_COUNT,
} from './suites/smoke.js';
export {
  createSwebenchSuite,
  loadSubset,
  type SwebenchMeta,
  type SwebenchOptions,
} from './suites/swebench.js';
export {
  type Exec,
  extractModelPatch,
  extractPatchPaths,
  filterPatchExcludingPaths,
  filterPatchSections,
} from './suites/swebench-patch.js';
export { evaluateTraceEval } from './trace-eval.js';
export {
  type MinedTraceEvalDraft,
  type MineTranscriptResult,
  mineTranscript,
} from './transcript-mine.js';
export * from './types.js';
