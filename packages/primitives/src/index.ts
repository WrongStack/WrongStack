/**
 * @wrongstack/primitives — dependency-leaf helpers shared by every tier of
 * the workspace graph. This package must stay importable from the lowest
 * packages (kanban, persistence) and therefore declares NO workspace
 * dependencies. Anything that needs another @wrongstack/* package does not
 * belong here.
 */

export type { BrowserElementSelection } from './browser-selection.js';
export { rawErrorMessage, toErrorMessage } from './error.js';
export {
  ERROR_DETAIL_MAX,
  sanitizeApiError,
  scrubErrorDetail,
  scrubErrorText,
} from './error-sanitize.js';
export { expectDefined } from './expect-defined.js';
export {
  type GitIsolationOptions,
  gitConfigEnv,
  gitIsolationEnv,
  gitIsolationEnvSync,
  untrustedGitFilterKeys,
} from './git-isolation.js';
export {
  COMMAND_REDACTION_PROFILE,
  OUTBOUND_REDACTION_PROFILE,
  type RedactionProfile,
  type RedactionProfileId,
  redactCommand,
  redactCommandArgs,
  redactSecrets,
} from './redact-command.js';
export {
  DefaultSecretScrubber,
  isOpaqueMediaStringField,
  isStandardBase64Payload,
  redactText,
  redactValue,
  type SecretScrubber,
} from './redaction.js';
export {
  type CompileFail,
  type CompileResult,
  type CompileUserRegexResult,
  capSubject,
  compileUserRegex,
  MAX_SUBJECT_LEN,
} from './regex-guard.js';
export { type RemovePathSyncOptions, removePathSync } from './remove-path.js';
export {
  assertDaemonRuntimeVersion,
  WRONGSTACK_RUNTIME_VERSION,
  withDaemonVersion,
} from './runtime-version.js';
export {
  isSystemSessionId,
  requireSessionId,
  SESSION_ID_REQUIRED,
  SessionIdRequiredError,
  SYSTEM_SESSION_PREFIX,
  systemSessionId,
} from './session-id.js';
export { truncate } from './string.js';
export { nowIso } from './time.js';
export { timingSafeTokenEqual } from './timing-safe.js';
