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

// ── Core domain types (§4.1) ─────────────────────────────────────────────
export type {
  Coverage,
  DependencyObservation,
  DependencyScope,
  DependencyStatus,
  DeliveryOutbox,
  DeliveryStatus,
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

// ── Ecosystem adapter contract (§3.2) ────────────────────────────────────
export type {
  AdvisoryEvidence,
  EcosystemAdapter,
  AuditOptions,
  InventoryOptions,
  RegistryEvidence,
} from './adapters/interface.js';

// ── PURL utilities (§4.1) ────────────────────────────────────────────────
export {
  buildPurl,
  constructPurl,
  ecosystemForPurlType,
  parsePurl,
  parsePurlEcosystem,
  purlTypeForEcosystem,
  type ParsedEcosystemPurl,
  type PurlParts,
} from './registry/purl.js';

// ── Discovery wrapper (§3.2) ─────────────────────────────────────────────
export {
  coverageForEcosystem,
  discoverWorkspaces,
  mapDetectedWorkspace,
} from './discovery/workspace.js';

// ── Ecosystem adapters (§6) ──────────────────────────────────────────────
export { NpmAdapter, npmAdapter } from './adapters/npm.js';
export { PythonAdapter, pythonAdapter } from './adapters/python.js';
export { RustAdapter, rustAdapter } from './adapters/rust.js';
export { GoAdapter, goAdapter } from './adapters/go.js';
export { DotNetAdapter, dotNetAdapter } from './adapters/dotnet.js';
export { PhpAdapter, phpAdapter } from './adapters/php.js';
export { DartAdapter, dartAdapter } from './adapters/dart.js';

// ── Tier B adapters (§6) ────────────────────────────────────────────────
export { MavenAdapter, mavenAdapter } from './adapters/maven.js';
export { GradleAdapter, gradleAdapter } from './adapters/gradle.js';
export { RubyAdapter, rubyAdapter } from './adapters/ruby.js';
export { SwiftAdapter, swiftAdapter } from './adapters/swift.js';
export { ElixirAdapter, elixirAdapter } from './adapters/elixir.js';

// ── Tier C adapters (§6) ────────────────────────────────────────────────
export { CppAdapter, cppAdapter } from './adapters/cpp.js';

// ── Snapshot diff (§9) ───────────────────────────────────────────────────
export { diffSnapshots } from './snapshot-diff.js';
export type { SnapshotDiff } from './snapshot-diff.js';

// ── Cross-snapshot trend analysis ─────────────────────────────────────────
export { renderTrendMarkdown, TrendStore } from './trend.js';
export type { DependencyTrend, SnapshotSource, TrendReport } from './trend.js';

// ── SBOM export (§9) ─────────────────────────────────────────────────────
export { toSpdx, toCycloneDX } from './sbom.js';
export type { CycloneDXBom, SpdxDocument } from './sbom.js';

// ── Remediation planning (§9) ─────────────────────────────────────────────
export {
  applyPlan,
  generateUpgradePlan,
  renderPlanMarkdown,
  toLanguagePackageInput,
} from './remediation.js';
export type {
  ApplyPlanOptions,
  ApplyPlanResult,
  PackageOperation,
  PackageOperationExecutor,
  UpgradePlan,
  UpgradePlanItem,
} from './remediation.js';

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
export type { RegistryEntry, RegistryLookupOptions } from './registry/client.js';

// ── OSV advisory client (§5) ──────────────────────────────────────────────
export { queryOsvBatch, queryOsvSingle } from './advisory/osv.js';
export type { OsvAdvisory, OsvBatchResult } from './advisory/osv.js';

// ── Native audit adapters (§6) ────────────────────────────────────────────
export {
  createAuditRunner,
  isNativeAuditAvailable,
  runNativeAudit,
  runNpmAudit,
} from './advisory/native-audit.js';
export type {
  AuditCommandResult,
  AuditCommandRunner,
  ConfiguredAuditRunner,
  NativeAdvisory,
  NativeAuditResult,
} from './advisory/native-audit.js';

// ── Policy / status & license classification (§7) ─────────────────────────
export {
  classifyStatus,
  compareVersions,
  failedLookupStatus,
  privateOrUnresolvedStatus,
} from './policy/status.js';
export type { AdvisoryStatusData, RegistryStatusData } from './policy/status.js';
export {
  assessLicense,
  createLicenseFinding,
  normalizeLicenseId,
  type LicenseCategory,
  type LicenseRiskAssessment,
} from './policy/license.js';
export {
  detectWorkspaceMisalignments,
  type VersionMisalignment,
} from './policy/misalignment.js';

// ── Service engine (§3.2) ─────────────────────────────────────────────────
export { TechStackEngine } from './service.js';
export type { AnalyzeOptions, EnrichOptions, ReportFormat } from './service.js';

// ── Research stage (§31, §557) ────────────────────────────────────────────
export {
  clusterCandidates,
  createProviderLlm,
  createResearcher,
  createToolSearch,
  parseResearchJson,
  triageCandidates,
  DEFAULT_TRIAGE_LIMIT,
} from './research/index.js';
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

// ── SQLite store (§3.2) ──────────────────────────────────────────────────
export { TechStackStore } from './store/sqlite.js';
export { applySchema, DDL } from './store/schema.js';

// ── Delivery coordinator (§5) ────────────────────────────────────────────
export { attemptDelivery, drainPendingDeliveries } from './delivery/coordinator.js';
export type { DeliveryCoordinatorOptions, DeliveryResult } from './delivery/coordinator.js';
