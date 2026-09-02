import { describe, expect, it } from 'vitest';
import { addTool, formatToolSummary, newToolAgg } from '../src/hooks/fleet-chat-coalescer.js';

describe('fleet-chat-coalescer', () => {
  it('empty aggregate formats to the empty string', () => {
    expect(formatToolSummary(newToolAgg())).toBe('');
  });

  it('counts calls per tool and orders by count descending', () => {
    const agg = newToolAgg();
    for (let i = 0; i < 9; i++) addTool(agg, 'grep', true, 100);
    for (let i = 0; i < 5; i++) addTool(agg, 'read', true, 100);
    addTool(agg, 'bash', true, 100);
    expect(formatToolSummary(agg)).toBe('15 tools · grep×9 read×5 bash · 1.5s');
  });

  it('singular "1 tool" and single call omits the ×1 suffix', () => {
    const agg = newToolAgg();
    addTool(agg, 'read', true, 42);
    expect(formatToolSummary(agg)).toBe('1 tool · read · 42ms');
  });

  it('collapses beyond maxTools into "+N more"', () => {
    const agg = newToolAgg();
    for (const name of ['a', 'b', 'c', 'd', 'e', 'f']) addTool(agg, name);
    expect(formatToolSummary(agg)).toBe('6 tools · a b c d +2 more');
  });

  it('reports failures with the ✗ marker', () => {
    const agg = newToolAgg();
    addTool(agg, 'edit', false, 10);
    addTool(agg, 'edit', true, 10);
    expect(formatToolSummary(agg)).toBe('2 tools · edit×2 · 20ms · 1 ✗');
  });

  it('formats durations across ms/s/m ranges', () => {
    const ms = newToolAgg();
    addTool(ms, 't', true, 500);
    expect(formatToolSummary(ms)).toContain('500ms');

    const s = newToolAgg();
    addTool(s, 't', true, 3_200);
    expect(formatToolSummary(s)).toContain('3.2s');

    const m = newToolAgg();
    addTool(m, 't', true, 90_000);
    expect(formatToolSummary(m)).toContain('1.5m');
  });

  it('omits the duration segment when no call reported one', () => {
    const agg = newToolAgg();
    addTool(agg, 'grep');
    addTool(agg, 'grep', true);
    expect(formatToolSummary(agg)).toBe('2 tools · grep×2');
  });

  it('ignores non-finite and negative durations', () => {
    const agg = newToolAgg();
    addTool(agg, 'grep', true, Number.NaN);
    addTool(agg, 'grep', true, -5);
    addTool(agg, 'grep', true, 10);
    expect(formatToolSummary(agg)).toBe('3 tools · grep×3 · 10ms');
  });
});
