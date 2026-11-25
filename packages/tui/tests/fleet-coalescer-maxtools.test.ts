import { describe, expect, it } from 'vitest';
import { addTool, formatToolSummary, newToolAgg } from '../src/hooks/fleet-chat-coalescer.js';

describe('formatToolSummary maxTools bounds guard', () => {
  it('clamps negative maxTools to 0 and defaults NaN to 4', () => {
    const agg = newToolAgg();
    addTool(agg, 'read', true, 100);
    addTool(agg, 'grep', true, 200);
    expect(formatToolSummary(agg, -1)).toContain('+2 more');
    expect(formatToolSummary(agg, Number.NaN)).toContain('read');
    expect(formatToolSummary(agg, Number.NaN)).toContain('grep');
  });
});
