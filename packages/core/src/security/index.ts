// Security domain: secret scrubbing, vault encryption, permission policies

export { noOpVault } from '../types/secret-vault.js';
export {
  clampSubagentCapabilities,
  DANGEROUS_FOR_SUBAGENTS,
  getDangerousCapabilities,
  hasCapability,
  hasDangerousCapabilityForSubagents,
  ToolCapabilities,
  type ToolCapability,
  WIDE_SUBAGENT_CAPABILITIES,
} from './capabilities.js';
export { decryptConfigSecrets, encryptConfigSecrets, isSecretField } from './config-secrets.js';
export {
  kanbanGovernance,
  type KanbanGovernancePort,
  setKanbanGovernance,
} from './kanban-governance-port.js';
export {
  DirectoryPermissionPolicy,
  type DirectoryPermissionPolicyOptions,
  matchRule,
  resolveTargetPath,
} from './directory-permission-policy.js';
export {
  DIRECTORY_POLICY_LIMITS,
  DIRECTORY_POLICY_SCHEMA_VERSION,
  type DirectoryPolicyDiagnostic,
  type DirectoryPolicyDiagnosticCode,
  type DirectoryPolicyValidationResult,
  validateDirectoryPolicy,
} from './directory-policy-schema.js';
export {
  ERROR_DETAIL_MAX,
  sanitizeApiError,
  scrubErrorDetail,
  scrubErrorText,
} from './error-sanitize.js';
export {
  restrictDirPermissions,
  restrictFilePermissions,
  SECRET_DIR_MODE,
  SECRET_FILE_MODE,
} from './file-permissions.js';
export {
  evaluateToolKanbanBoundary,
  type ToolKanbanBoundaryEvaluation,
} from './kanban-boundary.js';
export {
  AutoApprovePermissionPolicy,
  alwaysAllowUnavailableReason,
  DefaultPermissionPolicy,
  type PermissionPolicyOptions,
} from './permission-policy.js';
export {
  TRUST_POLICY_JSON_SCHEMA,
  TRUST_POLICY_LIMITS,
  TRUST_POLICY_SCHEMA_VERSION,
  type TrustPolicyDiagnostic,
  type TrustPolicyDiagnosticCode,
  type TrustPolicyValidationResult,
  validateTrustPolicy,
} from './permission-policy-schema.js';
export { ReadOnlyPermissionPolicy, toolMutates } from './readonly-permission-policy.js';
export { DefaultSecretScrubber } from './secret-scrubber.js';
export {
  base32Decode,
  base32Encode,
  buildOtpAuthUri,
  generateRecoveryCodes,
  generateTotpSecret,
  generateTotp,
  hashRecoveryCode,
  verifyRecoveryCode,
  verifyTotp,
  verifyTotpCounter,
} from './totp.js';
export {
  DefaultSecretVault,
  migratePlaintextSecrets,
  rewriteConfigEncrypted,
  rotateConfigKeys,
  type SecretVaultOptions,
} from './secret-vault.js';
export type {
  CompatibilityTrustBoundaryOptions,
  TrustActor,
  TrustActorKind,
  TrustAllowDecision,
  TrustAttribute,
  TrustAuthContext,
  TrustAuthMethod,
  TrustBoundary,
  TrustBoundaryAuditEntry,
  TrustBoundaryDecision,
  TrustBoundaryRequest,
  TrustConfirmDecision,
  TrustDecodeIssue,
  TrustDecodeResult,
  TrustDenyDecision,
  TrustRisk,
  TrustScope,
  TrustScopedTokenDecision,
  TrustSubject,
  TrustSurface,
} from './trust-boundary.js';
export {
  createCompatibilityTrustBoundary,
  decodeTrustBoundaryDecision,
  decodeTrustBoundaryRequest,
  isTrustDecisionAllowed,
  TRUST_BOUNDARY_VERSION,
} from './trust-boundary.js';
