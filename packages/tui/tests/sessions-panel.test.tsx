import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { SessionsPanel, type LiveSessionEntry } from '../src/components/sessions-panel.js';

function session(overrides: Partial<LiveSessionEntry> = {}): LiveSessionEntry {
  return {
    sessionId: '2026-07-19/sess_abc123',
    projectName: 'wrongstack',
    projectSlug: 'wrongstack',
    workingDir: '/tmp/project',
    status: 'active',
    pid: 12345,
    startedAt: new Date().toISOString(),
    agentCount: 2,
    agents: [
      {
        id: 'a1',
        name: 'Leader',
        status: 'running',
        iterations: 5,
        toolCalls: 12,
        lastActivityAt: new Date().toISOString(),
      },
    ],
    ...overrides,
  };
}

describe('SessionsPanel', () => {
  it('renders the header', () => {
    const view = render(
      React.createElement(SessionsPanel, {
        sessions: [session()],
        busy: false,
        selected: 0,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('SESSIONS');
    view.unmount();
  });

  it('shows active session count', () => {
    const view = render(
      React.createElement(SessionsPanel, {
        sessions: [session({ status: 'active' })],
        busy: false,
        selected: 0,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('●');
    expect(frame).toContain('1 active');
    view.unmount();
  });

  it('shows syncing indicator when busy', () => {
    const view = render(
      React.createElement(SessionsPanel, {
        sessions: [session()],
        busy: true,
        selected: 0,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('syncing');
    view.unmount();
  });

  it('shows loading state when busy and empty', () => {
    const view = render(
      React.createElement(SessionsPanel, {
        sessions: [],
        busy: true,
        selected: 0,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('Loading sessions');
    view.unmount();
  });

  it('shows empty state when no sessions and not busy', () => {
    const view = render(
      React.createElement(SessionsPanel, {
        sessions: [],
        busy: false,
        selected: 0,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('No live sessions');
    view.unmount();
  });

  it('renders session rows with project info', () => {
    const view = render(
      React.createElement(SessionsPanel, {
        sessions: [session({ projectName: 'my-project' })],
        busy: false,
        selected: 0,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('my-project');
    view.unmount();
  });

  it('shows current session with ● marker', () => {
    const view = render(
      React.createElement(SessionsPanel, {
        sessions: [session()],
        busy: false,
        selected: 0,
        currentSessionId: '2026-07-19/sess_abc123',
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('●');
    view.unmount();
  });

  it('shows different status icons', () => {
    const statuses = ['active', 'idle', 'closing', 'stale', 'unknown'];
    for (const s of statuses) {
      const view = render(
        React.createElement(SessionsPanel, {
          sessions: [session({ status: s })],
          busy: false,
          selected: 0,
        }),
      );
      expect(view.lastFrame()?.length).toBeGreaterThan(0);
      view.unmount();
    }
  });

  it('shows git branch when present', () => {
    const view = render(
      React.createElement(SessionsPanel, {
        sessions: [session({ gitBranch: 'feature/test' })],
        busy: false,
        selected: 0,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('feature/test');
    view.unmount();
  });

  it('shows agent list for selected session', () => {
    const view = render(
      React.createElement(SessionsPanel, {
        sessions: [
          session({
            agents: [
              {
                id: 'a1',
                name: 'Worker',
                status: 'running',
                iterations: 3,
                toolCalls: 7,
                lastActivityAt: new Date().toISOString(),
              },
            ],
          }),
        ],
        busy: false,
        selected: 0,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('Worker');
    expect(frame).toContain('3 iter');
    expect(frame).toContain('7 tools');
    view.unmount();
  });

  it('shows resume confirm prompt', () => {
    const view = render(
      React.createElement(SessionsPanel, {
        sessions: [session()],
        busy: false,
        selected: 0,
        resumeConfirm: { sessionName: 'session-abc' },
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('Replace this conversation');
    expect(frame).toContain('session-abc');
    view.unmount();
  });

  it('shows agent with current tool', () => {
    const view = render(
      React.createElement(SessionsPanel, {
        sessions: [
          session({
            agents: [
              {
                id: 'a1',
                name: 'Agent',
                status: 'running',
                currentTool: 'grep',
                iterations: 1,
                toolCalls: 2,
                lastActivityAt: new Date().toISOString(),
              },
            ],
          }),
        ],
        busy: false,
        selected: 0,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('grep');
    view.unmount();
  });

  it('shows scroll indicators when many sessions', () => {
    const many = Array.from({ length: 15 }, (_, i) =>
      session({ sessionId: `sess-${i}`, projectName: `proj-${i}` }),
    );
    const view = render(
      React.createElement(SessionsPanel, {
        sessions: many,
        busy: false,
        selected: 10,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('↑');
    view.unmount();
  });
});
