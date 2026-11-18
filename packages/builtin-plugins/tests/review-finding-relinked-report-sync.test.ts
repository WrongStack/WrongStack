import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { integrateFindings } from '../src/review-finding-integration.js';
import { JsonlFindingStore } from '../src/review-finding-store.js';
import { transitionFinding } from '../src/review-finding-transition.js';
import { resolveChimeraFollowupBriefing } from '../src/review-followup-briefing.js';
import { persistReviewReport } from '../src/review-report-integration.js';
import { JsonlReportStore } from '../src/review-report-store.js';
import type { ChimeraReviewCompletePayload } from '../src/review-types.js';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'finding-relinked-sync-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

function makePayload(reviewText: string, sessionId: string): ChimeraReviewCompletePayload {
  return {
    cwd: dir,
    sessionId,
    status: 'success',
    reviewText,
    bundle: {
      cwd: dir,
      files: [
        { path: 'src/auth.ts', status: 'modified', content: 'const x = 1;', diff: '+const x = 1;' },
      ],
      config: {
        enabled: true,
        provider: 'anthropic',
        model: 'test-model',
        maxFiles: 10,
        autoFix: 'off',
        cascadeOn: 'off',
        maxCascadeDepth: 2,
        fallbackModels: [],
        fallbackProfile: undefined,
      },
    },
  };
}

describe('reopened and relinked finding report linkage', () => {
  it('lists reopened regression findings under the new reportId, briefs them, and auto-completes the regression report on resolve', async () => {
    const findingStore = new JsonlFindingStore(dir);
    const reportStore = new JsonlReportStore(dir);
    const reviewText =
      '### Critical (1)\n1. [SECURITY] src/auth.ts:42 — Auth bypass on empty header';

    await persistReviewReport(makePayload(reviewText, 'sess-1'), 'r-1', dir);
    await integrateFindings(makePayload(reviewText, 'sess-1'), dir, 'r-1');
    const [f1] = await findingStore.list({ reportId: 'r-1' });
    expect(f1).toBeDefined();

    await transitionFinding(f1!.id, 'resolve', ['--outcome', 'fixed'], { projectDir: dir });
    expect((await reportStore.get('r-1'))?.lifecycle).toBe('completed');

    // Regression in r-2 reopens the deduplicated finding
    await persistReviewReport(makePayload(reviewText, 'sess-2'), 'r-2', dir);
    const upsertR2 = await integrateFindings(makePayload(reviewText, 'sess-2'), dir, 'r-2');
    expect(upsertR2.reopened).toBe(1);

    expect(await findingStore.list({ reportId: 'r-1' })).toHaveLength(1);
    expect(await findingStore.list({ reportId: 'r-2' })).toHaveLength(1);
    expect(await findingStore.listWithEvents({ reportId: 'r-2' })).toHaveLength(1);

    const briefing = await resolveChimeraFollowupBriefing('Review Chimera report "r-2"', {
      projectDir: dir,
      cwd: dir,
      transitionToActioned: false,
    });
    expect(briefing?.actionableCount).toBe(1);

    await transitionFinding(f1!.id, 'resolve', ['--outcome', 'fixed'], { projectDir: dir });
    expect((await reportStore.get('r-2'))?.lifecycle).toBe('completed');

    // Manual reopen reopens only the latest linked report (r-2), leaving historical r-1 completed
    await transitionFinding(f1!.id, 'reopen', ['--reason', 'double-check'], { projectDir: dir });
    expect((await reportStore.get('r-2'))?.lifecycle).toBe('open');
    expect((await reportStore.get('r-1'))?.lifecycle).toBe('completed');
  });

  it('auto-completes all open linked reports when an active relinked finding is resolved', async () => {
    const findingStore = new JsonlFindingStore(dir);
    const reportStore = new JsonlReportStore(dir);
    const reviewText = '### High (1)\n1. [BUG] src/cache.ts:19 — Stale cache key on tenant switch';

    await persistReviewReport(makePayload(reviewText, 'sess-1'), 'r-open-1', dir);
    await integrateFindings(makePayload(reviewText, 'sess-1'), dir, 'r-open-1');
    await persistReviewReport(makePayload(reviewText, 'sess-2'), 'r-open-2', dir);
    const upsertR2 = await integrateFindings(makePayload(reviewText, 'sess-2'), dir, 'r-open-2');
    expect(upsertR2.relinked).toBe(1);

    const [finding] = await findingStore.list({ reportId: 'r-open-2' });
    expect(finding).toBeDefined();

    await transitionFinding(finding!.id, 'resolve', ['--outcome', 'fixed'], { projectDir: dir });
    expect((await reportStore.get('r-open-1'))?.lifecycle).toBe('completed');
    expect((await reportStore.get('r-open-2'))?.lifecycle).toBe('completed');
  });
});
