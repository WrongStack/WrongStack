export { DefaultPluginAPI, definePlugin, type PluginAPIInit } from './api.js';
export {
  diffPluginConfig,
  type PluginConfigChange,
  type PluginConfigSource,
  type PluginEnablementSource,
  pluginEntryMatchesName,
  type ResolvePluginConfigInput,
  type ResolvePluginEnablementInput,
  type ResolvedPluginConfig,
  type ResolvedPluginEnablement,
  redactPluginConfig,
  resolvePluginConfig,
  resolvePluginEnablement,
  resolvePluginManifestConfig,
  validatePluginConfigMetadata,
} from './config.js';
export {
  KERNEL_API_VERSION,
  loadPlugins,
  type LoadPluginsOptions,
  type PluginHostHandle,
  type PluginLoadFailure,
  unloadPlugins,
} from './loader.js';
export type { PluginAPI } from '../types/plugin.js';
export {
  buildReviewerModelPool,
  createAutoReviewPlugin,
  parseReviewSeverity,
  type ReviewerModelAssignment,
  selectRoundRobinReviewerAssignment,
} from '../plugins/auto-review-plugin.js';
export {
  type CascadeAgentKind,
  CHIMERA_REVIEW_PROMPT,
  createChimeraPlugin,
  type ChimeraCascadeNeededPayload,
  type ChimeraReviewCompletePayload,
  type ChimeraReviewNeededPayload,
  type ReviewContextBundle,
} from '../plugins/chimera-plugin.js';
export { createPromptsPlugin } from '../plugins/prompts-plugin.js';
export {
  emitReviewIfChanged,
  recordCompletedReview,
  recordStartedReview,
} from '../plugins/review-claim-registry.js';
export {
  type FindingsIntegrationResult,
  integrateFindings,
} from '../plugins/review-finding-integration.js';
export {
  type ParsedReviewReport,
  parseChimeraReviewReport,
} from '../plugins/review-finding-parser.js';
export {
  persistReviewReport,
  type ReportIntegrationResult,
} from '../plugins/review-report-integration.js';
export {
  maybeCompactReviewStores,
  type ReviewStoreMaintenanceResult,
} from '../plugins/review-store-maintenance.js';
export { createSkillsPlugin } from '../plugins/skills-plugin.js';
export { createSyncPlugin } from '../plugins/sync-plugin.js';
export { createCloudConfigSyncPlugin } from '../plugins/cloud-config-sync-plugin.js';
