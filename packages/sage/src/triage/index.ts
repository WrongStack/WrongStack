export { preFilter, preFilterBatch } from './pre-filter.js';
export type { PreFilterResult, PreFilterVerdict } from './pre-filter.js';

export { computeValueScore, computeValueScores } from './value-score.js';
export type { ValueScoreBreakdown, ValueBand } from './value-score.js';

export { evaluateMemory, evaluateBatch } from './llm-evaluator.js';
export type {
  LlmEvaluation,
  LlmTriageResult,
  LlmCallFn,
  LlmEvaluatorOptions,
  TriageAction,
} from './llm-evaluator.js';

export { dispatchAction, dispatchBatch } from './action-dispatcher.js';
export type {
  MemoryFieldUpdate,
  AutoApplyAction,
  TriageProposal,
  DispatchResult,
} from './action-dispatcher.js';

export { detectMerges } from './merge-detection.js';
export type {
  MemoryCluster,
  MergeCandidate,
  MergeVerdict,
  MergePairResult,
  MergeAction,
  OverlapProposal,
  MergeDetectionResult,
} from './merge-detection.js';

export { runTriage, formatTriageReport } from './orchestrator.js';
export type { TriageReport, RunTriageOptions } from './orchestrator.js';
