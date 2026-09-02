/**
 * Integration tests for the Chimera finding pipeline.
 *
 * Verifies that a chimera.review_complete event flows through
 * integrateFindings() and persistReviewReport() into both stores,
 * and that the resulting findings are queryable via the CLI commands.
 *
 * This is the missing FS-P0.6 coverage (FS-P0.GATE AC1, AC6).
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { integrateFindings } from '../../src/plugins/review-finding-integration.js';
import { persistReviewReport } from '../../src/plugins/review-report-integration.js';
import { JsonlFindingStore } from '../../src/plugins/review-finding-store.js';
import { JsonlReportStore } from '../../src/plugins/review-report-store.js';
import { executeFindingCommand } from '../../src/plugins/review-finding-commands.js';
import type { ChimeraReviewCompletePayload } from '../../src/plugins/chimera-plugin.js';

const CANONICAL_REPORT = [
  '## 🦂 Chimera Review',
  '',
  '### Critical (1)',
  '1. [BUG] src/auth.ts:42 — Null dereference on user lookup without guard',
  '   → Add guard: if (!user) throw new NotFoundError()',
  '',
  '### High (2)',
  '1. [SECURITY] src/config.ts:8 — Hardcoded API key in source',
  '   → Move to environment variable',
  '2. [BUG] src/db.ts:55 — Database connection leak on error path',
  '   → Always call pool.end() in finally block',
  '',
  '### Medium (0)',
  '',
  'Duration: 31s',
].join('\n');

const EMPTY_REPORT = '## 🦂 Chimera Review — all clear ✅\nNo issues found.';

function makePayload(
  reviewText: string,
  overrides: Partial<ChimeraReviewCompletePayload> = {},
): ChimeraReviewCompletePayload {
  return {
    bundle: {
      config: {
        enabled: true,
        provider: 'test-provider',
        model: 'test-model',
        maxFiles: 15,
        autoFix: 'off',
        cascadeOn: 'off' as const,
        maxCascadeDepth: 2,
        fallbackModels: [],
        fallbackProfile: undefined,
      },
      cwd: process.cwd(),
      files: [
        {
          path: 'src/auth.ts',
          status: 'modified' as const,
          content: 'export function login(user: any) { return user.name; }',
        },
      ],
    },
    reviewText,
    status: 'success',
    cwd: process.cwd(),
    sessionId: 'integration-test-session',
    ...overrides,
  };
}

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'finding-integration-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('Chimera finding integration — FS-P0.6', () => {
  it('persists findings and report from a canonical review', async () => {
    const payload = makePayload(CANONICAL_REPORT);
    const reportId = 'test-report-001';

    // Persist the report first, then findings (mirrors tryPersistFindings order)
    const reportResult = await persistReviewReport(payload, reportId, dir);
    expect(reportResult.reportId).toBe(reportId);
    expect(reportResult.created).toBe(true);
    expect(reportResult.totalFindings).toBe(3); // 1 critical + 2 high

    const findingResult = await integrateFindings(payload, dir, reportId);
    expect(findingResult.reportId).toBe(reportId);
    expect(findingResult.created).toBe(3);
    expect(findingResult.relinked).toBe(0);
    expect(findingResult.reopened).toBe(0);
    expect(findingResult.totalFindings).toBe(3);
    expect(findingResult.unparseableCount).toBe(0);
  });

  it('uses sessionId from payload when available', async () => {
    const payload = makePayload(CANONICAL_REPORT, { sessionId: 'my-session-42' });
    const reportId = 'test-report-002';

    await persistReviewReport(payload, reportId, dir);
    await integrateFindings(payload, dir, reportId);

    // Verify findings carry the session ID
    const findingStore = new JsonlFindingStore(dir);
    const all = await findingStore.list({ limit: 100 });
    for (const f of all) {
      expect(f.originReport.sessionId).toBe('my-session-42');
    }

    // Verify the report carries the session ID
    const reportStore = new JsonlReportStore(dir);
    const report = await reportStore.get(reportId);
    expect(report).not.toBeNull();
    expect(report!.sessionId).toBe('my-session-42');
  });

  it('falls back to cwd when sessionId is missing (backward compat)', async () => {
    const payload = makePayload(CANONICAL_REPORT, { sessionId: undefined });
    const reportId = 'test-report-003';

    await persistReviewReport(payload, reportId, dir);
    await integrateFindings(payload, dir, reportId);

    // Should fall back to payload.cwd
    const findingStore = new JsonlFindingStore(dir);
    const all = await findingStore.list({ limit: 100 });
    for (const f of all) {
      expect(f.originReport.sessionId).toBe(process.cwd());
    }
  });

  it('handles an empty review text gracefully', async () => {
    const payload = makePayload(EMPTY_REPORT);
    const reportId = 'test-report-004';

    const reportResult = await persistReviewReport(payload, reportId, dir);
    expect(reportResult.created).toBe(true);
    expect(reportResult.totalFindings).toBe(0);

    const findingResult = await integrateFindings(payload, dir, reportId);
    expect(findingResult.created).toBe(0);
    expect(findingResult.totalFindings).toBe(0);
  });

  it('handles empty string review text (failed review)', async () => {
    const payload = makePayload('', { status: 'failed' });
    const reportId = 'test-report-005';

    const reportResult = await persistReviewReport(payload, reportId, dir);
    expect(reportResult.created).toBe(true);
    // A failed review still persists the report for audit trail

    const findingResult = await integrateFindings(payload, dir, reportId);
    expect(findingResult.created).toBe(0);
    expect(findingResult.totalFindings).toBe(0);
  });

  it('makes findings queryable via /review CLI commands', async () => {
    const payload = makePayload(CANONICAL_REPORT);
    const reportId = 'test-report-006';

    await persistReviewReport(payload, reportId, dir);
    await integrateFindings(payload, dir, reportId);

    // List findings
    const listing = await executeFindingCommand(['findings'], { projectDir: dir });
    expect(listing).toContain('critical');
    expect(listing).toContain('auth.ts');
    expect(listing).toContain('config.ts');
    expect(listing).toContain('3 finding(s)');

    // Filter by severity
    const criticalOnly = await executeFindingCommand(['findings', '--severity', 'critical'], {
      projectDir: dir,
    });
    expect(criticalOnly).toContain('Null dereference');
    expect(criticalOnly).not.toContain('Hardcoded API key');

    // Show individual finding
    const store = new JsonlFindingStore(dir);
    const all = await store.list({ limit: 100 });
    const detail = await executeFindingCommand(['finding', all[0]!.id], { projectDir: dir });
    expect(detail).toContain(all[0]!.title);
    expect(detail).toContain('Lifecycle');

    // List reports
    const reports = await executeFindingCommand(['reports'], { projectDir: dir });
    expect(reports).toContain('test-report-006'.substring(0, 8));

    // Show report
    const reportDetail = await executeFindingCommand(['report', reportId], { projectDir: dir });
    expect(reportDetail).toContain('open');
    expect(reportDetail).toContain('Duration: 31s');
  });

  it('classifies source as chimera, auto, or cascade based on bundle', async () => {
    // Default: no cascadeOn → 'chimera'
    const chimeraPayload = makePayload(CANONICAL_REPORT);
    await persistReviewReport(chimeraPayload, 'chimera-src', dir);
    await integrateFindings(chimeraPayload, dir, 'chimera-src');
    const findingStore = new JsonlFindingStore(dir);
    const chimeraFindings = await findingStore.list({ limit: 100 });
    expect(chimeraFindings.every((f) => f.source === 'chimera')).toBe(true);

    // cascadeOn: 'high' but depth=0 → 'auto'
    const autoPayload = makePayload(CANONICAL_REPORT, {
      bundle: {
        config: {
          enabled: true,
          provider: 'p',
          model: 'm',
          maxFiles: 15,
          autoFix: 'off',
          cascadeOn: 'off' as const,
          maxCascadeDepth: 2,
          fallbackModels: [],
          fallbackProfile: undefined,
        },
        cwd: process.cwd(),
        files: [],
        cascadeOn: 'high' as const,
      },
    });
    await integrateFindings(autoPayload, dir, 'auto-src');
    const autoFindings = (await findingStore.list({ limit: 100 })).filter(
      (f) => f.originReport.reportId === 'auto-src',
    );
    expect(autoFindings.every((f) => f.source === 'auto')).toBe(true);

    // cascadeDepth=1 → 'cascade'
    const cascadePayload = makePayload(CANONICAL_REPORT, {
      bundle: {
        config: {
          enabled: true,
          provider: 'p',
          model: 'm',
          maxFiles: 15,
          autoFix: 'off',
          cascadeOn: 'off' as const,
          maxCascadeDepth: 2,
          fallbackModels: [],
          fallbackProfile: undefined,
        },
        cwd: process.cwd(),
        files: [],
        cascadeDepth: 1,
      },
    });
    await integrateFindings(cascadePayload, dir, 'cascade-src');
    const cascadeFindings = (await findingStore.list({ limit: 100 })).filter(
      (f) => f.originReport.reportId === 'cascade-src',
    );
    expect(cascadeFindings.every((f) => f.source === 'cascade')).toBe(true);
  });

  it('prefers the execution-owner parsedReport over re-parsing reviewText (P0-1/P0-2)', async () => {
    const reviewText = '### Critical (1)\n1. [SECURITY] src/auth.ts:99 — phantom finding\n';
    // The disk-verified report carries a finding that differs from what
    // parsing reviewText would produce: different severity, plus category,
    // confidence, and a verification stamp.
    const payload = makePayload(reviewText, {
      parsedReport: {
        findings: [
          {
            id: 'structured-1',
            fingerprint: 'structured-fp-1',
            severity: 'high',
            source: 'auto',
            category: 'security',
            confidence: 'high',
            location: { file: 'src/auth.ts', line: 42 },
            title: 'Structured finding',
            description: 'The execution owner verified this against disk.',
            createdAt: new Date().toISOString(),
            status: 'active',
            verification: {
              status: 'verified',
              reason: 'anchor_found',
              evidence: 'export async function login(user: any) {',
            },
            originReport: {
              reportId: 'pre-parsed-001',
              sessionId: 's1',
              agentId: 'a1',
              reviewerModel: 'm1',
            },
          },
        ],
        unparseableCount: 0,
        structured: true,
      },
    });

    const reportId = 'pre-parsed-001';
    await persistReviewReport(payload, reportId, dir);
    const findingResult = await integrateFindings(payload, dir, reportId);
    expect(findingResult.created).toBe(1);

    const store = new JsonlFindingStore(dir);
    const all = await store.list({ limit: 10, reportId });
    expect(all).toHaveLength(1);
    const finding = all[0]!;
    // The structured item wins over the markdown text (severity, category,
    // confidence, verification all carried through untouched).
    expect(finding.severity).toBe('high');
    expect(finding.category).toBe('security');
    expect(finding.confidence).toBe('high');
    expect(finding.verification?.status).toBe('verified');
    expect(finding.verification?.reason).toBe('anchor_found');
    expect(finding.title).toBe('Structured finding');
    expect(finding.location?.line).toBe(42);
    // The execution-owner stamped source wins over the bundle-derived
    // classification (bundle has no cascadeOn/cascadeDepth → 'chimera').
    expect(finding.source).toBe('auto');
  });

  it('auto-completes report when all findings are resolved', async () => {
    const payload = makePayload(CANONICAL_REPORT);
    const reportId = 'auto-complete-test';

    await persistReviewReport(payload, reportId, dir);
    await integrateFindings(payload, dir, reportId);

    // Resolve all 3 findings
    const store = new JsonlFindingStore(dir);
    const all = await store.list({ limit: 100, reportId });
    expect(all.length).toBe(3);

    for (const finding of all) {
      await store.transition(
        finding.id,
        'resolved',
        { id: 'operator', kind: 'operator' },
        { outcome: 'fixed' },
      );
    }

    // Auto-completion should have fired (triggered via syncReportCompletion)
    // We simulate the same call the CLI transition command makes
    const { syncReportCompletion } = await import('../../src/plugins/review-report-integration.js');
    const result = await syncReportCompletion(reportId, dir, { id: 'operator', kind: 'operator' });
    expect(result.completed).toBe(true);
    expect(result.totalFindings).toBe(3);

    // Verify report is now completed
    const reportStore = new JsonlReportStore(dir);
    const report = await reportStore.get(reportId);
    expect(report).not.toBeNull();
    expect(report!.lifecycle).toBe('completed');
  });
});
