/**
 * @wrongstack/primitives — dependency-leaf helpers shared by every tier of
 * the workspace graph. This package must stay importable from the lowest
 * packages (kanban, persistence) and therefore declares NO workspace
 * dependencies. Anything that needs another @wrongstack/* package does not
 * belong here.
 */

export {
  type CompileFail,
  type CompileResult,
  type CompileUserRegexResult,
  capSubject,
  compileUserRegex,
  MAX_SUBJECT_LEN,
} from './regex-guard.js';
export {
  isSystemSessionId,
  requireSessionId,
  SESSION_ID_REQUIRED,
  SessionIdRequiredError,
  SYSTEM_SESSION_PREFIX,
  systemSessionId,
} from './session-id.js';
export { nowIso } from './time.js';
