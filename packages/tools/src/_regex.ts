/**
 * Compile a user-supplied regex with conservative bounds against ReDoS.
 *
 * Canonical home since card #5: `@wrongstack/primitives/src/regex-guard.ts`.
 * This module is now a re-export shim kept for its four importers
 * (grep.ts, json.ts, logs.ts, replace.ts); `tools/tests/regex-guard-parity.test.ts`
 * still pins the three historical entry points to identical verdicts —
 * now trivially true, because all three resolve to the same code path.
 */

export {
  type CompileFail,
  type CompileResult,
  capSubject,
  compileUserRegex,
  MAX_SUBJECT_LEN,
} from '@wrongstack/primitives';
