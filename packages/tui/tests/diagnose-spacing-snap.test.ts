import { render } from 'ink-testing-library';
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import type { TokenCounter } from '@wrongstack/core/types';
import { StatusBar, type StatusBarProps } from '../src/components/status-bar.js';
import { displayWidth, stripAnsi } from '../src/terminal-width.js';

const mockTokenCounter: TokenCounter = {
  total: () => ({ input: 2_571, output: 847 }),
  currentRequestTokens: () => ({ input: 2_571, cacheRead: 0, cacheWrite: 0 }),
  estimateCost: () => ({ input: 0.01, output: 0.0134, total: 0.0234, currency: 'USD' as const }),
  cacheStats: () => ({ hitRatio: 0.68, readTokens: 0, writeTokens: 0, savedUsd: 0 }),
  account: vi.fn(),
  setSessionId: vi.fn(),
  reset: vi.fn(),
  setCurrentRequestTokens: vi.fn(),
};

describe('spacing diagnose', () => {
  it('shows chip spacing and icon-text spacing on all 4 lines', () => {
    const { lastFrame, unmount } = render(
      React.createElement(StatusBar, {
        model: 'gpt-5.6',
        provider: 'openai',
        state: 'idle',
        projectName: 'WrongStack',
        workingDir: 'packages/tui',
        processCount: 3,
        processMemory: { ts: new Date().toISOString(), rss: 734_003_200, heapUsed: 536_870_912, heapTotal: 805_306_368, external: 0, heapLimit: 0, load: 0.45 },
        cpuPercent: 42,
        context: { used: 45_000, max: 100_000 },
        tokenCounter: mockTokenCounter,
        todos: { pending: 2, inProgress: 1, completed: 5 },
        fleet: { running: 2, idle: 1, pending: 0, completed: 3 },
        mailbox: {
          unread: 3,
          onlineAgents: 2,
          onlineClients: { tui: 1, webui: 1, repl: 0 },
          lastSubject: 'hello from worker',
          lastFrom: 'worker-bot',
        },
        indexState: {
          ready: true, indexing: false, currentFile: 0, totalFiles: 0,
          server: { status: 'connected', connected: true, pid: 4242 },
        },
        Sage: { total: 6261, activeInContext: 3 },
        memoryContextMonitor: {
          memories: {}, transitions: [],
          latest: {
            at: '2026-07-28T00:00:00.000Z', matched: 12, injected: 9, filtered: 4,
            trigger: 'test', contextPressure: 0.5, injectedChars: 12345,
          },
        },
        sessionCount: 2,
        toolCount: 14,
        sideEffectCount: 3,
        subagentCount: 2,
        mode: 'detailed',
      } as StatusBarProps),
    );
    const frame = stripAnsi(lastFrame() ?? '');
    const lines = frame.split('\n');
    console.log('=== STATUSLINE RENDER ===');
    lines.forEach((l, i) => console.log(`Line ${i+1}:`, JSON.stringify(l), `(${displayWidth(l)} cols)`));
    console.log('=== END ===');
    unmount();
    expect(frame).toBeTruthy();
    expect(frame.length).toBeGreaterThan(10);
  });
});
