export {
  DEFAULT_ALWAYS_TRUST_TTL_MS,
  isPersistentApproval,
  scopedApprovalPattern,
} from './scoped-approval.js';

// Security domain: secret scrubbing, vault encryption, permission policies

export { noOpVault } from '@wrongstack/contracts/types/secret-vault';
export {
  capabilityDowngradesToConfirm,
  clampSubagentCapabilities,
  DANGEROUS_FOR_SUBAGENTS,
  getDangerousCapabilities,
  hasCapability,
  hasDangerousCapabilityForSubagents,
  ToolCapabilities,
  type ToolCapability,
  WIDE_SUBAGENT_CAPABILITIES,
} from './capabilities.js';
export {
  decryptConfigSecrets,
  decryptConfigSecretsForRewrite,
  encryptConfigSecrets,
  isSecretField,
} from './config-secrets.js';
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
  type KanbanGovernancePort,
  kanbanGovernance,
  setKanbanGovernance,
} from './kanban-governance-port.js';
export { withExecutorGate } from './permission-explain.js';
export { describeWriteTargets, shellCommandLinesFromInput } from './permission-helpers.js';
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
export { compilePermissionRules, matchedPermissionRule } from './permission-rules.js';
export {
  isProjectRootLocked,
  isYoloLockedOff,
  lockToProjectRoot,
  lockYoloOff,
} from './process-lockdown.js';
export { ReadOnlyPermissionPolicy, toolMutates } from './readonly-permission-policy.js';
export { DefaultSecretScrubber } from './secret-scrubber.js';
export {
  DefaultSecretVault,
  migratePlaintextSecrets,
  rewriteConfigEncrypted,
  rotateConfigKeys,
  type SecretVaultOptions,
} from './secret-vault.js';
export {
  describeSessionPermissionOverride,
  readSessionPermissionOverrides,
  restoreSessionPermissionOverrides,
  setSessionPermissionOverrides,
} from './session-permission-overrides.js';
export { setSessionLeaderMetaResolver, subagentYoloPlus } from './session-yolo.js';
export {
  base32Decode,
  base32Encode,
  buildOtpAuthUri,
  generateRecoveryCodes,
  generateTotp,
  generateTotpSecret,
  hashRecoveryCode,
  verifyRecoveryCode,
  verifyTotp,
  verifyTotpCounter,
} from './totp.js';
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
export {
  ALL_DESTRUCTIVE_KINDS,
  classifyDestructiveCommand,
  type DestructiveKind,
  isClearlyDestructiveBashCommand,
  isDestructiveKind,
  LOCKED_DESTRUCTIVE_KINDS,
  normalizeYoloConfirmKinds,
  resolveYoloConfirmKinds,
} from './yolo-risk.js';
