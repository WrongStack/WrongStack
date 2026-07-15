// Execution domain: compaction, tool execution, error handling, retry, skill loading

export {
  AutoCompactionMiddleware,
  type ContextWindowBudgetSnapshot,
} from './auto-compaction-middleware.js';
export {
  AutonomousRunner,
  type AutonomousRunnerOptions,
  type DoneCheckResult,
  DoneConditionChecker,
} from './autonomous-runner.js';
export {
  type AutonomyBrainOptions,
  type BrainAutoRisk,
  type BrainLlmTarget,
  buildBrainUserMessage,
  completeBrainLlm,
  createAutonomyBrain,
  createTieredBrainArbiter,
  formatDecisionSummary,
  parseOptionDecision,
  type TieredBrainArbiterOptions,
} from './autonomy-brain.js';
export {
  assembleBrainTiers,
  type BrainTierAssembly,
  type BrainTierAssemblyOptions,
} from './brain-chain.js';
export {
  BRAIN_EVALUATION_CASE_VERSION,
  type BrainEvaluationCaseResult,
  type BrainEvaluationCaseV1,
  type BrainEvaluationCaseValidation,
  type BrainEvaluationExpectations,
  type BrainEvaluationFailure,
  type BrainEvaluationFailureCode,
  type BrainEvaluationMetrics,
  type BrainEvaluationReport,
  runBrainEvaluation,
  validateBrainEvaluationCase,
} from './brain-evaluation.js';
export {
  type BrainApplyResult,
  type BrainConfigPatch,
  type BrainConfigSnapshot,
  type BrainCouncilMinRisk,
  type BrainCouncilPatch,
  type BrainDefaultsContext,
  type BrainPoolStrategy,
  type BrainRuntime,
  type BrainRuntimeLedgerHost,
  type BrainRuntimeOptions,
  createBrainRuntime,
  resolveBrainConfigDefaults,
} from './brain-runtime.js';
export {
  COUNCIL_REFUSE_OPTION_ID,
  type CouncilBrainOptions,
  type CouncilVoter,
  createCouncilBrainArbiter,
} from './council-brain.js';
export {
  type CouncilResolution,
  type CouncilResolutionInput,
  type CouncilResolutionSeat,
  type CouncilResolutionVote,
  resolveCouncilVotes,
} from './council-resolution.js';
export {
  BUILTIN_COUNCIL_PERSONAS,
  CouncilPersonaRegistry,
  createCouncilPersonaRegistry,
  DEFAULT_COUNCIL_PERSONA_REGISTRY,
} from './council-personas.js';
export {
  BUILTIN_COUNCIL_PROFILES,
  CouncilProfileRegistry,
  createCouncilProfileRegistry,
  DEFAULT_COUNCIL_APPROVAL_FRACTION,
  DEFAULT_COUNCIL_JUDGE_MAX_TOKENS,
  DEFAULT_COUNCIL_OVERALL_TIMEOUT_MS,
  DEFAULT_COUNCIL_PER_CALL_TIMEOUT_MS,
  DEFAULT_COUNCIL_PROFILE_REGISTRY,
  DEFAULT_COUNCIL_QUORUM_FRACTION,
  DEFAULT_COUNCIL_VOTER_MAX_TOKENS,
  normalizeCouncilProfile,
  resolveCouncilProfile,
} from './council-profiles.js';
export {
  buildCouncilJudgeSystemPrompt,
  buildCouncilJudgeUserPrompt,
  buildCouncilQuestionPrompt,
  buildCouncilVoterSystemPrompt,
  buildCouncilVoterUserPrompt,
  COUNCIL_JUDGE_PROMPT_PATH,
  COUNCIL_VOTER_PROMPT_PATH,
} from './council-prompts.js';
export {
  COUNCIL_REFUSAL_OPTION_ID,
  CouncilOrchestrator,
  type CouncilOrchestratorOptions,
  DEFAULT_COUNCIL_MAX_CONCURRENCY,
  MAX_COUNCIL_CONCURRENCY,
} from './council-orchestrator.js';
export {
  type AutonomyPromptContributorOptions,
  makeAutonomyPromptContributor,
} from './autonomy-prompt-contributor.js';
export { type CompactorOptions, HybridCompactor } from './compactor.js';
export {
  activateDesign,
  clearActiveKit,
  detectFrontendFile,
  detectFrontendIntent,
  getDesignState,
  installDesignStudioMiddleware,
  makeDesignDetectToolCallMiddleware,
  makeDesignDetectUserInputMiddleware,
  makeDesignStudioRequestMiddleware,
  setActiveKit,
} from './design-detect.js';
export {
  _resetDesignKitLoaderMemo,
  DefaultDesignKitLoader,
  type DesignKitLoaderOptions,
  getDesignKitLoader,
  resolveBundledDesignKitsDir,
} from './design-kit-loader.js';
export {
  _resetDesignRulesCache,
  clearPersistedActiveKit,
  designProjectDir,
  loadActiveKit,
  loadProjectDesignRules,
  type PersistedActiveKit,
  recordKitChoice,
} from './design-project-store.js';
// Full error-handler surface — PR-C1 (66c4eb68) moved consumers here from
// the types/ barrel, which used to `export *` this module.
export {
  buildRecoveryStrategies,
  DEFAULT_RECOVERY_STRATEGIES,
  DefaultErrorHandler,
  type RecoveryStrategy,
} from './error-handler.js';
export {
  EternalAutonomyEngine,
  type EternalAutonomyOptions,
  type EternalEngineState,
  type IterationStage,
} from './eternal-autonomy.js';
export { buildGoalPreamble } from './goal-preamble.js';
export { IntelligentCompactor, type IntelligentCompactorOptions } from './intelligent-compactor.js';
export {
  applyModelRuntime,
  mergeModelRuntime,
  type ModelRuntimeMiddlewareOptions,
  type ResolvedModelRuntime,
  resolveCacheForRequest,
  resolveModelRuntime,
  resolveReasoningForRequest,
} from './model-runtime.js';
export {
  type ParallelEngineState,
  ParallelEternalEngine,
  type ParallelEternalOptions,
  type ParallelIterationStage,
} from './parallel-eternal-engine.js';
export { DefaultRetryPolicy } from './retry-policy.js';
export { SelectiveCompactor, type SelectiveCompactorOptions } from './selective-compactor.js';
export { DefaultSkillLoader, type SkillLoaderOptions } from './skill-loader.js';
export { DefaultPromptLoader, type PromptLoaderOptions, renderPrompt } from './prompt-loader.js';
export {
  type CompactorStrategy,
  createStrategyCompactor,
  type StrategyCompactorOptions,
} from './strategy-compactor.js';
export { ToolExecutor } from './tool-executor.js';
export { OneShotOrchestrator } from './one-shot-llm.js';
