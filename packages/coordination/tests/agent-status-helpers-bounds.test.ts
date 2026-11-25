import { describe, expect, it } from 'vitest';
import { boundedText, completedToolReceipt } from '../src/agent-status-helpers.js';

describe('agent-status-helpers numeric bounds', () => {
  it('returns empty string for non-positive or NaN boundedText caps and guards non-finite durationMs', () => {
    expect(boundedText('hello world', 5)).toBe('hell…');
    expect(boundedText('hello world', 0)).toBe('');
    expect(boundedText('hello world', -2)).toBe('');
    expect(boundedText('hello world', Number.NaN)).toBe('');

    const nanReceipt = completedToolReceipt({ name: 'read', durationMs: Number.NaN });
    expect(nanReceipt.durationMs).toBe(0);
    expect(Number.isFinite(nanReceipt.startedAt)).toBe(true);
  });
});
