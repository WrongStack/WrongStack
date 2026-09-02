import { describe, it, expect } from 'vitest';
import {
  parseReviewSeverity,
  decideCascadeAgents,
  shouldCascade,
  severitiesFromFindings,
} from '../../src/plugins/auto-review-plugin.js';
import type { ChimeraFinding } from '../../src/plugins/review-finding-types.js';

function makeFinding(overrides: Partial<ChimeraFinding>): ChimeraFinding {
  return {
    id: 'f-1',
    fingerprint: 'fp',
    severity: 'high',
    source: 'chimera',
    title: 'Finding',
    description: 'Description',
    createdAt: new Date().toISOString(),
    status: 'active',
    originReport: { reportId: 'r1', sessionId: 's1', agentId: 'a1', reviewerModel: 'm1' },
    ...overrides,
  };
}

// ── Sample review reports matching the chimera-review.md format ──

const CLEAN_REPORT = `## 🦂 Chimera Review — all clear ✅
No issues found in 2 changed files.`;

const REPORT_WITH_CRITICAL_SECURITY = `## 🦂 Chimera Review

### Critical (2)
1. [SECURITY] \`src/auth.ts:42\` — SQL injection in login query
   → use parameterized queries
2. [BUG] \`src/api.ts:18\` — null deref without guard
   → add null check

### High (1)
1. [BUG] \`src/utils.ts:77\` — off-by-one in loop bound
   → fix loop condition

### Medium (1)
1. [STYLE] \`src/format.ts:10\` — missing return type annotation
   → add explicit return type

### Summary
- Files reviewed: 4
- Findings: 2 critical, 1 high, 1 medium
`;

const REPORT_WITH_HIGH_ONLY = `## 🦂 Chimera Review

### Critical (0)

### High (2)
1. [BUG] \`src/parser.ts:30\` — inverted condition skips valid input
   → flip the comparison
2. [BUG] \`src/cache.ts:55\` — event listener never removed (leak)
   → call removeEventListener in cleanup

### Medium (0)

### Summary
- Files reviewed: 2
- Findings: 0 critical, 2 high, 0 medium
`;

const REPORT_NO_COUNTS_LIST_ITEMS = `## 🦂 Chimera Review

### Critical
1. [SECURITY] \`x.ts:1\` — hardcoded API key
   → load from env

### High
1. [BUG] \`y.ts:2\` — swallowed error
   → rethrow or log

### Medium

### Summary
`;

// ── parseReviewSeverity ──

describe('parseReviewSeverity', () => {
  it('returns all-zero for a clean report', () => {
    expect(parseReviewSeverity(CLEAN_REPORT)).toEqual({
      critical: 0,
      high: 0,
      medium: 0,
    });
  });

  it('returns all-zero for empty text', () => {
    expect(parseReviewSeverity('')).toEqual({ critical: 0, high: 0, medium: 0 });
  });

  it('parses explicit count from "### Critical (2)" format', () => {
    const sev = parseReviewSeverity(REPORT_WITH_CRITICAL_SECURITY);
    expect(sev.critical).toBe(2);
    expect(sev.high).toBe(1);
    expect(sev.medium).toBe(1);
  });

  it('handles zero counts "### Critical (0)"', () => {
    const sev = parseReviewSeverity(REPORT_WITH_HIGH_ONLY);
    expect(sev.critical).toBe(0);
    expect(sev.high).toBe(2);
    expect(sev.medium).toBe(0);
  });

  it('falls back to counting list items when no (N) count is present', () => {
    const sev = parseReviewSeverity(REPORT_NO_COUNTS_LIST_ITEMS);
    expect(sev.critical).toBe(1);
    expect(sev.high).toBe(1);
    expect(sev.medium).toBe(0);
  });

  it('is case-insensitive on the severity header', () => {
    const sev = parseReviewSeverity('### critical (3)\n1. a\n2. b\n3. c');
    expect(sev.critical).toBe(3);
  });
});

// ── decideCascadeAgents ──

describe('decideCascadeAgents', () => {
  it('selects security-scanner when a Critical finding has security keywords', () => {
    const sev = parseReviewSeverity(REPORT_WITH_CRITICAL_SECURITY);
    const agents = decideCascadeAgents(REPORT_WITH_CRITICAL_SECURITY, sev);
    expect(agents).toContain('security-scanner');
    expect(agents).toContain('bug-hunter');
  });

  it('selects bug-hunter for any High+ finding even without security keywords', () => {
    const sev = parseReviewSeverity(REPORT_WITH_HIGH_ONLY);
    const agents = decideCascadeAgents(REPORT_WITH_HIGH_ONLY, sev);
    expect(agents).toEqual(['bug-hunter']);
    expect(agents).not.toContain('security-scanner');
  });

  it('returns empty array when no High+ findings exist', () => {
    const sev: { critical: number; high: number; medium: number } = {
      critical: 0,
      high: 0,
      medium: 3,
    };
    expect(decideCascadeAgents('', sev)).toEqual([]);
  });

  it('detects security keywords in High section, not just Critical', () => {
    const report = [
      '## 🦂 Chimera Review',
      '',
      '### Critical (0)',
      '',
      '### High (1)',
      '1. [SECURITY] `src/handler.ts:20` — XSS via innerHTML on user input',
      '   → sanitize input before DOM insertion',
      '',
      '### Medium (0)',
    ].join('\n');
    const sev = parseReviewSeverity(report);
    const agents = decideCascadeAgents(report, sev);
    expect(agents).toContain('security-scanner');
  });

  it('does not flag Medium-only security keywords as security findings', () => {
    const report = [
      '## 🦂 Chimera Review',
      '',
      '### Critical (0)',
      '',
      '### High (0)',
      '',
      '### Medium (1)',
      '1. [SECURITY] `src/log.ts:5` — hardcoded secret in log message',
    ].join('\n');
    const sev = parseReviewSeverity(report);
    const agents = decideCascadeAgents(report, sev);
    // No High+ → no agents at all (medium doesn't cross threshold)
    expect(agents).toEqual([]);
  });

  it('matches the innerHTML keyword case-insensitively (regression: keyword was uppercased against a lowercased haystack)', () => {
    // A High finding mentioning innerHTML (mixed case) must select
    // security-scanner. Previously the keyword was stored as 'innerHTML'
    // but the haystack was lowercased, so it never matched.
    const report = [
      '## 🦂 Chimera Review',
      '',
      '### Critical (0)',
      '',
      '### High (1)',
      '1. [SECURITY] `src/render.ts:12` — XSS via innerHTML assignment of user input',
      '   → use textContent or sanitize',
      '',
      '### Medium (0)',
    ].join('\n');
    const sev = parseReviewSeverity(report);
    const agents = decideCascadeAgents(report, sev);
    expect(agents).toContain('security-scanner');
  });
});

// ── shouldCascade ──

describe('shouldCascade', () => {
  it('returns null when cascadeOn is off, regardless of severities', () => {
    expect(shouldCascade('off', { critical: 5, high: 5, medium: 5 })).toBeNull();
  });

  it('returns null when cascadeOn is off and there are no findings', () => {
    expect(shouldCascade('off', { critical: 0, high: 0, medium: 0 })).toBeNull();
  });

  it("returns 'critical' when a Critical finding exists and threshold is 'high'", () => {
    // A Critical finding crosses both thresholds; we report the highest crossed
    expect(shouldCascade('high', { critical: 1, high: 0, medium: 0 })).toBe('critical');
  });

  it("returns 'critical' when a Critical finding exists and threshold is 'critical'", () => {
    expect(shouldCascade('critical', { critical: 1, high: 2, medium: 3 })).toBe('critical');
  });

  it("returns 'high' when only High findings exist and threshold is 'high'", () => {
    expect(shouldCascade('high', { critical: 0, high: 3, medium: 0 })).toBe('high');
  });

  it("returns null when only High findings exist but threshold is 'critical'", () => {
    // Critical threshold requires at least one Critical finding
    expect(shouldCascade('critical', { critical: 0, high: 5, medium: 0 })).toBeNull();
  });

  it("returns null when only Medium findings exist and threshold is 'high'", () => {
    expect(shouldCascade('high', { critical: 0, high: 0, medium: 5 })).toBeNull();
  });

  it('returns null when no findings exist at all', () => {
    expect(shouldCascade('high', { critical: 0, high: 0, medium: 0 })).toBeNull();
    expect(shouldCascade('critical', { critical: 0, high: 0, medium: 0 })).toBeNull();
  });
});

describe('severitiesFromFindings (P0-2 verified-gating counts)', () => {
  it('counts only the severities present in the given findings', () => {
    const findings = [
      makeFinding({ severity: 'critical' }),
      makeFinding({ severity: 'high' }),
      makeFinding({ severity: 'medium' }),
      makeFinding({ severity: 'low' }),
    ];
    expect(severitiesFromFindings(findings)).toEqual({
      critical: 1,
      high: 1,
      medium: 1,
    });
  });

  it('returns zeros for an empty array', () => {
    expect(severitiesFromFindings([])).toEqual({ critical: 0, high: 0, medium: 0 });
  });
});

describe('decideCascadeAgents category routing (P0-1)', () => {
  const sevs = { critical: 1, high: 0, medium: 0 };

  it('routes security-category findings to security-scanner plus bug-hunter', () => {
    const findings = [
      makeFinding({ severity: 'critical', category: 'security', confidence: 'high' }),
    ];
    const agents = decideCascadeAgents('', sevs, findings);
    expect(agents).toContain('security-scanner');
    expect(agents).toContain('bug-hunter');
  });

  it('routes non-security categories to bug-hunter only (no keyword scan needed)', () => {
    const findings = [makeFinding({ severity: 'critical', category: 'bug' })];
    const agents = decideCascadeAgents('', sevs, findings);
    expect(agents).toEqual(['bug-hunter']);
  });

  it('falls back to the keyword scan when a High+ finding lacks a category', () => {
    // Mixed set: one categorized, one not. The uncategorized finding must
    // still be scanned for security keywords.
    const findings = [
      makeFinding({ severity: 'critical', category: 'bug', title: 'Logic error' }),
      makeFinding({
        severity: 'critical',
        title: 'SQL injection via string concat',
        description: 'unsanitized user input reaches the query builder',
      }),
    ];
    const agents = decideCascadeAgents(
      [
        '## 🦂 Chimera Review',
        '',
        '### Critical (1)',
        '1. SQL injection in login query — user input concatenated into SQL',
        '',
        '### High (0)',
        '',
        '### Medium (0)',
      ].join('\n'),
      sevs,
      findings,
    );
    expect(agents).toContain('security-scanner');
  });
});
