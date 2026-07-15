import { describe, expect, it } from 'vitest';
import { panelWindow, truncatePanelText } from '../src/components/monitor-shell.js';

describe('monitor shell helpers', () => {
  it('keeps the selected row inside a bounded centered window', () => {
    expect(panelWindow(20, 10, 6)).toEqual({ start: 7, end: 13, above: 7, below: 7 });
    expect(panelWindow(20, 0, 6)).toEqual({ start: 0, end: 6, above: 0, below: 14 });
    expect(panelWindow(20, 19, 6)).toEqual({ start: 14, end: 20, above: 14, below: 0 });
  });

  it('normalizes and truncates panel text', () => {
    expect(truncatePanelText(' hello\n  monitor ', 20)).toBe('hello monitor');
    expect(truncatePanelText('abcdefgh', 5)).toBe('abcd…');
  });
});
