/**
 * Built-in WrongStack plugins: chimera and auto-review (with the review
 * finding/report/claim stores), skills, prompts, sync, cloud-config sync and
 * specialist triggers. Extracted from `@wrongstack/core` (`src/plugins`).
 */
export {
  buildReviewerModelPool,
  createAutoReviewPlugin,
  parseReviewSeverity,
  type ReviewerModelAssignment,
  selectRoundRobinReviewerAssignment,
} from './auto-review-plugin.js';
export {
  type CascadeAgentKind,
  type CascadeEvidenceCheckResult,
  type CascadeEvidenceStatus,
  CHIMERA_REVIEW_PROMPT,
  type ChimeraCascadeNeededPayload,
  type ChimeraReviewCompletePayload,
  type ChimeraReviewNeededPayload,
  createChimeraPlugin,
  type ResolvedChimeraConfig,
  type ReviewContextBundle,
  type ReviewFileEntry,
  type ReviewPriorFindingSummary,
  type ReviewScopeFileManifest,
  type ReviewScopeManifest,
  type ReviewSkippedFile,
  type ReviewSkippedFileReason,
  type ReviewUsageMetrics,
  resolveChimeraConfig,
} from './chimera-plugin.js';
export { createCloudConfigSyncPlugin } from './cloud-config-sync-plugin.js';
export { createPromptsPlugin } from './prompts-plugin.js';
export { createChimeraReportSessionResolver } from './report-session-resolver.js';
export {
  type CompletedReviewFileSnapshot,
  emitReviewIfChanged,
  getCompletedReviewSnapshots,
  isFileContentAlreadyReviewed,
  recordCompletedReview,
  recordStartedReview,
} from './review-claim-registry.js';
export {
  type AnnotatedDiffResult,
  annotateUnifiedDiffWithLineNumbers,
  type BuildReviewContextOptions,
  buildReviewContext,
  computeHybridIncrementalDeltaDiff,
  isIgnoredReviewNoisePath,
  prioritizeReviewCandidates,
  parsePorcelainStatusZ,
  statusUnderPrefix,
} from './review-context-builder.js';
export {
  executeFindingCommand,
  type FindingCommandContext,
  transitionReport,
} from './review-finding-commands.js';
export {
  classifyChimeraReviewSource,
  type FindingsIntegrationResult,
  integrateFindings,
} from './review-finding-integration.js';
export {
  extractStructuredFindingsBlock,
  type ParsedReviewReport,
  parseChimeraReviewReport,
  renderChimeraReportMarkdown,
} from './review-finding-parser.js';
export {
  FINDING_STORE_FILE,
  type FindingStore,
  JsonlFindingStore,
  type ListOptions as FindingListOptions,
  resolveFindingStorePath,
  type UpsertContext,
  type UpsertResult,
} from './review-finding-store.js';
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
} from './review-finding-types.js';
export {
  type VerifyFindingsOptions,
  verifyFindingsAgainstDisk,
} from './review-finding-verification.js';
export {
  buildReviewScopeManifest,
  persistReviewReport,
  type ReportIntegrationResult,
  type ReportReopenResult,
  type ReportSyncResult,
  syncReportCompletion,
  syncReportReopen,
  updateReviewReportEvidence,
} from './review-report-integration.js';
export {
  JsonlReportStore,
  type ListReportsOptions,
  type PersistReportInput,
  REPORT_STORE_FILE,
  type ReportActor,
  type ReportStore,
  resolveReportStorePath,
} from './review-report-store.js';
export type {
  ReportActorKind,
  ReportEventType,
  ReportLifecycleStatus,
  ReviewReport,
  ReviewReportCounts,
  ReviewReportEvent,
  ReviewReportFile,
} from './review-report-types.js';
export {
  maybeCompactReviewStores,
  type ReviewStoreMaintenanceResult,
} from './review-store-maintenance.js';
export { createSkillsPlugin } from './skills-plugin.js';
export {
  createSpecialistTriggerPlugin,
  type SpecialistNeededPayload,
} from './specialist-trigger-plugin.js';
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
} from './specialist-trigger-rules.js';
export { createSyncPlugin } from './sync-plugin.js';
