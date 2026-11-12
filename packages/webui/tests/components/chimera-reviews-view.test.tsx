import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
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
import { i18n } from '../../src/i18n';
import { useChimeraHubStore } from '../../src/stores/chimera-hub-store';

describe('ChimeraReviewsView', () => {
  // Pin the language before rendering: the component renders t()-derived
  // labels, and an unpinned translator can race initialization into raw keys.
  beforeEach(async () => {
    await i18n.changeLanguage('en');
  });
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

  // The store has always published `error` and `detailLoading`, and this view
  // destructured both and rendered neither: a failed `chimera.reports` fetch
  // left the operator looking at "No review reports match your filter." with
  // no hint that anything had gone wrong.
  it('surfaces a fetch error instead of an empty-filter message', () => {
    // The mount effect kicks off `fetchReports`, which clears `error` — so the
    // failure has to land after render, exactly as it does at runtime.
    render(<ChimeraReviewsView />);
    act(() => {
      useChimeraHubStore.setState({
        reports: [],
        error: 'chimera hub unreachable: ECONNREFUSED',
        loading: false,
      });
    });

    expect(screen.getByText('chimera hub unreachable: ECONNREFUSED')).not.toBeNull();
  });

  it('does not show the error banner while a fetch is still in flight', () => {
    render(<ChimeraReviewsView />);
    act(() => {
      useChimeraHubStore.setState({
        reports: [],
        error: 'stale error from the previous fetch',
        loading: true,
      });
    });

    expect(screen.queryByText('stale error from the previous fetch')).toBeNull();
  });

  it('shows a detail spinner rather than the "select a report" empty state', () => {
    useChimeraHubStore.setState({
      selectedReportId: 'rep-uuid-1',
      detail: null,
      detailLoading: true,
      error: null,
    });

    render(<ChimeraReviewsView />);

    expect(screen.getByText('Loading report details…')).not.toBeNull();
    expect(screen.queryByText('Select a Chimera Review Report')).toBeNull();
  });

  it('renders token telemetry, prompt cache hit rate, scope manifest, and collapsible skipped files', () => {
    useChimeraHubStore.setState({
      reports: [
        {
          reportId: 'rep-telemetry-1',
          sessionId: 'session-alpha',
          reviewedAt: '2026-08-28T10:00:00Z',
          reviewerModel: 'claude-sonnet-4-6',
          source: 'chimera',
          reviewStatus: 'success',
          lifecycleStatus: 'open',
          counts: { critical: 0, high: 0, medium: 0, low: 0 },
          totalFindings: 0,
          headSha: 'abc123459999',
          skippedFileCount: 1,
          usage: {
            inputTokens: 1000,
            outputTokens: 200,
            cacheReadTokens: 1000,
            totalTokens: 1200,
            costUsd: 0.0035,
            iterations: 2,
            toolCalls: 3,
            durationMs: 4200,
            attemptsUsed: 1,
          },
        },
      ],
      selectedReportId: 'rep-telemetry-1',
      detail: {
        report: {
          id: 'rep-telemetry-1',
          reviewedAt: '2026-08-28T10:00:00Z',
          sessionId: 'session-alpha',
          agentId: 'chimera-review',
          reviewerModel: 'claude-sonnet-4-6',
          source: 'chimera',
          reviewStatus: 'success',
          lifecycle: 'open',
          files: [{ path: 'packages/core/src/index.ts', status: 'modified' }],
          counts: { critical: 0, high: 0, medium: 0, low: 0 },
          totalFindings: 0,
          unparseableCount: 0,
          rawText: '## 🦂 Chimera Review — all clear ✅',
          usage: {
            inputTokens: 1000,
            outputTokens: 200,
            cacheReadTokens: 1000,
            totalTokens: 1200,
            costUsd: 0.0035,
            iterations: 2,
            toolCalls: 3,
            durationMs: 4200,
            attemptsUsed: 1,
          },
          scopeManifest: {
            headSha: 'abc12345',
            isIncremental: true,
            files: [
              {
                path: 'packages/core/src/index.ts',
                status: 'modified',
                addedLines: 6,
                removedLines: 2,
                isIncrementalDelta: true,
                changedSymbols: ['initCore'],
                pairedTestPath: 'packages/core/tests/index.test.ts',
                pairedTestUpdated: false,
              },
            ],
            deletedFiles: ['packages/core/src/oldHelper.ts'],
            deletedFileReferences: [
              {
                deletedPath: 'packages/core/src/oldHelper.ts',
                referencedBy: ['packages/core/src/index.ts'],
              },
            ],
            signatureCallers: [
              {
                symbol: 'initCore',
                file: 'packages/core/src/index.ts',
                callers: ['packages/cli/src/main.ts:12'],
              },
            ],
            sessionIntent: ['Migrate core init without changing public signature'],
            skippedFiles: [{ path: 'bun.lock', reason: 'ignored_non_source' }],
          },
        },
        findings: [],
        events: [],
        scopeDrift: {
          stale: true,
          checkedCount: 1,
          modifiedPaths: ['packages/core/src/index.ts'],
          missingPaths: [],
        },
      },
    });

    render(<ChimeraReviewsView />);

    expect(screen.getByText('Token & Execution Telemetry')).not.toBeNull();
    expect(screen.getByText(/Σ 1\.2k/)).not.toBeNull();
    expect(screen.getByText(/50% cache/)).not.toBeNull();
    expect(screen.getByText('(50%)')).not.toBeNull();
    expect(screen.getByText('Incremental Delta')).not.toBeNull();
    expect(screen.getByText('Stale on disk (1 changed)')).not.toBeNull();
    expect(screen.getByText(/Migrate core init without changing public signature/)).not.toBeNull();
    expect(
      screen.getByText(/packages\/core\/src\/oldHelper\.ts → packages\/core\/src\/index\.ts/),
    ).not.toBeNull();
    expect(
      screen.getByText(
        /initCore \(packages\/core\/src\/index\.ts\) → packages\/cli\/src\/main\.ts:12/,
      ),
    ).not.toBeNull();
    expect(screen.getByText('test untouched !')).not.toBeNull();
    expect(screen.getByText('[initCore]')).not.toBeNull();

    const skippedToggle = screen.getByText('Skipped / Filtered Files (1)');
    fireEvent.click(skippedToggle);
    expect(screen.getByText('bun.lock')).not.toBeNull();
    expect(screen.getByText('Filtered non-source / generated')).not.toBeNull();
  });
});
