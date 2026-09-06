export { defaultTechStackDetector, TechStackDetector } from './detector.js';
export type { GatherFilesOptions } from './file-gathering.js';
export { DEFAULT_EXCLUDE_PATTERNS, gatherFiles, shouldExcludeDir, shouldExcludeFile } from './file-gathering.js';
export {
  defaultGitignoreUpdater,
  GitignoreUpdater,
} from './gitignore-updater.js';
export { extractJsonBlock } from './json-extractor.js';
export { parseNodeDependencies } from './manifest-parser.js';
export {
  defaultOrchestrator,
  type FullScanResult,
  type SecurityScannerContext,
  type SecurityScannerOptions,
  SecurityScannerOrchestrator,
} from './orchestrator.js';
export type {
  AuditablePackageManager,
  PackageAuditExecutionResult,
  PackageAuditExecutor,
  PackageAuditResult,
  PackageAuditSeverity,
  PackageAuditSummary,
  PackageAuditVulnerability,
} from './package-audit.js';
export {
  defaultPackageAuditRunner,
  detectAuditablePackageManager,
  PackageAuditRunner,
  parsePackageAuditOutput,
} from './package-audit.js';
export { type RedactionDiagnosticResult, runRedactionDiagnostic } from './redaction-diagnostic.js';
export {
  defaultReportGenerator,
  ReportGenerator,
  type ReportOptions,
} from './report-generator.js';
export {
  defaultSecurityScanner,
  type Finding,
  type ScanOptions,
  type ScanResult,
  SecurityScanner,
} from './scanner.js';
export {
  defaultSkillGenerator,
  type GeneratedSkill,
  SkillGenerator,
  type SkillGeneratorDeps,
  type SkillGeneratorOptions,
} from './skill-generator.js';
export {
  createSecuritySlashCommand,
  type SecuritySlashCommandDependencies,
  securitySlashCommand,
} from './slash-command.js';
export * from './types.js';
