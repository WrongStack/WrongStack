import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderWaitingRoom } from '../../src/components/ProviderWaitingRoom.js';
import { useLocalPrefs } from '../../src/stores/local-prefs.js';
import { useProviderStatusStore } from '../../src/stores/provider-status-store.js';

const getProviderStatusMock = vi.fn();
const getProviderAuditHistoryMock = vi.fn();
const retryProviderModelMock = vi.fn();
const clearProviderStatusMock = vi.fn();

vi.mock('@/lib/ws-client', () => ({
  getWSClient: () => ({
    getProviderStatus: getProviderStatusMock,
    getProviderAuditHistory: getProviderAuditHistoryMock,
    retryProviderModel: retryProviderModelMock,
    clearProviderStatus: clearProviderStatusMock,
  }),
}));

describe('ProviderWaitingRoom', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useProviderStatusStore.setState({
      entries: {},
      summary: { total: 0, healthy: 0, degraded: 0, blocked: 0 },
      audit: [],
    });
    useLocalPrefs.setState({
      modelAvailabilitySchedule: [],
    });
  });

  afterEach(cleanup);

  it('renders null when there are no non-healthy entries and no active calendar rules', () => {
    // Only healthy entries
    useProviderStatusStore.setState({
      entries: {
        'openai\0gpt-4o': {
          providerId: 'openai',
          model: 'gpt-4o',
          state: 'healthy',
          reason: 'normal',
        } as any,
      },
    });

    const { container } = render(<ProviderWaitingRoom />);
    expect(container.firstChild).toBeNull();
  });

  it('renders summary bar when blocked/degraded entries exist and toggles details', () => {
    const blockedEntry = {
      providerId: 'anthropic',
      model: 'claude-3-5-sonnet',
      state: 'blocked',
      reason: 'rate_limit',
      lastErrorMessage: 'Sibling quarantine: rate limit on anthropic/claude-3-opus',
      stateExpiresAt: Date.now() + 120_000,
      totalFailures: 4,
      rateLimitHits: 2,
      consecutiveFailures: 3,
      lastErrorStatus: 429,
      lastSessionId: 'sess-abc-12345678',
      lastAgentId: 'agent-xyz-98765432',
      lastFailureAt: Date.now() - 30_000,
      recentErrors: [
        {
          kind: 'rate_limit',
          status: 429,
          message: 'Too many requests',
          timestamp: Date.now() - 30_000,
        },
      ],
    };

    const degradedEntry = {
      providerId: 'openai',
      model: 'gpt-4o',
      state: 'degraded',
      reason: 'high_latency',
      stateExpiresAt: Date.now() + 45_000,
    };

    useProviderStatusStore.setState({
      entries: {
        'anthropic\0claude-3-5-sonnet': blockedEntry as any,
        'openai\0gpt-4o': degradedEntry as any,
      },
    });

    render(<ProviderWaitingRoom />);

    // Check summary bar content: 1 blocked · 1 degraded · 0 scheduled
    expect(screen.getByText(/1 blocked · 1 degraded · 0 scheduled/i)).toBeTruthy();

    // Click details button to expand
    const toggleBtn = screen.getByRole('button', { name: /Availability/i });
    fireEvent.click(toggleBtn);

    // Refresh should have been called on expand
    expect(getProviderStatusMock).toHaveBeenCalledTimes(1);

    // Now entries should be visible
    expect(screen.getByText('anthropic/claude-3-5-sonnet')).toBeTruthy();
    expect(screen.getByText('openai/gpt-4o')).toBeTruthy();
    expect(screen.getByText(/via anthropic\/claude-3-opus/i)).toBeTruthy();

    // Select the blocked entry to see detailed stats & error history
    const entryBtn = screen.getByText('anthropic/claude-3-5-sonnet').closest('button')!;
    fireEvent.click(entryBtn);

    expect(screen.getByText(/failures: 4/i)).toBeTruthy();
    expect(screen.getByText(/rate-limits: 2/i)).toBeTruthy();
    expect(screen.getByText(/streak: 3/i)).toBeTruthy();
    expect(screen.getByText(/HTTP: 429/i)).toBeTruthy();
    expect(screen.getByText(/Error history \(1\)/i)).toBeTruthy();

    // Test retry probe button
    const retryBtn = screen.getByRole('button', { name: /probe/i });
    fireEvent.click(retryBtn);
    expect(retryProviderModelMock).toHaveBeenCalledWith('anthropic', 'claude-3-5-sonnet');

    // Select the degraded entry and test clear button
    const degradedBtn = screen.getByText('openai/gpt-4o').closest('button')!;
    fireEvent.click(degradedBtn);

    const clearBtn = screen.getByRole('button', { name: /Clear tracking/i });
    fireEvent.click(clearBtn);
    expect(clearProviderStatusMock).toHaveBeenCalledWith('openai', 'gpt-4o');
  });

  it('handles audit log expansion and renders audit items', () => {
    useProviderStatusStore.setState({
      entries: {
        'anthropic\0claude-3-5-sonnet': {
          providerId: 'anthropic',
          model: 'claude-3-5-sonnet',
          state: 'blocked',
          reason: 'rate_limit',
        } as any,
      },
      audit: [
        {
          ts: Date.now() - 10000,
          providerId: 'anthropic',
          model: 'claude-3-5-sonnet',
          from: 'healthy',
          to: 'blocked',
          reason: 'rate_limit',
          error: {
            kind: 'quota_exceeded',
            status: 429,
            sessionId: 'sess-audit-1234',
            agentId: 'agent-audit-5678',
          },
        } as any,
      ],
    });

    render(<ProviderWaitingRoom />);

    // Expand details
    const toggleBtn = screen.getByRole('button', { name: /Availability/i });
    fireEvent.click(toggleBtn);

    // Expand audit
    const auditToggle = screen.getByRole('button', { name: /block\/open events/i });
    fireEvent.click(auditToggle);

    expect(getProviderAuditHistoryMock).toHaveBeenCalledWith(20);
    expect(screen.getByText(/healthy → blocked/i)).toBeTruthy();
    expect(screen.getByText(/quota_exceeded 429/i)).toBeTruthy();
  });
});
