import { describe, expect, it } from 'vitest';
import { SessionSummaryTracker } from '../../src/storage/session-summary-tracker.js';

describe('SessionSummaryTracker prototype key safety (F371)', () => {
  it('counts tool names colliding with Object.prototype keys like "toString" numerically', async () => {
    const tracker = new SessionSummaryTracker({
      id: 's1',
      startedAt: new Date().toISOString(),
      meta: { model: 'm', provider: 'p' } as never,
    });

    tracker.observe({
      type: 'tool_call_start',
      name: 'toString',
      ts: new Date().toISOString(),
    } as never);

    const summary = await tracker.finalize();
    expect(summary.toolBreakdown?.['toString']).toBe(1);
  });
});
