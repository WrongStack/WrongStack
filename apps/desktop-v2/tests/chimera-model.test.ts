import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { validateTransition } from '../../../packages/builtin-plugins/src/review-finding-types';
import { validateReportTransition } from '../../../packages/builtin-plugins/src/review-report-types';
import { ChimeraFinding } from '../src/ChimeraFinding';
import {
  reviewFilteredReports,
  reviewFindingCounts,
  reviewFindingTransitions,
  reviewFollowup,
  reviewReportTransitions,
  reviewTokensCompact,
  reviewUsdCost,
} from '../src/chimera-model';

describe('Project Chimera review contracts', () => {
  it('offers exactly the canonical finding and report lifecycle transitions', () => {
    for (const [from, allowed] of Object.entries(reviewFindingTransitions))
      for (const to of Object.keys(reviewFindingTransitions)) {
        if (from === to || allowed.includes(to))
          expect(() => validateTransition(from as never, to as never)).not.toThrow();
        else expect(() => validateTransition(from as never, to as never)).toThrow();
      }
    for (const [from, allowed] of Object.entries(reviewReportTransitions))
      for (const to of Object.keys(reviewReportTransitions)) {
        if (from === to || allowed.includes(to))
          expect(() => validateReportTransition(from as never, to as never)).not.toThrow();
        else expect(() => validateReportTransition(from as never, to as never)).toThrow();
      }
  });
  it('filters recorded report metadata without treating it as a desktop conversation owner', () => {
    const rows = [
      { reportId: 'r1', sessionId: 'old-session', reviewerModel: 'model-a' },
      { reportId: 'r2', sessionId: 'other-session', reviewerModel: 'model-b' },
    ];
    expect(reviewFilteredReports(rows, ' MODEL-A ', '')).toEqual([rows[0]]);
    expect(reviewFilteredReports(rows, '', 'other-session')).toEqual([rows[1]]);
    expect(reviewFollowup({ id: 'r1', sessionId: 'old-session', totalFindings: 2 })).toContain(
      'recorded session old-session',
    );
  });
  it('keeps active, resolved and ignored findings distinct in report progress', () => {
    expect(
      reviewFindingCounts(
        ['active', 'triaged', 'in_progress', 'resolved', 'ignored'].map((status) => ({
          finding: { status },
        })),
      ),
    ).toEqual({ open: 3, resolved: 1, ignored: 1 });
  });
  it('renders citation verification as evidence rather than a resolved defect', () => {
    const markup = renderToStaticMarkup(
      createElement(ChimeraFinding, {
        row: {
          finding: {
            id: 'f1',
            title: 'Recorded finding',
            severity: 'high',
            status: 'active',
            description: 'Review this observation.',
            category: 'bug',
            confidence: 'medium',
            verification: {
              status: 'verified',
              reason: 'anchor_found',
              evidence: 'const value = input;',
            },
            suggestedFix: 'Review the input guard.',
          },
          events: [],
        },
        busy: false,
        onTransition() {},
        onOpenFile() {},
      }),
    );
    expect(markup).toContain('Disk citation: Verified');
    expect(markup).toContain('Record resolution');
    expect(markup).toContain('Medium reviewer confidence');
    expect(markup).not.toContain('Recorded outcome:');
    expect(markup).not.toContain('[object Object]');
  });
  it('formats compact token/cost telemetry and filters reports by headSha', () => {
    expect(reviewTokensCompact(0)).toBe('0');
    expect(reviewTokensCompact(850)).toBe('850');
    expect(reviewTokensCompact(1_850)).toBe('1.9k');
    expect(reviewTokensCompact(24_200)).toBe('24k');
    expect(reviewUsdCost(0)).toBe('');
    expect(reviewUsdCost(0.0038)).toBe('$0.0038');
    expect(reviewUsdCost(0.045)).toBe('$0.045');
    const rows = [{ reportId: 'r1', sessionId: 's1', headSha: 'deadbeef12' }];
    expect(reviewFilteredReports(rows, 'deadbeef', '')).toEqual(rows);
  });
});
