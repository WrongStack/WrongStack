/**
 * Finding store end-to-end integration test.
 *
 * Verifies that a simulated chimera.review_complete event produces
 * persisted findings that are queryable via the store and CLI.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JsonlFindingStore } from '../../src/plugins/review-finding-store.js';
import { parseChimeraReviewReport } from '../../src/plugins/review-finding-parser.js';
import { executeFindingCommand } from '../../src/plugins/review-finding-commands.js';

const REPORT = [
  '### Critical (1)',
  '1. [BUG] src/auth.ts:42 — Null dereference on user lookup',
  '   → Add guard: if (!user) throw new NotFoundError()',
  '',
  '### High (2)',
  '1. src/db.ts:15 — Unclosed database connection',
  '   → Always call pool.end() in finally block',
  '2. src/config.ts:3 — Hardcoded API token in source',
  '   → Move to environment variable and remove from repo',
  '',
  '### Medium (1)',
  '1. src/utils.ts:88 — Unused helper function "formatDate"',
  '   → Remove or export if used externally',
  '',
  'Duration: 47s',
].join('\n');

let dir: string;
let store: JsonlFindingStore;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'finding-e2e-'));
  store = new JsonlFindingStore(dir);
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('Finding store end-to-end pipeline', () => {
  it('parses a realistic review report and persists findings', async () => {
    // 1. Parse the report
    const parsed = parseChimeraReviewReport(REPORT, {
      sessionId: 'test-sess',
      reviewerModel: 'gpt-5.6-sol',
      reviewType: 'auto',
      reportId: 'report-1',
    });

    expect(parsed.findings.length).toBe(4); // 1 + 2 + 1
    expect(parsed.unparseableCount).toBe(0);
    expect(parsed.durationSeconds).toBe(47);

    // 2. Upsert into store
    const upsertResult = await store.upsert(parsed.findings, {
      sessionId: 'test-sess',
      reportId: 'report-1',
      agentId: 'chimera-review',
      model: 'gpt-5.6-sol',
    });

    expect(upsertResult.created).toBe(4);

    // 3. Query back from store
    const all = await store.list({ limit: 100 });
    expect(all.length).toBe(4);

    // Verify severity counts
    const critical = all.filter((f) => f.severity === 'critical');
    const high = all.filter((f) => f.severity === 'high');
    const medium = all.filter((f) => f.severity === 'medium');
    expect(critical).toHaveLength(1);
    expect(high).toHaveLength(2);
    expect(medium).toHaveLength(1);

    // Verify first finding
    const authFinding = critical[0]!;
    expect(authFinding.location?.file).toBe('src/auth.ts');
    expect(authFinding.location?.line).toBe(42);
    expect(authFinding.title).toContain('Null dereference');
    expect(authFinding.suggestedFix).toBeDefined();
    expect(authFinding.suggestedFix).toContain('NotFoundError');
    expect(authFinding.status).toBe('active');

    // Verify file:line extraction on high
    for (const f of high) {
      expect(f.location?.file).toBeDefined();
      expect(f.location?.line).toBeGreaterThan(0);
    }
  });

  it('survives multiple report upserts — deduplicates by fingerprint', async () => {
    // First report
    const parsed1 = parseChimeraReviewReport(REPORT, {
      sessionId: 'sess-1',
      reviewerModel: 'm1',
      reviewType: 'auto',
      reportId: 'r1',
    });
    const r1 = await store.upsert(parsed1.findings, {
      sessionId: 'sess-1',
      reportId: 'r1',
      agentId: 'chimera-review',
      model: 'm1',
    });
    expect(r1.created).toBe(4);

    // Second report with the same findings (simulating re-review of same file)
    const parsed2 = parseChimeraReviewReport(REPORT, {
      sessionId: 'sess-2',
      reviewerModel: 'm2',
      reviewType: 'auto',
      reportId: 'r2',
    });
    const r2 = await store.upsert(parsed2.findings, {
      sessionId: 'sess-2',
      reportId: 'r2',
      agentId: 'chimera-review',
      model: 'm2',
    });
    // Most should be relinked, not created (fingerprint dedup)
    expect(r2.relinked).toBeGreaterThanOrEqual(3);
    expect(r2.created).toBe(0);
  });

  it('returns findings via /review findings CLI command', async () => {
    const parsed = parseChimeraReviewReport(REPORT, {
      sessionId: 'cli-test',
      reviewerModel: 'm',
      reviewType: 'auto',
      reportId: 'cr',
    });
    await store.upsert(parsed.findings, {
      sessionId: 'cli-test',
      reportId: 'cr',
      agentId: 'chimera-review',
      model: 'm',
    });

    // Unfiltered list
    const list = await executeFindingCommand(['findings'], { projectDir: dir });
    expect(list).toContain('critical');
    expect(list).toContain('auth.ts');
    expect(list).toContain('4 finding(s)');

    // Filter by severity
    const criticalOnly = await executeFindingCommand(['findings', '--severity', 'critical'], {
      projectDir: dir,
    });
    expect(criticalOnly).toContain('Null dereference');
    expect(criticalOnly).not.toContain('Hardcoded API token');

    // Finding detail
    const all = await store.list({ limit: 100 });
    const detail = await executeFindingCommand(['finding', all[0]!.id], { projectDir: dir });
    expect(detail).toContain(all[0]!.title);
    expect(detail).toContain('Lifecycle');
  });
});
