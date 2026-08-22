/**
 * Conservative compilation of a caller-supplied regex, for the verification
 * plugins that accept a pattern from check config.
 *
 * Canonical home since card #5: `@wrongstack/primitives/src/regex-guard.ts`.
 * Historically this was a copy because `@wrongstack/kanban` sits below
 * core and tools in the workspace graph; primitives is a dependency leaf,
 * so the copy is no longer necessary. This module remains as a re-export
 * shim for `compileSafeRegex` (the kanban-facing name) and the barrel.
 * `tools/tests/regex-guard-parity.test.ts` still pins all three historical
 * entry points to identical verdicts.
 */

import {
  capSubject,
  compileUserRegex,
  type CompileFail,
  type CompileResult,
  MAX_SUBJECT_LEN,
} from '@wrongstack/primitives';

export { capSubject, compileUserRegex, MAX_SUBJECT_LEN };
export type { CompileFail, CompileResult };

export type SafeRegexResult = { ok: true; regex: RegExp } | { ok: false; reason: string };

/** Compile `pattern`, refusing anything over-long or obviously catastrophic. */
export function compileSafeRegex(pattern: string, flags = ''): SafeRegexResult {
  return compileUserRegex(pattern, flags);
}
