import { describe, expect, it } from 'vitest';
import {
  formatDelegateStartedText,
  formatDelegateSuccessText,
  formatHistoryDuration,
  formatSubagentCompletionText,
  shortenTaskPreview,
} from '../src/hooks/subagent-history-format.js';

describe('formatHistoryDuration', () => {
  it('formats short and long windows', () => {
    expect(formatHistoryDuration(1_200)).toBe('1.2s');
    expect(formatHistoryDuration(12_000)).toBe('12s');
    expect(formatHistoryDuration(171_000)).toBe('2m 51s');
    expect(formatHistoryDuration(120_000)).toBe('2m');
    expect(formatHistoryDuration(3_600_000)).toBe('1h');
  });
});

describe('shortenTaskPreview', () => {
  it('collapses whitespace and elides long tasks', () => {
    expect(shortenTaskPreview('  Review\n  only  the current  ')).toBe('Review only the current');
    const long = 'Review only the current on-disk changes in packages/cli/src/renderer.ts and more';
    const out = shortenTaskPreview(long, 40);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(40);
  });
});

describe('formatSubagentCompletionText', () => {
  it('humanizes budget_timeout without dumping the engine message', () => {
    const text = formatSubagentCompletionText({
      status: 'timeout',
      iterations: 10,
      toolCalls: 28,
      durationMs: 171_000,
      error: {
        kind: 'budget_timeout',
        message: 'Budget exceeded: timeout (limit=60000, observed=111082)',
      },
    });
    expect(text).toBe('timed out · 10 iter · 28 tools · 2m 51s');
    expect(text).not.toContain('Budget exceeded');
    expect(text).not.toContain('budget_timeout');
    expect(text).not.toContain('limit=');
  });

  it('labels other budget kinds cleanly', () => {
    expect(
      formatSubagentCompletionText({
        status: 'failed',
        iterations: 5,
        toolCalls: 40,
        durationMs: 30_000,
        error: {
          kind: 'budget_tool_calls',
          message: 'Budget exceeded: tool_calls (limit=20, observed=21)',
        },
      }),
    ).toBe('hit tool-call budget · 5 iter · 40 tools · 30s');
  });

  it('keeps a short unknown failure message', () => {
    expect(
      formatSubagentCompletionText({
        status: 'failed',
        iterations: 1,
        toolCalls: 0,
        durationMs: 800,
        error: { kind: 'provider_auth', message: 'Invalid API key for provider X' },
      }),
    ).toBe('failed · 1 iter · 0 tools · 0.8s — Invalid API key for provider X');
  });
});

describe('formatDelegateStartedText', () => {
  it('returns a short task preview (no "delegating" filler)', () => {
    const text = formatDelegateStartedText(
      'Review only the current on-disk changes in packages/cli/src/renderer.ts, packages/cli/src/execution…',
    );
    expect(text).not.toMatch(/delegating/i);
    expect(text.length).toBeLessThanOrEqual(56);
    expect(text.startsWith('Review only')).toBe(true);
  });
});

describe('formatDelegateSuccessText', () => {
  it('prefers the summary preview when present', () => {
    expect(
      formatDelegateSuccessText({
        summary: '[critic] done in 12s (3 iter, 5 tools) — LGTM with two nits',
        iterations: 3,
        toolCalls: 5,
        durationMs: 12_000,
      }),
    ).toBe('done · 3 iter · 5 tools · 12s — LGTM with two nits');
  });

  it('falls back to stats-only when there is no preview', () => {
    expect(
      formatDelegateSuccessText({
        summary: '[critic] done in 12s (3 iter, 5 tools)',
        iterations: 3,
        toolCalls: 5,
        durationMs: 12_000,
      }),
    ).toBe('done · 3 iter · 5 tools · 12s');
  });
});
