/**
 * TechStack — public package barrel.
 *
 * Re-exports the foundation types, the ecosystem adapter contract, the PURL
 * utilities, and the discovery wrapper. Inventory/enrichment/audit engines,
 * registry clients, advisory clients, the policy classifier, the SQLite
 * store, the report generator, and the idle-delivery coordinator are
 * scheduled for later rollout phases per docs/specs/techstack-sdd.md §9.
 *
 * @see docs/specs/techstack-sdd.md
 */

// ── Tier C adapters (§6) ────────────────────────────────────────────────
export { CppAdapter, cppAdapter } from './adapters/cpp.js';
export { DartAdapter, dartAdapter } from './adapters/dart.js';
export { DotNetAdapter, dotNetAdapter } from './adapters/dotnet.js';
export { ElixirAdapter, elixirAdapter } from './adapters/elixir.js';
export { GoAdapter, goAdapter } from './adapters/go.js';
export { GradleAdapter, gradleAdapter } from './adapters/gradle.js';
// ── Ecosystem adapter contract (§3.2) ────────────────────────────────────
export type {
  AdvisoryEvidence,
  AuditOptions,
  EcosystemAdapter,
  InventoryOptions,
  RegistryEvidence,
} from './adapters/interface.js';
// ── Tier B adapters (§6) ────────────────────────────────────────────────
export { MavenAdapter, mavenAdapter } from './adapters/maven.js';
// ── Ecosystem adapters (§6) ──────────────────────────────────────────────
export { NpmAdapter, npmAdapter } from './adapters/npm.js';
export { PhpAdapter, phpAdapter } from './adapters/php.js';
export { PythonAdapter, pythonAdapter } from './adapters/python.js';
export { RubyAdapter, rubyAdapter } from './adapters/ruby.js';
export { RustAdapter, rustAdapter } from './adapters/rust.js';
export { SwiftAdapter, swiftAdapter } from './adapters/swift.js';
export type {
  AuditCommandResult,
  AuditCommandRunner,
  ConfiguredAuditRunner,
  NativeAdvisory,
  NativeAuditResult,
} from './advisory/native-audit.js';
// ── Native audit adapters (§6) ────────────────────────────────────────────
export {
  createAuditRunner,
  isNativeAuditAvailable,
  runNativeAudit,
  runNpmAudit,
} from './advisory/native-audit.js';
export type { OsvAdvisory, OsvBatchResult } from './advisory/osv.js';
// ── OSV advisory client (§5) ──────────────────────────────────────────────
export { queryOsvBatch, queryOsvSingle } from './advisory/osv.js';
export type { DeliveryCoordinatorOptions, DeliveryResult } from './delivery/coordinator.js';
// ── Delivery coordinator (§5) ────────────────────────────────────────────
export { attemptDelivery, drainPendingDeliveries } from './delivery/coordinator.js';
// ── Discovery wrapper (§3.2) ─────────────────────────────────────────────
export {
  coverageForEcosystem,
  discoverWorkspaces,
  mapDetectedWorkspace,
} from './discovery/workspace.js';
export {
  assessLicense,
  createLicenseFinding,
  type LicenseCategory,
  type LicenseRiskAssessment,
  normalizeLicenseId,
} from './policy/license.js';
export {
  detectWorkspaceMisalignments,
  type VersionMisalignment,
} from './policy/misalignment.js';
export type { AdvisoryStatusData, RegistryStatusData } from './policy/status.js';
// ── Policy / status & license classification (§7) ─────────────────────────
export {
  classifyStatus,
  compareVersions,
  failedLookupStatus,
  privateOrUnresolvedStatus,
} from './policy/status.js';
export type { RegistryEntry, RegistryLookupOptions } from './registry/client.js';
// ── Registry client (§5) ──────────────────────────────────────────────────
export {
  clearRegistryCache,
  invalidateRegistryCache,
  lookupRegistry,
  lookupRegistryBatch,
  RegistryAuthError,
  RegistryNetworkError,
  RegistryNotFoundError,
  RegistryRateLimitError,
  supportedRegistryEcosystems,
} from './registry/client.js';
// ── PURL utilities (§4.1) ────────────────────────────────────────────────
export {
  buildPurl,
  constructPurl,
  ecosystemForPurlType,
  type ParsedEcosystemPurl,
  type PurlParts,
  parsePurl,
  parsePurlEcosystem,
  purlTypeForEcosystem,
} from './registry/purl.js';
export type {
  ApplyPlanOptions,
  ApplyPlanResult,
  PackageOperation,
  PackageOperationExecutor,
  UpgradePlan,
  UpgradePlanItem,
} from './remediation.js';
// ── Remediation planning (§9) ─────────────────────────────────────────────
export {
  applyPlan,
  generateUpgradePlan,
  renderPlanMarkdown,
  toLanguagePackageInput,
} from './remediation.js';
export type {
  CreateResearcherOptions,
  LlmAccessor,
  ResearchCluster,
  ResearchLlm,
  ResearchLlmRequest,
  ResearchOptions,
  ResearchSearch,
  ResearchSearchResult,
  SearchToolOptions,
  TechStackResearcher,
  TriageCandidate,
  TriageOptions,
} from './research/index.js';
// ── Research stage (§31, §557) ────────────────────────────────────────────
export {
  clusterCandidates,
  createProviderLlm,
  createResearcher,
  createToolSearch,
  DEFAULT_TRIAGE_LIMIT,
  parseResearchJson,
  triageCandidates,
} from './research/index.js';
export type { CycloneDXBom, SpdxDocument } from './sbom.js';
// ── SBOM export (§9) ─────────────────────────────────────────────────────
export { toCycloneDX, toSpdx } from './sbom.js';
export type { AnalyzeOptions, EnrichOptions, ReportFormat } from './service.js';

// ── Service engine (§3.2) ─────────────────────────────────────────────────
export { TechStackEngine } from './service.js';
export type { SnapshotDiff } from './snapshot-diff.js';
// ── Snapshot diff (§9) ───────────────────────────────────────────────────
export { diffSnapshots } from './snapshot-diff.js';
export { applySchema, DDL } from './store/schema.js';

// ── SQLite store (§3.2) ──────────────────────────────────────────────────
export { TechStackStore } from './store/sqlite.js';
export type { DependencyTrend, SnapshotSource, TrendReport } from './trend.js';
// ── Cross-snapshot trend analysis ─────────────────────────────────────────
export { renderTrendMarkdown, TrendStore } from './trend.js';
// ── Core domain types (§4.1) ─────────────────────────────────────────────
export type {
  Coverage,
  DeliveryOutbox,
  DeliveryStatus,
  DependencyObservation,
  DependencyScope,
  DependencyStatus,
  EcosystemId,
  Evidence,
  Finding,
  Snapshot,
  SourceType,
  TechStackJob,
  TechStackJobKind,
  TechStackJobProgress,
  TechStackJobStatus,
  Workspace,
} from './types.js';
