import { describe, expect, it } from 'vitest';
import { summarizeSessionEvents } from '../../src/storage/session-store/summary-builder.js';

describe('summarizeSessionEvents prototype key safety (F373)', () => {
  it('counts tool names colliding with Object.prototype keys like "toString" numerically', async () => {
    const summary = await summarizeSessionEvents({
      id: 's1',
      mtime: '2026-11-15T00:00:00.000Z',
      events: [
        { type: 'session_start', id: 's1', ts: new Date().toISOString() },
        { type: 'tool_call_start', name: 'toString', ts: new Date().toISOString() },
      ] as never,
    });
    expect(summary.toolBreakdown?.['toString']).toBe(1);
  });
});
