import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolStatsModal } from '../../src/components/ToolStatsModal.js';
import {
  LEADER_AGENT_KEY,
  type ToolStatsSession,
  useHistoryStore,
  useToolStatsStore,
  useUIStore,
} from '../../src/stores/index.js';

describe('ToolStatsModal', () => {
  beforeEach(() => {
    useToolStatsStore.setState({ sessions: {} });
    useUIStore.setState({ sessionNicknames: {} });
    useHistoryStore.setState({ entries: [] });
  });

  afterEach(cleanup);

  it('renders nothing when open is false', () => {
    const { container } = render(<ToolStatsModal open={false} onClose={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders empty state when there are no live sessions or history entries', () => {
    render(<ToolStatsModal open={true} onClose={() => {}} />);

    expect(screen.getByTestId('tool-stats-modal')).toBeTruthy();
    expect(screen.getByRole('heading', { name: /Tool call statistics/i })).toBeTruthy();
    expect(screen.getByText(/No tool calls recorded yet on this page/i)).toBeTruthy();
  });

  it('calls onClose when clicking close button or pressing Escape', () => {
    const onClose = vi.fn();
    render(<ToolStatsModal open={true} onClose={onClose} />);

    // Click close button
    const closeBtn = screen.getByTitle(/Close/i);
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);

    // Escape key
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);

    // Click backdrop
    const modalBackdrop = screen.getByTestId('tool-stats-modal');
    fireEvent.click(modalBackdrop);
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('does not call onClose when clicking modal content', () => {
    const onClose = vi.fn();
    render(<ToolStatsModal open={true} onClose={onClose} />);

    const section = screen.getByRole('region', { name: /Tool call statistics/i });
    fireEvent.click(section);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('renders live session stats, tool rows, ratio bars, and agent-to-agent delegation details', () => {
    const session1: ToolStatsSession = {
      sessionId: 'sess-12345678-abcd',
      firstActivityAt: Date.now() - 60000,
      lastActivityAt: Date.now(),
      perTool: {
        bash: { started: 10, ok: 8, failed: 2, totalMs: 5000 },
        read: { started: 5, ok: 5, failed: 0, totalMs: 250 },
        mcp__git__custom_status: { started: 2, ok: 1, failed: 1, totalMs: 1500 },
      },
      perAgent: {
        [LEADER_AGENT_KEY]: { started: 12, ok: 10, failed: 2, totalMs: 5250 },
        coder: { started: 5, ok: 4, failed: 1, totalMs: 1500 },
      },
      delegations: {
        started: 3,
        ok: 2,
        failed: 1,
        totalMs: 3000,
        toolCalls: 6,
      },
    };

    useToolStatsStore.setState({
      sessions: {
        [session1.sessionId]: session1,
      },
    });
    useUIStore.setState({
      sessionNicknames: {
        [session1.sessionId]: 'Feature Work',
      },
    });

    render(<ToolStatsModal open={true} onClose={() => {}} />);

    // Aggregate chips
    // Total started = perAgent sum: 12 + 5 = 17
    // ok = 14, failed = 3, totalMs = 6750
    expect(screen.getByText('17')).toBeTruthy();
    expect(screen.getByText('14')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.getByText('Feature Work')).toBeTruthy();

    // Standard tool display names
    expect(screen.getByText('Shell command')).toBeTruthy();
    expect(screen.getByText('Read file')).toBeTruthy();
    // Custom tool display name formatted
    expect(screen.getByText('Git · Custom Status')).toBeTruthy();

    // Agent to agent section
    expect(screen.getByText('Agent-to-agent')).toBeTruthy();
    expect(screen.getByText('coder')).toBeTruthy();
    expect(screen.getByText(/3 delegated run\(s\)/i)).toBeTruthy();
    expect(screen.getByText(/1 failed/i)).toBeTruthy();
    expect(screen.getByText(/6 tools inside/i)).toBeTruthy();
    expect(screen.getByText(/Leader: 10✓ 2✗/i)).toBeTruthy();
  });

  it('renders past sessions from history store that are not in live sessions', () => {
    useHistoryStore.setState({
      entries: [
        {
          id: 'past-sess-1',
          title: 'Refactor Auth',
          toolCallCount: 15,
          toolErrorCount: 3,
        },
        {
          id: 'past-sess-2-no-title-long-id',
          toolCallCount: 8,
          toolErrorCount: 0,
        },
        {
          id: 'past-sess-zero-tools',
          title: 'Empty session',
          toolCallCount: 0,
        },
      ] as any,
    });

    render(<ToolStatsModal open={true} onClose={() => {}} />);

    expect(screen.getByText(/Earlier sessions/i)).toBeTruthy();
    expect(screen.getByText('Refactor Auth')).toBeTruthy();
    expect(screen.getByText('past-ses')).toBeTruthy(); // slice(0, 8)
    // Zero tools session should be filtered out
    expect(screen.queryByText('Empty session')).toBeNull();
  });
});
