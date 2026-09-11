/**
 * A tool failure must record WHICH failure.
 *
 * Field evidence (2026-09-11): ten `tool execution failed` lines for the `edit`
 * tool in one day, every one of them
 *
 *   "errorCategory":"validation","errorDetail":"validation"
 *
 * — the detail restating the category it travels beside. Nothing about the
 * failures was diagnosable after the fact, even though `ToolValidationError`
 * carries a message and a `context.field` naming what failed. Both were
 * discarded in `classifyToolError`.
 *
 * Every other branch of that classifier already put something identifying in
 * `detail` (the errno code, `'aborted'`, `HTTP <status>`, `CODE [subsystem]`);
 * only the two validation branches degraded.
 *
 * Why it survived: `classify-tool-error.test.ts` asserts `category` and
 * `retryable` for `ToolValidationError` and never looks at `detail`. The
 * assertion that would have caught it was the one nobody wrote — so this file
 * pins `detail` for both validation paths and for the unclassified fallback.
 */
import { describe, expect, it } from 'vitest';
import { classifyToolError } from '../../src/execution/tool-executor-support.js';
import { ToolValidationError } from '../../src/types/errors.js';
import { ToolErrorCategory } from '../../src/types/tool.js';

const SECRET = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

describe('classifyToolError detail', () => {
  it('names the field and the message for a ToolValidationError', () => {
    const result = classifyToolError(
      new ToolValidationError({ message: 'old_string not found in file', field: 'old_string' }),
    );
    expect(result.category).toBe(ToolErrorCategory.VALIDATION);
    expect(result.detail).toBe('old_string: old_string not found in file');
  });

  it('falls back to the message alone when no field is supplied', () => {
    const result = classifyToolError(new ToolValidationError({ message: 'schema mismatch' }));
    expect(result.detail).toBe('schema mismatch');
  });

  it('describes the message-sniffed validation path too', () => {
    // The second branch: any Error whose message merely contains "validation".
    // It degraded identically and is fixed identically.
    const result = classifyToolError(new Error('input failed validation for arg 2'));
    expect(result.category).toBe(ToolErrorCategory.VALIDATION);
    expect(result.detail).toBe('input failed validation for arg 2');
  });

  it('never returns an empty detail', () => {
    // An empty message must not produce `detail: ''` — a reader could not tell
    // that apart from a missing field without a special case.
    const result = classifyToolError(new ToolValidationError({ message: '' }));
    expect(result.detail).toBe('validation');
  });

  it('caps an oversized detail rather than writing it whole to the log', () => {
    const result = classifyToolError(new ToolValidationError({ message: 'x'.repeat(5_000) }));
    expect(result.detail?.length).toBeLessThanOrEqual(301); // 300 + ellipsis
    expect(result.detail?.endsWith('…')).toBe(true);
  });

  it('scrubs credentials out of a validation detail', () => {
    // `detail` lands in the durable log file, so it gets the same treatment the
    // audit applied to the CLI fatal path (H5).
    const result = classifyToolError(
      new ToolValidationError({ message: `rejected: Authorization: Bearer ${SECRET}` }),
    );
    expect(result.detail).not.toContain(SECRET);
    expect(result.detail).toContain('rejected');
  });

  it('scrubs the unclassified fallback too', () => {
    // The fallback is the MOST likely branch to carry an echoed provider
    // response, and it went to the log verbatim.
    const result = classifyToolError(new Error(`boom ${SECRET}`));
    expect(result.category).toBe(ToolErrorCategory.FATAL);
    expect(result.detail).not.toContain(SECRET);
  });

  it('scrubs BEFORE truncating, so a cut credential cannot survive', () => {
    // Truncating first can slice a credential in half and leave the leading
    // part past the scrubber's pattern. The order matters and is asserted.
    const result = classifyToolError(new Error(`${'p'.repeat(80)} ${SECRET}`));
    expect(result.detail).not.toContain(SECRET.slice(0, 30));
  });

  // SECURITY.md rule 3: re-introduce the defect and confirm it is visible.
  it('injection: a detail equal to its own category is the bug, not a value', () => {
    // The pre-fix output was exactly `'validation'` for every validation error
    // regardless of cause. Two DIFFERENT causes must now produce two DIFFERENT
    // details — that difference is the whole property, and asserting it here
    // means a regression to the constant fails this test rather than passing
    // it quietly.
    const a = classifyToolError(
      new ToolValidationError({ message: 'file is stale', field: 'sha' }),
    );
    const b = classifyToolError(new ToolValidationError({ message: 'path escapes root' }));
    expect(a.detail).not.toBe(b.detail);
    expect(a.detail).not.toBe('validation');
    expect(b.detail).not.toBe('validation');
  });

  it('leaves the informative branches untouched', () => {
    // Regression fence: the branches that were already good must not have been
    // disturbed while fixing the one that was not.
    const enoent = Object.assign(new Error('nope'), { code: 'ENOENT' });
    expect(classifyToolError(enoent).detail).toBe('ENOENT');
    const aborted = Object.assign(new Error('stop'), { name: 'AbortError' });
    expect(classifyToolError(aborted).detail).toBe('aborted');
  });
});
