import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JsonlFindingStore } from '../../src/plugins/review-finding-store.js';
import type { ChimeraFinding } from '../../src/plugins/review-finding-types.js';
import { JsonlReportStore } from '../../src/plugins/review-report-store.js';
import {
  maybeCompactReviewStores,
  REVIEW_STORE_MAINTENANCE_FILE,
} from '../../src/plugins/review-store-maintenance.js';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-store-maintenance-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('review store maintenance', () => {
  it('skips small stores without creating maintenance state', async () => {
    const result = await maybeCompactReviewStores(dir);

    expect(result).toMatchObject({ compacted: false, reason: 'below_threshold', totalBytes: 0 });
    await expect(fs.stat(path.join(dir, REVIEW_STORE_MAINTENANCE_FILE))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('compacts above the threshold and throttles subsequent rewrites', async () => {
    const reportStore = new JsonlReportStore(dir);
    await reportStore.persist({
      id: 'report-1',
      sessionId: 'session-1',
      agentId: 'chimera',
      reviewerModel: 'reviewer',
      source: 'chimera',
      reviewStatus: 'success',
      files: [],
      counts: { critical: 0, high: 0, medium: 0, low: 0 },
      totalFindings: 0,
      unparseableCount: 0,
      rawText: 'all clear',
    });

    const first = await maybeCompactReviewStores(dir, {
      thresholdBytes: 0,
      intervalMs: 60_000,
      now: Date.parse('2026-08-02T00:00:00.000Z'),
    });
    const second = await maybeCompactReviewStores(dir, {
      thresholdBytes: 0,
      intervalMs: 60_000,
      now: Date.parse('2026-08-02T00:00:01.000Z'),
    });

    expect(first).toMatchObject({ compacted: true, reason: 'compacted' });
    expect(second).toMatchObject({ compacted: false, reason: 'interval' });
    expect(await reportStore.get('report-1')).not.toBeNull();
  });

  it('serializes concurrent finding upserts before deduplication', async () => {
    const store = new JsonlFindingStore(dir);
    const finding = makeFinding();

    const [first, second] = await Promise.all([
      store.upsert([finding], context('report-1')),
      store.upsert([{ ...finding, id: 'finding-2' }], context('report-2')),
    ]);

    expect(first.created + second.created).toBe(1);
    expect(first.relinked + second.relinked).toBe(1);
    expect(await store.list()).toHaveLength(1);
  });
});

function context(reportId: string) {
  return {
    sessionId: 'session-1',
    reportId,
    agentId: 'chimera',
    model: 'reviewer',
  };
}

function makeFinding(): ChimeraFinding {
  return {
    id: 'finding-1',
    fingerprint: 'same-fingerprint',
    title: 'Issue',
    description: 'Details',
    severity: 'high',
    source: 'chimera',
    status: 'active',
    location: { file: 'src/file.ts', line: 1 },
    suggestedFix: 'Fix it',
    originReport: {
      reportId: 'report-1',
      sessionId: 'session-1',
      agentId: 'chimera',
      reviewerModel: 'reviewer',
    },
    createdAt: '2026-08-02T00:00:00.000Z',
  };
}
