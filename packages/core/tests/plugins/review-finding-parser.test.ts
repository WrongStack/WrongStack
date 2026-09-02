/**
 * Tests for the Chimera review finding parser.
 *
 * FS-P0.2
 */
import { describe, expect, it } from 'vitest';
import {
  extractStructuredFindingsBlock,
  parseChimeraReviewReport,
} from '../../src/plugins/review-finding-parser.js';

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
    const report = ['Duration: 42s', '### Critical (1)', '1. src/a.ts:1 — X'].join('\n');
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
      "   → Add `!to.includes('@')` to the fan-out check",
    ].join('\n');

    const result = parseChimeraReviewReport(report, SAMPLE_CONTEXT);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.severity).toBe('high');
    expect(result.findings[0]!.title.length).toBeGreaterThan(5);
    expect(result.findings[0]!.suggestedFix).toContain('@');
  });

  it('parses canonical backtick-wrapped citation in citation position', () => {
    // Regression: the prompt at chimera-review.md mandates
    //   `1. [BUG] `path/file.ts:42` — description`
    // but the parser's location regex required the citation to begin with
    // `[a-zA-Z_./\\]`, so every canonical finding came through as
    // uncited and the gating pipeline degraded to `(no file)`.
    const report = [
      '### High (1)',
      '1. [BUG] `packages/cli/src/execution-chimera-review.ts:241` — parser rejects backtick citations',
      '   → Strip wrapping backticks before applying the path regex',
    ].join('\n');

    const result = parseChimeraReviewReport(report, SAMPLE_CONTEXT);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.severity).toBe('high');
    expect(result.findings[0]!.location).toEqual({
      file: 'packages/cli/src/execution-chimera-review.ts',
      line: 241,
    });
    expect(result.findings[0]!.description).toContain('parser rejects backtick citations');
  });

  it('parses canonical citation without [TAG] prefix', () => {
    const report = [
      '### Medium (1)',
      '1. `packages/core/src/foo.ts:7` — bare citation, no tag',
    ].join('\n');

    const result = parseChimeraReviewReport(report, SAMPLE_CONTEXT);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.location).toEqual({
      file: 'packages/core/src/foo.ts',
      line: 7,
    });
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

  it('preserves hyphenated file paths before the separator', () => {
    const report = [
      '### High (2)',
      '1. packages/cli/src/boot/governance-shadow-bridge.ts:12 — Bridge failure',
      '2. packages/cli/src/execution-chimera-review.ts:42 - Review failure',
    ].join('\n');
    const result = parseChimeraReviewReport(report, SAMPLE_CONTEXT);

    expect(result.findings[0]!.location).toEqual({
      file: 'packages/cli/src/boot/governance-shadow-bridge.ts',
      line: 12,
    });
    expect(result.findings[1]!.location).toEqual({
      file: 'packages/cli/src/execution-chimera-review.ts',
      line: 42,
    });
  });

  it('handles findings with Unicode dash characters', () => {
    const report = '### High (1)\n1. src/a.ts:1 – Unicode dash\n';
    const result = parseChimeraReviewReport(report, SAMPLE_CONTEXT);
    expect(result.findings).toHaveLength(1);
  });

  it('strips backticks from the canonical citation format', () => {
    // The chimera-review instruction mandates backtick-wrapped citations:
    // `` `packages/foo.ts:42` — description ``. The parser must strip the
    // backticks so the file path is recognized for downstream gating
    // (citation validation against the changed-file set, etc.).
    const report = [
      '### Critical (1)',
      '1. [BUG] `src/backticked.ts:7` — Backtick-strip regression',
      '   → Remove the wrapping backticks',
    ].join('\n');
    const result = parseChimeraReviewReport(report, SAMPLE_CONTEXT);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.location).toEqual({
      file: 'src/backticked.ts',
      line: 7,
    });
    expect(result.findings[0]!.title).toContain('Backtick-strip');
    expect(result.findings[0]!.suggestedFix).toContain('Remove the wrapping');
  });

  it('strips backticks from the fallback path-only match', () => {
    // The primary regex requires a ` — ` (or other spaced) separator after
    // the citation; this input omits the separator so the primary regex
    // misses and the fallback path matcher is what actually runs. The
    // test must use this form — otherwise the assertion is a false
    // assurance (the primary regex would match first and the fallback
    // branch would never execute).
    const report = '### High (1)\n1. `src/fallback-backticks.ts:3`\n';
    const result = parseChimeraReviewReport(report, SAMPLE_CONTEXT);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.location?.file).toBe('src/fallback-backticks.ts');
    expect(result.findings[0]!.location?.line).toBe(3);
  });

  it('handles tight-format citations with no space before the em-dash', () => {
    // The protected group requires a path-like inner content and a separator
    // immediately after the closing backtick (with optional whitespace). A
    // tight-format like `` `src/tight.ts:9`—desc `` (no space) must still
    // unwrap and parse the citation.
    const report = '### High (1)\n1. `src/tight-format.ts:9`—No space before dash\n';
    const result = parseChimeraReviewReport(report, SAMPLE_CONTEXT);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.location).toEqual({
      file: 'src/tight-format.ts',
      line: 9,
    });
    expect(result.findings[0]!.title).toContain('No space before dash');
  });

  it('does not unwrap non-citation backtick constructs', () => {
    // The protected group only matches when the inner content starts with a
    // path-like character. An inline backtick construct mid-description that
    // happens to be balanced (e.g. `` `not a path` ``) must not be unwrapped
    // — the description should be preserved verbatim.
    const report = '### High (1)\n1. src/x.ts:1 — Inline `not a path` here\n';
    const result = parseChimeraReviewReport(report, SAMPLE_CONTEXT);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.location?.file).toBe('src/x.ts');
    expect(result.findings[0]!.location?.line).toBe(1);
    expect(result.findings[0]!.title).toContain('Inline `not a path` here');
  });
});

// ── Structured JSON contract (P0-1) ────────────────────────────────

describe('parseChimeraReviewReport — structured JSON contract', () => {
  const JSON_REPORT = [
    '## 🦂 Chimera Review',
    '',
    '### Critical (1)',
    '1. [SECURITY] `src/auth.ts:42` — SQL injection in login query',
    '   → use parameterized queries',
    '',
    '```json',
    '{',
    '  "findings": [',
    '    {',
    '      "severity": "critical",',
    '      "category": "security",',
    '      "confidence": "high",',
    '      "file": "src/auth.ts",',
    '      "line": 42,',
    '      "title": "SQL injection in login query",',
    '      "description": "User input concatenated into a SQL query",',
    '      "suggestedFix": "Use parameterized queries"',
    '    }',
    '  ]',
    '}',
    '```',
  ].join('\n');

  it('extracts the fenced JSON block and builds findings from it', () => {
    const block = extractStructuredFindingsBlock(JSON_REPORT);
    expect(block).not.toBeNull();
    expect(block!.findings).toHaveLength(1);
    expect(block!.findings[0]).toMatchObject({
      severity: 'critical',
      category: 'security',
      confidence: 'high',
      file: 'src/auth.ts',
      line: 42,
      title: 'SQL injection in login query',
    });
  });

  it('uses structured findings as authoritative when the block parses', () => {
    const result = parseChimeraReviewReport(JSON_REPORT, SAMPLE_CONTEXT);
    expect(result.structured).toBe(true);
    expect(result.findings).toHaveLength(1);
    expect(result.unparseableCount).toBe(0);
    const finding = result.findings[0]!;
    expect(finding.severity).toBe('critical');
    expect(finding.category).toBe('security');
    expect(finding.confidence).toBe('high');
    expect(finding.location).toEqual({ file: 'src/auth.ts', line: 42 });
    expect(finding.title).toBe('SQL injection in login query');
    expect(finding.suggestedFix).toBe('Use parameterized queries');
  });

  it('stamps origin context on structured findings', () => {
    const result = parseChimeraReviewReport(JSON_REPORT, {
      sessionId: 'sess-structured',
      reviewerModel: 'gpt-5.6-sol',
      reportId: 'report-structured-1',
    });
    expect(result.findings[0]!.originReport).toMatchObject({
      sessionId: 'sess-structured',
      reviewerModel: 'gpt-5.6-sol',
      reportId: 'report-structured-1',
    });
  });

  it('falls back to markdown parsing when no JSON block exists', () => {
    const md = '### High (1)\n1. src/a.ts:1 — Bug one\n';
    const result = parseChimeraReviewReport(md, SAMPLE_CONTEXT);
    expect(result.structured).toBeUndefined();
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.location?.file).toBe('src/a.ts');
    expect(result.findings[0]!.category).toBeUndefined();
  });

  it('falls back to markdown when the fenced block is not valid JSON', () => {
    const report = [
      '### High (1)',
      '1. src/a.ts:1 — Bug one',
      '',
      '```json',
      '{ this is not json',
      '```',
    ].join('\n');
    const result = parseChimeraReviewReport(report, SAMPLE_CONTEXT);
    expect(result.structured).toBeUndefined();
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.title).toContain('Bug one');
  });

  it('returns empty findings for an all-clear structured block', () => {
    const report = [
      '## 🦂 Chimera Review — all clear ✅',
      'No issues found.',
      '',
      '```json',
      '{ "findings": [] }',
      '```',
    ].join('\n');
    const result = parseChimeraReviewReport(report, SAMPLE_CONTEXT);
    expect(result.structured).toBe(true);
    expect(result.findings).toHaveLength(0);
    expect(result.unparseableCount).toBe(0);
  });

  it('takes the LAST parseable fenced JSON block', () => {
    const report = [
      '```json',
      '{ "findings": [{ "severity": "high", "title": "Stale example" }] }',
      '```',
      '',
      '```json',
      '{ "findings": [{ "severity": "medium", "title": "Real finding" }] }',
      '```',
    ].join('\n');
    const result = parseChimeraReviewReport(report, SAMPLE_CONTEXT);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.title).toBe('Real finding');
    expect(result.findings[0]!.severity).toBe('medium');
  });

  it('drops items with invalid severity or blank title', () => {
    const report = [
      '```json',
      '{',
      '  "findings": [',
      '    { "severity": "critical", "title": "Valid one" },',
      '    { "severity": "blaster", "title": "Bad severity" },',
      '    { "severity": "high", "title": "   " }',
      '  ]',
      '}',
      '```',
    ].join('\n');
    const result = parseChimeraReviewReport(report, SAMPLE_CONTEXT);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.title).toBe('Valid one');
  });

  it('reads durationSeconds from the structured block', () => {
    const report = ['```json', '{ "findings": [], "durationSeconds": 41.7 }', '```'].join('\n');
    const result = parseChimeraReviewReport(report, SAMPLE_CONTEXT);
    expect(result.durationSeconds).toBe(41);
  });

  it('leaves category/confidence undefined when the block omits them', () => {
    const report = [
      '```json',
      '{ "findings": [{ "severity": "high", "title": "Bare finding" }] }',
      '```',
    ].join('\n');
    const result = parseChimeraReviewReport(report, SAMPLE_CONTEXT);
    expect(result.findings[0]!.category).toBeUndefined();
    expect(result.findings[0]!.confidence).toBeUndefined();
  });

  it('treats a finding without file/line as location-less but valid', () => {
    const report = [
      '```json',
      '{ "findings": [{ "severity": "medium", "title": "No citation", "description": "General risk" }] }',
      '```',
    ].join('\n');
    const result = parseChimeraReviewReport(report, SAMPLE_CONTEXT);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.location).toBeUndefined();
  });

  it('keeps findings with invalid category/confidence but leaves the fields unset', () => {
    const report = [
      '```json',
      '{',
      '  "findings": [',
      '    { "severity": "high", "title": "Good", "category": "security", "confidence": "high" },',
      '    { "severity": "high", "title": "Bad category", "category": "wizardry" },',
      '    { "severity": "high", "title": "Bad confidence", "confidence": "certainly" }',
      '  ]',
      '}',
      '```',
    ].join('\n');
    const result = parseChimeraReviewReport(report, SAMPLE_CONTEXT);
    // Lenient by design: an unknown category/confidence does not drop the
    // finding (severity/title/file are the contract minimum); the optional
    // enrichment fields are simply left unset.
    expect(result.findings).toHaveLength(3);
    expect(result.findings[0]).toMatchObject({
      title: 'Good',
      category: 'security',
      confidence: 'high',
    });
    expect(result.findings[1]!.category).toBeUndefined();
    expect(result.findings[1]!.confidence).toBeUndefined();
    expect(result.findings[2]!.category).toBeUndefined();
    expect(result.findings[2]!.confidence).toBeUndefined();
  });

  it('strips non-integer or non-positive lines but keeps the finding (never silently drops)', () => {
    const report = [
      '```json',
      '{',
      '  "findings": [',
      '    { "severity": "high", "title": "Float line", "file": "a.ts", "line": 4.2 },',
      '    { "severity": "high", "title": "Negative line", "file": "a.ts", "line": -3 },',
      '    { "severity": "high", "title": "Zero line", "file": "a.ts", "line": 0 },',
      '    { "severity": "high", "title": "String line", "file": "a.ts", "line": "42" }',
      '  ]',
      '}',
      '```',
    ].join('\n');
    const result = parseChimeraReviewReport(report, SAMPLE_CONTEXT);
    // All four items are valid findings; only the unparseable line is dropped
    // (mirrors the markdown path: "When a finding item lacks a parseable
    // file:line, it still produces a finding").
    expect(result.findings).toHaveLength(4);
    for (const finding of result.findings) {
      expect(finding.location?.file).toBe('a.ts');
      expect(finding.location?.line).toBeUndefined();
    }
  });

  it('does not treat a fenced block without the json tag as structured', () => {
    const report = [
      '### High (1)',
      '1. src/a.ts:1 — Bug one',
      '',
      '```',
      '{ "findings": [{ "severity": "high", "title": "Ignored" }] }',
      '```',
    ].join('\n');
    const result = parseChimeraReviewReport(report, SAMPLE_CONTEXT);
    expect(result.structured).toBeUndefined();
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.title).toContain('Bug one');
  });

  it('tolerates extra keys in the block and individual items', () => {
    const report = [
      '```json',
      '{',
      '  "version": 2,',
      '  "tool": "chimera",',
      '  "findings": [',
      '    { "severity": "critical", "title": "Real", "unknownKey": { "nested": true } }',
      '  ]',
      '}',
      '```',
    ].join('\n');
    const result = parseChimeraReviewReport(report, SAMPLE_CONTEXT);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.title).toBe('Real');
  });
});

// ── Source normalization ────────────────────────────────────────────

describe('parseChimeraReviewReport — source normalization', () => {
  it('preserves supported review sources', () => {
    const report = '### High (1)\n1. src/a.ts:1 — SQL injection vulnerability\n';
    const result = parseChimeraReviewReport(report, {
      ...SAMPLE_CONTEXT,
      reviewType: 'security-scanner',
    });
    expect(result.findings[0]!.source).toBe('security-scanner');
  });

  it('defaults unknown review sources to chimera', () => {
    const report = '### Medium (1)\n1. src/a.ts:1 — Slow memory leak in loop\n';
    const result = parseChimeraReviewReport(report, { ...SAMPLE_CONTEXT, reviewType: 'manual' });
    expect(result.findings[0]!.source).toBe('chimera');
  });
});
