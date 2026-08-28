import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock('@/lib/ws-client', () => ({
  getWSClient: () => ({
    isConnected: true,
    send: mockSend,
    on: () => () => {},
    sendMessage: vi.fn(),
  }),
}));

import { ChimeraReviewsView } from '../../src/components/ChimeraReviewsView';
import { useChimeraHubStore } from '../../src/stores/chimera-hub-store';

describe('ChimeraReviewsView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useChimeraHubStore.setState({
      reports: [
        {
          reportId: 'rep-uuid-1',
          sessionId: 'session-alpha',
          reviewedAt: '2026-08-28T10:00:00Z',
          reviewerModel: 'test-reviewer-model',
          source: 'chimera',
          reviewStatus: 'success',
          lifecycleStatus: 'open',
          counts: { critical: 1, high: 0, medium: 0, low: 0 },
          totalFindings: 1,
          hasActionableFindings: true,
        },
      ],
      selectedReportId: 'rep-uuid-1',
      detail: {
        report: {
          id: 'rep-uuid-1',
          reviewedAt: '2026-08-28T10:00:00Z',
          sessionId: 'session-alpha',
          agentId: 'chimera-review',
          reviewerModel: 'test-reviewer-model',
          source: 'chimera',
          reviewStatus: 'success',
          lifecycle: 'open',
          files: [{ path: 'packages/core/src/index.ts', status: 'modified' }],
          counts: { critical: 1, high: 0, medium: 0, low: 0 },
          totalFindings: 1,
          unparseableCount: 0,
          rawText: '## 🦂 Chimera Review\n\n### Critical (1)\n1. Sample finding',
          cascadeDepth: 0,
        },
        findings: [
          {
            finding: {
              id: 'find-1',
              fingerprint: 'fp-1',
              severity: 'critical',
              source: 'chimera',
              location: { file: 'packages/core/src/index.ts', line: 42 },
              title: 'Critical null check missing',
              description: 'Variable user might be null.',
              suggestedFix: 'if (!user) throw new Error();',
              createdAt: '2026-08-28T10:00:00Z',
              status: 'active',
              originReport: {
                reportId: 'rep-uuid-1',
                sessionId: 'session-alpha',
                agentId: 'chimera-review',
                reviewerModel: 'test-reviewer-model',
              },
            },
            events: [],
          },
        ],
        events: [
          {
            id: 'ev-1',
            reportId: 'rep-uuid-1',
            eventType: 'created',
            fromLifecycle: null,
            toLifecycle: 'open',
            actorId: 'chimera',
            actorKind: 'system',
            timestamp: '2026-08-28T10:00:00Z',
            reason: 'Review complete',
          },
        ],
      },
      loading: false,
      detailLoading: false,
      error: null,
      filterSessionId: '',
      filterLifecycle: '',
      searchQuery: '',
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders header, reports list, and detail pane with findings', () => {
    render(<ChimeraReviewsView />);

    expect(screen.getByText('Chimera Review Hub & Journal')).toBeTruthy();
    expect(screen.getAllByText(/rep-uuid-1/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Critical null check missing')).toBeTruthy();
    expect(screen.getByText('Activity Journal')).toBeTruthy();
  });

  it('allows adding a journal note to the selected report', () => {
    render(<ChimeraReviewsView />);

    const textarea = screen.getByPlaceholderText(/Record an observation/);
    fireEvent.change(textarea, { target: { value: 'Reviewed by security team' } });

    const submitBtn = screen.getByText('Append to Journal');
    fireEvent.click(submitBtn);

    expect(mockSend).toHaveBeenCalledWith({
      type: 'chimera.report.add_note',
      payload: {
        reportId: 'rep-uuid-1',
        note: 'Reviewed by security team',
      },
    });
  });

  it('allows resolving a finding', () => {
    render(<ChimeraReviewsView />);

    const resolveBtn = screen.getByText('Resolve (Fixed)');
    fireEvent.click(resolveBtn);

    expect(mockSend).toHaveBeenCalledWith({
      type: 'chimera.finding.transition',
      payload: {
        findingId: 'find-1',
        to: 'resolved',
        outcome: 'fixed',
        reason: 'Resolved by operator in WebUI',
      },
    });
  });

  it('allows transitioning report status to actioned or completed', () => {
    render(<ChimeraReviewsView />);

    const markActionedBtn = screen.getByText('Mark Actioned');
    fireEvent.click(markActionedBtn);

    expect(mockSend).toHaveBeenCalledWith({
      type: 'chimera.report.transition',
      payload: {
        reportId: 'rep-uuid-1',
        to: 'actioned',
        reason: 'Manual action status',
      },
    });
  });
});
