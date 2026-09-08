export {
  buildReviewerModelPool,
  createAutoReviewPlugin,
  parseReviewSeverity,
  type ReviewerModelAssignment,
  selectRoundRobinReviewerAssignment,
} from '../plugins/auto-review-plugin.js';
export {
  type CascadeAgentKind,
  type CascadeEvidenceCheckResult,
  type CascadeEvidenceStatus,
  CHIMERA_REVIEW_PROMPT,
  type ChimeraCascadeNeededPayload,
  type ChimeraReviewCompletePayload,
  type ChimeraReviewNeededPayload,
  createChimeraPlugin,
  type ReviewContextBundle,
} from '../plugins/chimera-plugin.js';
export { createCloudConfigSyncPlugin } from '../plugins/cloud-config-sync-plugin.js';
export { createPromptsPlugin } from '../plugins/prompts-plugin.js';
export {
  emitReviewIfChanged,
  recordCompletedReview,
  recordStartedReview,
} from '../plugins/review-claim-registry.js';
export {
  classifyChimeraReviewSource,
  type FindingsIntegrationResult,
  integrateFindings,
} from '../plugins/review-finding-integration.js';
export {
  type ParsedReviewReport,
  parseChimeraReviewReport,
} from '../plugins/review-finding-parser.js';
export {
  FINDING_STORE_FILE,
  type FindingStore,
  JsonlFindingStore,
  type ListOptions as FindingListOptions,
  resolveFindingStorePath,
  type UpsertContext,
  type UpsertResult,
} from '../plugins/review-finding-store.js';
export type {
  ChimeraFinding,
  ChimeraFindingLocation,
  ChimeraFindingOrigin,
  ChimeraFindingResolution,
  FindingCategory,
  FindingConfidence,
  FindingEventType,
  FindingLifecycleEvent,
  FindingSeverity,
  FindingSource,
  FindingStatus,
  FindingVerification,
  FindingVerificationStatus,
  ResolutionOutcome,
} from '../plugins/review-finding-types.js';
export {
  type VerifyFindingsOptions,
  verifyFindingsAgainstDisk,
} from '../plugins/review-finding-verification.js';
export {
  persistReviewReport,
  type ReportIntegrationResult,
  type ReportReopenResult,
  type ReportSyncResult,
  syncReportCompletion,
  syncReportReopen,
  updateReviewReportEvidence,
} from '../plugins/review-report-integration.js';
export {
  JsonlReportStore,
  type ListReportsOptions,
  type PersistReportInput,
  REPORT_STORE_FILE,
  type ReportStore,
  resolveReportStorePath,
} from '../plugins/review-report-store.js';
export type {
  ReportActorKind,
  ReportEventType,
  ReportLifecycleStatus,
  ReviewReport,
  ReviewReportCounts,
  ReviewReportEvent,
  ReviewReportFile,
} from '../plugins/review-report-types.js';
export {
  maybeCompactReviewStores,
  type ReviewStoreMaintenanceResult,
} from '../plugins/review-store-maintenance.js';
export { createSkillsPlugin } from '../plugins/skills-plugin.js';
export {
  createSpecialistTriggerPlugin,
  type SpecialistNeededPayload,
} from '../plugins/specialist-trigger-plugin.js';
export {
  DEFAULT_SPECIALIST_TRIGGERS,
  matchSpecialistTriggers,
  type ResolvedSpecialistTriggerConfig,
  resolveSpecialistTriggerConfig,
  type SpecialistTriggerConfig,
  type SpecialistTriggerMatch,
  type SpecialistTriggerRule,
  specialistFireKey,
  specialistTaskText,
} from '../plugins/specialist-trigger-rules.js';
export { createSyncPlugin } from '../plugins/sync-plugin.js';
export type { PluginAPI } from '../types/plugin.js';
export { DefaultPluginAPI, definePlugin, type PluginAPIInit } from './api.js';
export {
  diffPluginConfig,
  type PluginConfigChange,
  type PluginConfigSource,
  type PluginEnablementSource,
  pluginEntryMatchesName,
  type ResolvedPluginConfig,
  type ResolvedPluginEnablement,
  type ResolvePluginConfigInput,
  type ResolvePluginEnablementInput,
  redactPluginConfig,
  resolvePluginConfig,
  resolvePluginEnablement,
  resolvePluginManifestConfig,
  validatePluginConfigMetadata,
} from './config.js';
export {
  DEFAULT_PLUGIN_DISCOVERY_IO,
  type DiscoveryIo,
  discoverExternalPlugins,
  type ExternalPluginCandidate,
  type PluginDiscoveryResult,
  resolvePluginEntryPath,
  resolvePluginTarget,
  type SkippedPluginCandidate,
} from './discovery.js';
export {
  KERNEL_API_VERSION,
  type LoadPluginsOptions,
  loadPlugins,
  type PluginHostHandle,
  type PluginLoadFailure,
  unloadPlugins,
} from './loader.js';
export {
  defaultPluginTrustPath,
  hashFileContents,
  normalizeTrustKey,
  type PluginTrustEntry,
  type PluginTrustStore,
  type PluginTrustVerification,
  pinPluginTrust,
  readPluginTrustStore,
  unpinPluginTrust,
  verifyPluginTrust,
  writePluginTrustStore,
} from './trust.js';
