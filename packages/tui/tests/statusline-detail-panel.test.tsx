import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { StatusBarProps } from '../src/components/status-bar.js';
import { StatuslineDetailPanel } from '../src/components/statusline-detail-panel.js';

function renderPanel(overrides: Partial<StatusBarProps> = {}) {
  return render(
    React.createElement(StatuslineDetailPanel, {
      model: 'gpt-test',
      state: 'idle',
      onClose: vi.fn(),
      ...overrides,
    }),
  );
}

describe('StatuslineDetailPanel', () => {
  it('renders honest placeholders for the minimal idle state', () => {
    const view = renderPanel();
    const frame = view.lastFrame() ?? '';

    expect(frame).toContain('STATUS DETAIL');
    expect(frame).toContain('gpt-test');
    expect(frame).toContain('idle');
    expect(frame).toContain('SESSION');
    expect(frame).toContain('WORK');
    view.unmount();
  });

  it('renders runtime, work, connectivity, and service details', () => {
    const view = renderPanel({
      version: '1.2.3',
      state: 'running',
      thinkingWord: 'Analyzing',
      startedAt: Date.now() - 5_000,
      context: { used: 1_500, max: 2_000 },
      queueCount: 2,
      processCount: 3,
      hint: 'Keep going',
      sessionId: 'session-123456789',
      projectName: 'WrongStack',
      workingDir: 'packages/tui',
      yolo: true,
      autonomy: 'eternal',
      git: { branch: 'main', added: 1, deleted: 0, untracked: 1 },
      sessionCount: 2,
      toolCount: 7,
      tokenSavingMode: 'balanced',
      autoProceedCountdown: 4,
      nextStepsAutoSubmitCountdown: 3,
      nextStepsAutoSubmitLabel: 'Run focused tests',
      todos: { pending: 2, inProgress: 1, completed: 3 },
      plan: { open: 2, inProgress: 1, done: 4, scope: 'project' },
      tasks: {
        pending: 3,
        inProgress: 2,
        completed: 4,
        blocked: 1,
        failed: 1,
        scope: 'session',
      },
      fleet: { running: 2, pending: 1, idle: 1, completed: 3 },
      goalSummary: { goal: 'Cover every non-web source', goalState: 'active', iterations: 2 },
      enhanceCountdown: 6,
      sideEffectCount: 2,
      debugStreamStats: { chunkCount: 4, lastChunkSize: 128, lastDeltaMs: 9 },
      mailbox: {
        unread: 1,
        onlineAgents: 2,
        onlineClients: { tui: 1, webui: 0, repl: 1 },
        lastFrom: 'agent-1',
        lastSubject: 'Coverage update',
      },
      brain: { state: 'deciding' },
      indexState: {
        ready: true,
        indexing: false,
        currentFile: 10,
        totalFiles: 10,
        server: {
          status: 'connected',
          connected: true,
          pid: 42,
          health: {
            status: 'healthy',
            latencyMs: 3,
            missedHeartbeats: 0,
            server: {
              memory: { rss: 1024, heapUsed: 512, heapTotal: 2048 },
              uptimeMs: 10_000,
              clients: 2,
              activeRequests: 1,
              activeWrites: 1,
              queuedWrites: 0,
              pendingExternalFiles: 0,
              watchingExternal: true,
              watchingClients: 2,
              oldestClientIdleMs: 500,
              clientLeaseTimeoutMs: 30_000,
            },
          },
        },
      },
    } as unknown as Partial<StatusBarProps>);
    const frame = view.lastFrame() ?? '';

    for (const text of [
      'WS v1.2.3',
      'Analyzing…',
      '75%',
      'WrongStack',
      'Fleet agents',
      'Cover every non-web source',
      'CONNECTIVITY',
      'Coverage update',
      'BRAIN',
      'Index server',
      'healthy',
      'Server process',
      'Client lease',
    ]) {
      expect(frame).toContain(text);
    }
    view.unmount();
  });

  it('shows the fleet activity label while the leader is idle', () => {
    const view = renderPanel({
      fleet: { running: 3, pending: 0, idle: 0, completed: 0 },
    });
    expect(view.lastFrame() ?? '').toContain('agents ▶3');
    view.unmount();
  });
});
