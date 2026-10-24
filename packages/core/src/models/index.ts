// Models domain: model registry, mode store, LLM selection
export type { ModelBlackoutRule } from '@wrongstack/contracts/types/model-availability';
export {
  ALIBABA_TOKEN_PLAN_MODELS,
  type AlibabaTokenPlanModelMeta,
  alibabaTokenPlanModelMeta,
} from './alibaba-token-plan-catalog.js';
export {
  BACKGROUND_CATALOG_REFRESH_INTERVAL_MS,
  type CatalogRefreshOutcome,
  type CatalogStartupOptions,
  type CatalogStartupResult,
  RECENT_CATALOG_REFRESH_SECONDS,
  refreshCatalogIfStale,
  startCatalog,
} from './catalog-refresh.js';
export { CODEX_MODELS, type CodexModelMeta, codexModelMeta } from './codex-catalog.js';
// The built-in mode catalog (moved from `types/`: its prompts load from disk).
export { DEFAULT_MODES } from './default-modes.js';
export {
  buildFallbackSuggestPrompt,
  DEFAULT_MAX_AGE_MONTHS,
  excludeListedModels,
  FALLBACK_SUGGEST_JSON_SCHEMA,
  FALLBACK_SUGGEST_SYSTEM_PROMPT,
  FALLBACK_SUGGESTION_IDS,
  type FallbackSuggestCandidate,
  type FallbackSuggestion,
  type FallbackSuggestionEntry,
  type FallbackSuggestionId,
  formatFallbackRef,
  isFallbackEligible,
  isModelRefListed,
  LLM_POOL_LIMIT,
  type LlmMergeResult,
  mergeLlmFallbackSuggestions,
  modelVersion,
  type ScoredFallbackCandidate,
  type SuggestFallbackOptions,
  scoreFallbackCandidates,
  selectLlmCandidatePool,
  suggestFallbackProfiles,
} from './fallback-suggest.js';
export { LLMSelector, type LLMSelectorOptions } from './llm-selector.js';
export {
  DefaultModeStore,
  loadProjectModes,
  loadUserModes,
  type ModeLoaderOptions,
} from './mode-store.js';
// Model intelligence: capability profiles and auto-routing
export {
  findModelProfile,
  inferTaskType,
  MODEL_PROFILES,
  type ModelProfile,
  scoreModelForTask,
  TASK_TO_ROLE,
  type TaskType,
} from './model-intelligence.js';
export {
  type ModelIntelligenceEntry,
  type ModelPick,
  ModelRouter,
  type RouterConfig,
  type RouterCosts,
} from './model-router.js';
// models.dev schema (ME-1): runtime-validated mirror of models.dev/api.json
export {
  MODELS_DEV_MODALITY_VALUES,
  type ModelsDevModelParsed,
  type ModelsDevPayloadParsed,
  type ModelsDevProviderParsed,
  type ModelsDevSchemaSyncProof,
  modelsDevCostSchema,
  modelsDevLimitSchema,
  modelsDevModalitiesSchema,
  modelsDevModelSchema,
  modelsDevPayloadSchema,
  modelsDevProviderSchema,
} from './models-dev-schema.js';
export {
  classifyFamily,
  DefaultModelsRegistry,
  type DefaultModelsRegistryOptions,
  type RuntimeModelsOverlayOptions,
} from './models-registry.js';
export {
  hasProviderCredential,
  hasProviderKeyInConfig,
  hasProviderKeyInEnv,
  isKeylessLocalProvider,
  type ProviderCredentialConfig,
  type ProviderCredentialSubject,
} from './provider-credentials.js';
export {
  describeCatalogModel,
  type ProviderModelDescriptor,
  resolveProviderModelList,
} from './provider-model-resolve.js';
export { SystemOneSelector, type SystemOneSelectorOptions } from './system-one-selector.js';
