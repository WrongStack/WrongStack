/**
 * Compile a user-supplied regex with conservative bounds against ReDoS.
 *
 * Canonical home since card #5: `@wrongstack/primitives/src/regex-guard.ts`
 * (a dependency leaf, so every workspace tier — including kanban, which sits
 * below core and tools — can share one implementation). This module is now a
 * re-export shim: importers of `@wrongstack/core/utils` keep working, and
 * `tools/tests/regex-guard-parity.test.ts` still pins all three historical
 * entry points to identical verdicts (now trivially true — one code path).
 */

export {
  type CompileFail,
  type CompileResult,
  capSubject,
  compileUserRegex,
  MAX_SUBJECT_LEN,
} from '@wrongstack/primitives';
