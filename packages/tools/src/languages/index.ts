export { detectLanguageWorkspaces } from './detect.js';
export {
  diagnosticsForInternalSyntax,
  type ParsedPackageReports,
  parseLanguageDiagnostics,
  parsePackageReports,
} from './diagnostics.js';
export {
  type ExecuteLanguagePlanOptions,
  type ExecutePackagePlanOptions,
  executeLanguagePlan,
  executePackagePlan,
} from './execute.js';
export {
  languageTool,
  type LanguageToolInput,
  type LanguageToolOutput,
} from './execute-tool.js';
export {
  type LanguagePackageInput,
  type LanguagePackageToolOutput,
  languagePackageTool,
} from './package-tool.js';
export { planLanguageOperation, validateCommandPlan } from './plan.js';
export { ADDITIONAL_LANGUAGE_PROFILES } from './profiles/additional.js';
export { PRIMARY_LANGUAGE_PROFILES } from './profiles/primary.js';
export {
  LanguageProfileRegistry,
  languageProfileRegistry,
  validateLanguageProfile,
} from './registry.js';
export {
  languageInfoTool,
  type LanguageCapabilitiesOutput,
  type LanguageInfoInput,
  type LanguageInfoOutput,
} from './tool.js';
export type {
  CommandPlan,
  DetectedWorkspace,
  DetectionLimits,
  DetectionResult,
  DetectLanguageOptions,
  DetectorRule,
  EvidenceKind,
  LanguageDiagnostic,
  LanguageDiagnosticPosition,
  LanguageEvidence,
  LanguageOperation,
  LanguageOperationOptions,
  LanguagePackageMutation,
  LanguagePackageOutcome,
  LanguagePackageVulnerability,
  LanguageProfile,
  LanguageProfileId,
  LanguageRunResult,
  LanguageRunSummary,
  PackageMutation,
  PackageRead,
  PlanLanguageOptions,
  PlanLanguageResult,
  ProfileContext,
  UnavailableOperation,
} from './types.js';
