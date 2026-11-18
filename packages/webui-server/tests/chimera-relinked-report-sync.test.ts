import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  type ChimeraReviewCompletePayload,
  integrateFindings,
  persistReviewReport,
} from '@wrongstack/builtin-plugins';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createChimeraRouteHandlers } from '../src/server/chimera-routes.js';
import type { WSServerMessage } from '../src/server/types.js';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'webui-chimera-relinked-'));
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
        {
          path: 'src/cache.ts',
          status: 'modified',
          content: 'const x = 1;',
          diff: '+const x = 1;',
        },
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

describe('createChimeraRouteHandlers relinked/reopened report sync', () => {
  it('returns relinked findings in getReport and syncs linked reports in transitionFinding', async () => {
    const reviewText = '### High (1)\n1. [BUG] src/cache.ts:19 — Stale cache key on tenant switch';
    await persistReviewReport(makePayload(reviewText, 'sess-1'), 'r-web-1', dir);
    await integrateFindings(makePayload(reviewText, 'sess-1'), dir, 'r-web-1');
    await persistReviewReport(makePayload(reviewText, 'sess-2'), 'r-web-2', dir);
    await integrateFindings(makePayload(reviewText, 'sess-2'), dir, 'r-web-2');

    const sent: WSServerMessage[] = [];
    const handlers = createChimeraRouteHandlers({
      projectDir: () => dir,
      projectRoot: () => dir,
      send: (_ws, msg) => sent.push(msg),
    });

    await handlers.getReport!({} as never, {
      type: 'chimera.report.get',
      payload: { reportId: 'r-web-2' },
    });
    const detail = sent.at(-1) as {
      payload: { report: { lifecycle: string }; findings: Array<{ finding: { id: string } }> };
    };
    expect(detail.payload.findings).toHaveLength(1);
    const findingId = detail.payload.findings[0]!.finding.id;

    await handlers.transitionFinding!({} as never, {
      type: 'chimera.finding.transition',
      payload: { findingId, to: 'resolved', outcome: 'fixed' },
    });

    for (const reportId of ['r-web-1', 'r-web-2']) {
      await handlers.getReport!({} as never, {
        type: 'chimera.report.get',
        payload: { reportId },
      });
      const afterResolve = sent.at(-1) as { payload: { report: { lifecycle: string } } };
      expect(afterResolve.payload.report.lifecycle).toBe('completed');
    }

    // Reopening via WebUI reopens only the latest linked report (r-web-2)
    await handlers.transitionFinding!({} as never, {
      type: 'chimera.finding.transition',
      payload: { findingId, to: 'active', reason: 're-verify' },
    });
    await handlers.getReport!({} as never, {
      type: 'chimera.report.get',
      payload: { reportId: 'r-web-1' },
    });
    expect(
      (sent.at(-1) as { payload: { report: { lifecycle: string } } }).payload.report.lifecycle,
    ).toBe('completed');
    await handlers.getReport!({} as never, {
      type: 'chimera.report.get',
      payload: { reportId: 'r-web-2' },
    });
    expect(
      (sent.at(-1) as { payload: { report: { lifecycle: string } } }).payload.report.lifecycle,
    ).toBe('open');
  });
});
