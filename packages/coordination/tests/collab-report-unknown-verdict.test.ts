import { describe, expect, it } from 'vitest';
import { assembleReport, type CollabDebugReportHost } from '../src/collab-debug-report.js';
import type { CriticEvaluation } from '../src/collab-debug-types.js';

describe('assembleReport (F2199)', () => {
  it('fails closed to reject when an evaluation carries an unknown verdict', () => {
    const report = assembleReport({
      bugs: new Map(),
      plans: new Map(),
      evaluations: new Map([
        [
          'e1',
          {
            verdict: 'unknown_verdict',
            score: 1,
            subjectType: 'bug',
            concerns: [],
          } as unknown as CriticEvaluation,
        ],
      ]),
      cancelled: false,
      buildMarkdownSummary: () => '',
      sessionId: 's1',
      snapshot: { createdAt: '2026-11-25T00:00:00Z', files: [] },
      options: { targetPaths: [] },
      alerts: [],
      snapshotWarnings: [],
    } as unknown as CollabDebugReportHost);

    expect(report.overallVerdict).toBe('reject');
  });
});
