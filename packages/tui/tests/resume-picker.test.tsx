import { describe, expect, it } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { ResumePicker } from '../src/components/resume-picker.js';
import type { ResumeSessionEntry } from '../src/app.js';

describe('ResumePicker', () => {
  const sampleSessions: ResumeSessionEntry[] = [
    {
      id: 'sess_01J',
      startedAt: '2026-07-19T10:30:00.000Z',
      title: 'Working on the TUI coverage task',
      tokenTotal: 150000,
      toolCallCount: 24,
      iterationCount: 5,
      toolErrorCount: 0,
      outcome: 'completed',
      isCurrent: false,
    },
    {
      id: 'sess_02K',
      startedAt: '2026-07-18T08:15:00.000Z',
      title: 'Fixed the fleet panel bug',
      tokenTotal: 85000,
      toolCallCount: 12,
      iterationCount: 3,
      toolErrorCount: 2,
      outcome: 'aborted',
      isCurrent: false,
    },
    {
      id: 'sess_03L',
      startedAt: '2026-07-17T14:00:00.000Z',
      title: 'Experimenting with new architecture',
      tokenTotal: 320000,
      toolCallCount: 48,
      iterationCount: 10,
      toolErrorCount: 1,
      outcome: 'error',
      isCurrent: false,
    },
  ];

  it('renders the header', () => {
    const { lastFrame, unmount } = render(
      React.createElement(ResumePicker, {
        sessions: sampleSessions,
        selected: 0,
        busy: false,
      } as never),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Resume Session');
    unmount();
  });

  it('shows navigation hints when not busy', () => {
    const { lastFrame, unmount } = render(
      React.createElement(ResumePicker, {
        sessions: sampleSessions,
        selected: 0,
        busy: false,
      } as never),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('↑/↓ navigate');
    expect(frame).toContain('Enter select');
    unmount();
  });

  it('shows busy message when resuming', () => {
    const { lastFrame, unmount } = render(
      React.createElement(ResumePicker, {
        sessions: sampleSessions,
        selected: 0,
        busy: true,
      } as never),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Resuming selected session');
    unmount();
  });

  it('shows empty state when no sessions', () => {
    const { lastFrame, unmount } = render(
      React.createElement(ResumePicker, {
        sessions: [],
        selected: 0,
        busy: false,
      } as never),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('No sessions found.');
    unmount();
  });

  it('does not show empty state when busy with no sessions', () => {
    const { lastFrame, unmount } = render(
      React.createElement(ResumePicker, {
        sessions: [],
        selected: 0,
        busy: true,
      } as never),
    );
    const frame = lastFrame() ?? '';
    // Should show busy message instead of "No sessions found."
    expect(frame).toContain('Resuming selected session');
    unmount();
  });

  it('renders all session entries with ids and dates', () => {
    const { lastFrame, unmount } = render(
      React.createElement(ResumePicker, {
        sessions: sampleSessions,
        selected: 0,
        busy: false,
      } as never),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('sess_01J');
    expect(frame).toContain('sess_02K');
    expect(frame).toContain('sess_03L');
    unmount();
  });

  it('shows outcome badge for completed sessions', () => {
    const { lastFrame, unmount } = render(
      React.createElement(ResumePicker, {
        sessions: [sampleSessions[0]],
        selected: 0,
        busy: false,
      } as never),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('✓');
    unmount();
  });

  it('shows outcome badge for aborted sessions', () => {
    const { lastFrame, unmount } = render(
      React.createElement(ResumePicker, {
        sessions: [sampleSessions[1]],
        selected: 0,
        busy: false,
      } as never),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('⚠');
    unmount();
  });

  it('shows outcome badge for error sessions', () => {
    const { lastFrame, unmount } = render(
      React.createElement(ResumePicker, {
        sessions: [sampleSessions[2]],
        selected: 0,
        busy: false,
      } as never),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('✗');
    unmount();
  });

  it('shows outcome badge for timeout sessions', () => {
    const timeoutSession: ResumeSessionEntry = {
      id: 'sess_04M',
      startedAt: '2026-07-16T12:00:00.000Z',
      title: 'Timed out run',
      tokenTotal: 50000,
      toolCallCount: 0,
      iterationCount: 0,
      toolErrorCount: 0,
      outcome: 'timeout',
      isCurrent: false,
    };
    const { lastFrame, unmount } = render(
      React.createElement(ResumePicker, {
        sessions: [timeoutSession],
        selected: 0,
        busy: false,
      } as never),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('⏱');
    unmount();
  });

  it('shows token count with tool and iteration counts', () => {
    const { lastFrame, unmount } = render(
      React.createElement(ResumePicker, {
        sessions: [sampleSessions[0]],
        selected: 0,
        busy: false,
      } as never),
    );
    const frame = lastFrame() ?? '';
    // Token count uses toLocaleString() which is locale-dependent
    expect(frame).toContain('000 tok');
    expect(frame).toContain('tok');
    expect(frame).toContain('24 tools');
    expect(frame).toContain('5 iters');
    unmount();
  });

  it('shows error count when tool errors present', () => {
    const { lastFrame, unmount } = render(
      React.createElement(ResumePicker, {
        sessions: [sampleSessions[1]],
        selected: 0,
        busy: false,
      } as never),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('2 err');
    unmount();
  });

  it('truncates long titles', () => {
    const longTitleSession: ResumeSessionEntry = {
      id: 'sess_long',
      startedAt: '2026-07-19T10:00:00.000Z',
      title: 'A very long session title that should be truncated because it exceeds seventy two characters and then some more',
      tokenTotal: 1000,
      toolCallCount: 0,
      iterationCount: 0,
      toolErrorCount: 0,
      outcome: 'completed',
      isCurrent: false,
    };
    const { lastFrame, unmount } = render(
      React.createElement(ResumePicker, {
        sessions: [longTitleSession],
        selected: 0,
        busy: false,
      } as never),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('…');
    unmount();
  });

  it('shows current session marker', () => {
    const currentSession: ResumeSessionEntry = {
      ...sampleSessions[0]!,
      isCurrent: true,
    };
    const { lastFrame, unmount } = render(
      React.createElement(ResumePicker, {
        sessions: [currentSession],
        selected: 0,
        busy: false,
      } as never),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('(current)');
    unmount();
  });

  it('renders error text when provided', () => {
    const { lastFrame, unmount } = render(
      React.createElement(ResumePicker, {
        sessions: [],
        selected: 0,
        busy: false,
        error: 'Failed to load sessions',
      } as never),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Failed to load sessions');
    unmount();
  });

  it('renders hint text when provided', () => {
    const { lastFrame, unmount } = render(
      React.createElement(ResumePicker, {
        sessions: sampleSessions,
        selected: 0,
        busy: false,
        hint: 'Only showing last 10 sessions',
      } as never),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Only showing last 10 sessions');
    unmount();
  });

  it('handles session with no tool calls', () => {
    const noToolSession: ResumeSessionEntry = {
      id: 'sess_notool',
      startedAt: '2026-07-19T09:00:00.000Z',
      title: 'No tools used',
      tokenTotal: 500,
      toolCallCount: 0,
      iterationCount: 0,
      toolErrorCount: 0,
      outcome: 'completed',
      isCurrent: false,
    };
    const { lastFrame, unmount } = render(
      React.createElement(ResumePicker, {
        sessions: [noToolSession],
        selected: 0,
        busy: false,
      } as never),
    );
    const frame = lastFrame() ?? '';
    // Should show token count without tool/iter counts
    expect(frame).toContain('500 tok');
    unmount();
  });

  it('handles unknown outcome gracefully', () => {
    const unknownSession: ResumeSessionEntry = {
      id: 'sess_unk',
      startedAt: '2026-07-19T08:00:00.000Z',
      title: 'Unknown outcome',
      tokenTotal: 100,
      toolCallCount: 0,
      iterationCount: 0,
      toolErrorCount: 0,
      outcome: 'unknown' as any,
      isCurrent: false,
    };
    const { lastFrame, unmount } = render(
      React.createElement(ResumePicker, {
        sessions: [unknownSession],
        selected: 0,
        busy: false,
      } as never),
    );
    const frame = lastFrame() ?? '';
    // Unknown outcome gets two spaces as badge (the else branch)
    expect(frame).toContain('100 tok');
    unmount();
  });
});

describe('ResumePicker — sessions open elsewhere', () => {
  function entry(over: Partial<ResumeSessionEntry> = {}): ResumeSessionEntry {
    return {
      id: 'sess_live',
      startedAt: '2026-08-30T09:00:00.000Z',
      title: 'Being written right now',
      tokenTotal: 1000,
      toolCallCount: 1,
      iterationCount: 1,
      toolErrorCount: 0,
      isCurrent: false,
      ...over,
    };
  }

  it('labels a session another process is writing, with its surface and pid', () => {
    // Without this the row is indistinguishable from history, and Enter on it
    // wiped the screen and read a multi-hundred-MB journal before the host's
    // reservation refused.
    const { lastFrame, unmount } = render(
      React.createElement(ResumePicker, {
        sessions: [entry({ live: { pid: 4242, clientType: 'webui' } })],
        selected: 0,
        busy: false,
      } as never),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('open in webui');
    expect(frame).toContain('4242');
    unmount();
  });

  it('falls back to a generic owner when the registry row has no clientType', () => {
    const { lastFrame, unmount } = render(
      React.createElement(ResumePicker, {
        sessions: [entry({ live: { pid: 7 } })],
        selected: 0,
        busy: false,
      } as never),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('another wstack');
    expect(frame).not.toContain('undefined');
    unmount();
  });

  it('leaves a closed session unlabelled', () => {
    const { lastFrame, unmount } = render(
      React.createElement(ResumePicker, {
        sessions: [entry()],
        selected: 0,
        busy: false,
      } as never),
    );
    expect(lastFrame() ?? '').not.toContain('open in');
    unmount();
  });

  it('shows the position and total so a windowed list reads as scrollable', () => {
    // Three rows per session means most of a long list is off-screen; without
    // a count, 200 sessions look exactly like the page of 20 this picker used
    // to be handed.
    const sessions = Array.from({ length: 40 }, (_unused, i) =>
      entry({ id: `sess_${i}`, title: `session ${i}` }),
    );
    const { lastFrame, unmount } = render(
      React.createElement(ResumePicker, { sessions, selected: 3, busy: false } as never),
    );
    expect(lastFrame() ?? '').toContain('4/40');
    unmount();
  });
});
