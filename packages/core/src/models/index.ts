// Models domain: model registry, mode store, LLM selection
export type { ModelBlackoutRule } from '../core/model-availability-calendar.js';
export {
  DefaultModelsRegistry,
  classifyFamily,
  type DefaultModelsRegistryOptions,
} from './models-registry.js';
export {
  DefaultModeStore,
  loadProjectModes,
  loadUserModes,
  type ModeLoaderOptions,
} from './mode-store.js';
export { LLMSelector, type LLMSelectorOptions } from './llm-selector.js';
export {
  resolveProviderModelList,
  describeCatalogModel,
  type ProviderModelDescriptor,
} from './provider-model-resolve.js';
export { CODEX_MODELS, codexModelMeta, type CodexModelMeta } from './codex-catalog.js';
export {
  ALIBABA_TOKEN_PLAN_MODELS,
  alibabaTokenPlanModelMeta,
  type AlibabaTokenPlanModelMeta,
} from './alibaba-token-plan-catalog.js';

// models.dev schema (ME-1): runtime-validated mirror of models.dev/api.json
export {
  MODELS_DEV_MODALITY_VALUES,
  modelsDevCostSchema,
  modelsDevLimitSchema,
  modelsDevModalitiesSchema,
  modelsDevModelSchema,
  modelsDevPayloadSchema,
  modelsDevProviderSchema,
  type ModelsDevModelParsed,
  type ModelsDevPayloadParsed,
  type ModelsDevProviderParsed,
  type ModelsDevSchemaSyncProof,
} from './models-dev-schema.js';

// Model intelligence: capability profiles and auto-routing
export {
  MODEL_PROFILES,
  TASK_TO_ROLE,
  inferTaskType,
  findModelProfile,
  scoreModelForTask,
  type ModelProfile,
  type TaskType,
} from './model-intelligence.js';
export {
  ModelRouter,
  type RouterConfig,
  type ModelPick,
  type RouterCosts,
  type ModelIntelligenceEntry,
} from './model-router.js';
export {
  hasProviderCredential,
  hasProviderKeyInConfig,
  hasProviderKeyInEnv,
  type ProviderCredentialConfig,
  type ProviderCredentialSubject,
} from './provider-credentials.js';
