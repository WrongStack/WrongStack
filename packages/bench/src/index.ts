/**
 * @wrongstack/bench — model-independent agentic benchmark harness.
 *
 * Holds the WrongStack harness fixed (system prompt + tool set + agent loop +
 * scaffolding) and swaps only the model, then grades the result with the
 * suite's own tests (never an LLM). Every report is stamped with a harness
 * fingerprint so leaderboard rows are comparable only when the harness matches.
 */

export { aggregateAll, aggregateCell, median } from './aggregate.js';
export { loadBenchConfig, parseBenchConfig } from './config.js';
export { type ExecResult, execCommand } from './exec-command.js';
export {
  computeHarnessFingerprint,
  computeStableJsonHash,
  computeTextHash,
  computeToolManifestHash,
  fingerprintLabel,
  type ToolManifestFingerprintInput,
} from './fingerprint.js';
// Graders
export { gradePolyglot } from './graders/polyglot-grader.js';
export { gradeLocalManifest } from './graders/local-manifest-grader.js';
export { gradeSwebench, type SwebenchExternalGrade } from './graders/swebench-grader.js';
export {
  cleanupSandbox,
  createSandbox,
  prepareWorkdir,
  type Sandbox,
} from './isolation.js';
export { type RunBenchmarkOptions, runBenchmark } from './orchestrate.js';
export { readSummary, writeJsonArtifacts } from './report/json.js';
export { renderMarkdownReport, reportHeaderLine } from './report/markdown.js';
export {
  collectCellPredictions,
  parseResolvedIds,
  type SwebenchPrediction,
  writeInstancePrediction,
  writePredictionsJsonl,
} from './report/predictions.js';
export { mapWithConcurrency, type RunWstackOptions, runWstack } from './runner.js';
export { readToolMetrics } from './session-metrics.js';
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
export * from './types.js';
