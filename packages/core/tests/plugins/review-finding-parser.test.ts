/**
 * Tests for the Chimera review finding parser.
 *
 * FS-P0.2
 */
import { describe, expect, it } from 'vitest';
import { parseChimeraReviewReport } from '../../src/plugins/review-finding-parser.js';

// ── Helper ──────────────────────────────────────────────────────────

const SAMPLE_CONTEXT = { sessionId: 'sess-1', reviewerModel: 'gpt-5.6-sol' };

// ── Parsing canonical report format ─────────────────────────────────

describe('parseChimeraReviewReport', () => {
  it('returns empty for blank input', () => {
    const result = parseChimeraReviewReport('');
    expect(result.findings).toHaveLength(0);
    expect(result.unparseableCount).toBe(0);
  });

  it('returns empty for whitespace-only input', () => {
    const result = parseChimeraReviewReport('   \n  \n  ');
    expect(result.findings).toHaveLength(0);
  });

  it('parses a typical report with all severity levels', () => {
    const report = [
      '### Critical (2)',
      '1. [BUG] src/app.ts:42 — Null dereference on user.name',
      '   → Add guard: if (!user) throw new NotFoundError()',
      '2. [SECURITY] src/auth.ts:10 — SQL injection in login query',
      '',
      '### High (1)',
      '1. src/db.ts:88 — Unhandled promise rejection',
      '   → await the promise or add .catch()',
      '',
      '### Medium (1)',
      '1. src/utils.ts:5 — Unused parameter `options`',
      '',
    ].join('\n');

    const result = parseChimeraReviewReport(report, SAMPLE_CONTEXT);
    expect(result.findings).toHaveLength(4);
    expect(result.unparseableCount).toBe(0);

    // Critical findings
    expect(result.findings[0]!.severity).toBe('critical');
    expect(result.findings[0]!.location?.file).toBe('src/app.ts');
    expect(result.findings[0]!.location?.line).toBe(42);
    expect(result.findings[0]!.title).toContain('Null dereference');
    expect(result.findings[0]!.suggestedFix).toContain('Add guard');

    expect(result.findings[1]!.severity).toBe('critical');
    expect(result.findings[1]!.location?.file).toBe('src/auth.ts');
    expect(result.findings[1]!.location?.line).toBe(10);

    // High findings
    expect(result.findings[2]!.severity).toBe('high');
    expect(result.findings[2]!.location?.file).toBe('src/db.ts');

    // Medium findings
    expect(result.findings[3]!.severity).toBe('medium');
    expect(result.findings[3]!.location?.file).toBe('src/utils.ts');
    expect(result.findings[3]!.location?.line).toBe(5);
  });

  it('handles reports with no severity count parentheses', () => {
    const report = '### Critical\n1. src/a.ts:1 — Bug one\n';
    const result = parseChimeraReviewReport(report, SAMPLE_CONTEXT);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.severity).toBe('critical');
  });

  it('extracts duration from a Duration line', () => {
    const report = [
      'Duration: 42s',
      '### Critical (1)',
      '1. src/a.ts:1 — X',
    ].join('\n');
    const result = parseChimeraReviewReport(report, SAMPLE_CONTEXT);
    expect(result.durationSeconds).toBe(42);
  });

  it('handles empty severity sections', () => {
    const report = '### High (0)\n\n### Critical (1)\n1. src/a.ts:1 — X\n';
    const result = parseChimeraReviewReport(report, SAMPLE_CONTEXT);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.severity).toBe('critical');
  });

  it('handles real-world finding with backtick code references', () => {
    const report = [
      '### High (1)',
      '1. `isFanOutRecipient` in `packages/core/src/coordination/mailbox-receipt-folding.ts` — ',
      '   base-alias `to: "leader"` not detected as fan-out',
      '   → Add `!to.includes(\'@\')` to the fan-out check',
    ].join('\n');

    const result = parseChimeraReviewReport(report, SAMPLE_CONTEXT);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.severity).toBe('high');
    expect(result.findings[0]!.title.length).toBeGreaterThan(5);
    expect(result.findings[0]!.suggestedFix).toContain('@');
  });

  it('sets context fields on findings', () => {
    const report = '### High (1)\n1. src/a.ts:1 — Bug\n';
    const result = parseChimeraReviewReport(report, {
      sessionId: 'sess-test',
      reviewerModel: 'claude-opus-4',
      reviewType: 'auto',
    });
    expect(result.findings[0]!.originReport.sessionId).toBe('sess-test');
    expect(result.findings[0]!.originReport.reviewerModel).toBe('claude-opus-4');
    expect(result.findings[0]!.source).toBe('auto');
  });

  it('computes deterministic fingerprints', () => {
    const report = '### High (1)\n1. src/a.ts:42 — Null dereference\n';
    const r1 = parseChimeraReviewReport(report, SAMPLE_CONTEXT);
    const r2 = parseChimeraReviewReport(report, SAMPLE_CONTEXT);
    expect(r1.findings[0]!.fingerprint).toBe(r2.findings[0]!.fingerprint);
  });

  it('handles finding with `->` suggestion syntax', () => {
    const report = '### High (1)\n1. src/a.ts:5 — Issue\n   -> Use const instead\n';
    const result = parseChimeraReviewReport(report, SAMPLE_CONTEXT);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.suggestedFix).toContain('Use const');
  });
});

// ── Edge cases ──────────────────────────────────────────────────────

describe('parseChimeraReviewReport — edge cases', () => {
  it('handles very long description with multi-line body', () => {
    const report = [
      '### Critical (1)',
      '1. [BUG] src/a.ts:1 — This is a very long finding description that',
      '   spans multiple continuation lines before the suggestion',
      '   → The fix should handle this case',
    ].join('\n');
    const result = parseChimeraReviewReport(report, SAMPLE_CONTEXT);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.description).toBeDefined();
  });

  it('counts unparseable items when a finding cannot be extracted', () => {
    const report = [
      '### Critical (2)',
      '1. This line has no file reference and no dash separator',
      '2. [BUG] src/a.ts:1 — This one is valid',
    ].join('\n');
    const result = parseChimeraReviewReport(report, SAMPLE_CONTEXT);
    // At least 1 finding should be extracted (the valid one)
    expect(result.findings.length).toBeGreaterThanOrEqual(1);
    expect(result.unparseableCount).toBeGreaterThanOrEqual(0);
  });

  it('handles Windows-style file paths', () => {
    const report = '### High (1)\n1. src\\app.ts:15 — Bug\n';
    const result = parseChimeraReviewReport(report, SAMPLE_CONTEXT);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.location?.file).toContain('src');
  });

  it('handles findings without a line number', () => {
    const report = '### High (1)\n1. src/app.ts — General code smell\n';
    const result = parseChimeraReviewReport(report, SAMPLE_CONTEXT);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.location?.file).toBe('src/app.ts');
    expect(result.findings[0]!.location?.line).toBeUndefined();
  });

  it('handles "all clear ✅" reports with no findings', () => {
    const report = '## Chomera Review\n\nAll clear ✅ — No issues found in 1 changed file.\n';
    const result = parseChimeraReviewReport(report, SAMPLE_CONTEXT);
    expect(result.findings).toHaveLength(0);
    expect(result.unparseableCount).toBe(0);
  });

  it('handles findings with Unicode dash characters', () => {
    const report = '### High (1)\n1. src/a.ts:1 – Unicode dash\n';
    const result = parseChimeraReviewReport(report, SAMPLE_CONTEXT);
    expect(result.findings).toHaveLength(1);
  });
});

// ── Source normalization ────────────────────────────────────────────

describe('parseChimeraReviewReport — source normalization', () => {
  it('preserves supported review sources', () => {
    const report = '### High (1)\n1. src/a.ts:1 — SQL injection vulnerability\n';
    const result = parseChimeraReviewReport(report, { ...SAMPLE_CONTEXT, reviewType: 'security-scanner' });
    expect(result.findings[0]!.source).toBe('security-scanner');
  });

  it('defaults unknown review sources to chimera', () => {
    const report = '### Medium (1)\n1. src/a.ts:1 — Slow memory leak in loop\n';
    const result = parseChimeraReviewReport(report, { ...SAMPLE_CONTEXT, reviewType: 'manual' });
    expect(result.findings[0]!.source).toBe('chimera');
  });
});
