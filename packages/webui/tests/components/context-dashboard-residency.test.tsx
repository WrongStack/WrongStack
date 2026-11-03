import { cleanup, render, screen } from '@testing-library/react';
import type { HistoryRetention, RequestResidency } from '@wrongstack/core/utils/residency-labels';
import { afterEach, describe, expect, it } from 'vitest';
import { ResidencySection } from '../../src/components/context-dashboard-residency.js';
import '../../src/i18n';

afterEach(cleanup);

const residency: RequestResidency = {
  seq: 3,
  at: 1_000,
  providerId: 'anthropic',
  model: 'claude-opus-5-5',
  mechanism: 'explicit',
  segments: [
    { kind: 'tools', tokens: 3_000, lane: 'cached', count: 20 },
    { kind: 'system', tokens: 5_000, lane: 'cached', count: 2 },
    { kind: 'history-new', tokens: 2_000, lane: 'written', count: 2 },
    {
      kind: 'live-tail',
      tokens: 1_000,
      lane: 'uncached',
      count: 2,
      parts: [{ source: 'memory-evidence', tokens: 900 }],
    },
  ],
  lanes: { cached: 8_000, written: 2_000, uncached: 1_000 },
  total: 11_000,
  expectedCacheRatio: 8 / 11,
  actual: { input: 900, cacheRead: 7_900, cacheWrite: 2_100, total: 10_900, cacheRatio: 0.72 },
  verdict: 'partial',
  breakers: [{ kind: 'history', detail: 'history rewritten from message 4' }],
  next: { rewritten: false, pendingMessages: 1, pendingTokens: 300 },
};

const retention: HistoryRetention = {
  preserveK: 6,
  eliseThreshold: 1_200,
  preserveStart: 4,
  classes: {
    protected: { messages: 6, tokens: 4_000 },
    'elision-candidate': { messages: 1, tokens: 3_000 },
    compactable: { messages: 3, tokens: 1_000 },
    elided: { messages: 0, tokens: 0 },
    digest: { messages: 1, tokens: 200 },
  },
  total: 8_200,
};

describe('ResidencySection', () => {
  it('renders segments with their cache lane, verdict, breaker and retention classes', () => {
    render(<ResidencySection residency={residency} retention={retention} />);
    expect(screen.getByText('Cache Residency')).toBeTruthy();
    expect(screen.getByText('System prompt (stable)')).toBeTruthy();
    expect(screen.getByText('Live context · this request')).toBeTruthy();
    expect(screen.getByText(/memory-evidence/)).toBeTruthy();
    expect(screen.getByText(/Partial — less was read from cache/)).toBeTruthy();
    expect(screen.getByText(/History rewritten/)).toBeTruthy();
    expect(screen.getByText(/history rewritten from message 4/)).toBeTruthy();
    expect(screen.getByText('Elision candidates')).toBeTruthy();
    expect(screen.queryByText('Already elided')).toBeNull();
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain('cached 73%');
  });

  it('shows the empty state before the first request', () => {
    render(<ResidencySection residency={undefined} retention={undefined} />);
    expect(screen.getByText(/No request sent yet/)).toBeTruthy();
  });
});
