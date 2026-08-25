import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { StatusBar, type StatusBarProps } from '../src/components/status-bar.js';
import type { StatusBarClickMap } from '../src/components/status-bar-types.js';
import { displayWidth } from '../src/terminal-width.js';

// Strip ANSI so we assert on the plain glyphs the user actually sees.
function strip(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

function frameOf(props: Partial<StatusBarProps>): string {
  const { lastFrame, unmount } = render(
    React.createElement(StatusBar, {
      model: 'anthropic/claude',
      state: 'idle',
      ...props,
    } as StatusBarProps),
  );
  const out = strip(lastFrame() ?? '');
  unmount();
  return out;
}

/**
 * Regression tests for the segmented Powerline rail. The old
 * code recomputed "did any earlier chip render?" inline per chip by OR-ing every
 * preceding condition; those chains drifted and dropped separators in real
 * combinations. These tests pin the corrected behavior.
 */
describe('StatusBar chip separators', () => {
  it('shows the detached codebase-index server connection and PID while idle', () => {
    const frame = frameOf({
      indexState: {
        ready: true,
        indexing: false,
        currentFile: 0,
        totalFiles: 0,
        server: { status: 'connected', connected: true, pid: 4242 },
      },
    });

    expect(frame).toContain('index connected #4242');
  });

  it('shows heartbeat health and latency for the index server', () => {
    const frame = frameOf({
      indexState: {
        ready: true,
        indexing: false,
        currentFile: 0,
        totalFiles: 0,
        server: {
          status: 'connected',
          connected: true,
          pid: 4242,
          health: {
            status: 'healthy',
            checkedAt: 1,
            lastHealthyAt: 1,
            latencyMs: 7,
            missedHeartbeats: 0,
          },
        },
      },
    });

    expect(frame).toContain('index healthy #4242 · 7ms');
  });

  it('surfaces an unresponsive index server and missed heartbeat count', () => {
    const frame = frameOf({
      indexState: {
        ready: true,
        indexing: false,
        currentFile: 0,
        totalFiles: 0,
        server: {
          status: 'unresponsive',
          connected: true,
          pid: 4242,
          health: {
            status: 'unresponsive',
            checkedAt: 1,
            lastHealthyAt: 1,
            latencyMs: null,
            missedHeartbeats: 3,
          },
        },
      },
    });

    expect(frame).toContain('index unresponsive · missed 3');
  });

  it('distinguishes a disconnected index client from a connected server', () => {
    const frame = frameOf({
      indexState: {
        ready: true,
        indexing: false,
        currentFile: 0,
        totalFiles: 0,
        server: { status: 'offline', connected: false },
      },
    });

    expect(frame).toContain('index disconnected');
    expect(frame).not.toContain('index connected');
  });

  it('keeps the server connection visible while indexing', () => {
    const frame = frameOf({
      indexState: {
        ready: false,
        indexing: true,
        currentFile: 12,
        totalFiles: 40,
        server: { status: 'connected', connected: true, pid: 4242 },
      },
    });

    expect(frame).toContain('indexing 12/40 · connected #4242');
  });

  it('places index-server status on the final memory/service line instead of line 1', () => {
    const frame = frameOf({
      Sage: { total: 6261, activeInContext: 3 },
      indexState: {
        ready: true,
        indexing: false,
        currentFile: 0,
        totalFiles: 0,
        server: { status: 'connected', connected: true, pid: 4242 },
      },
    });
    const lines = frame.split('\n');

    expect(lines[0]).not.toContain('index connected');
    expect(lines.at(-1)).toContain('6261 total');
    expect(lines.at(-1)).toContain('index connected #4242');
  });

  it('shows total SAGE records and the active-in-context summary', () => {
    // With no memory-context monitor prop the active count falls back to
    // Sage.activeInContext so the rail still surfaces it.
    const frame = frameOf({
      Sage: { total: 6261, activeInContext: 3 },
      hiddenItems: ['state'],
    });

    expect(frame).toContain('✦ Memory');
    expect(frame).toContain('6261 total');
    expect(frame).toContain('3 actv');
  });

  it('hides SAGE counts when the statusline item is disabled', () => {
    const frame = frameOf({
      Sage: { total: 6261, activeInContext: 3 },
      hiddenItems: ['memory_context'],
    });

    expect(frame).not.toContain('6261 total');
    expect(frame).not.toContain('3 actv');
  });

  it('renders injector pipeline counters when memoryContextMonitor has live data', () => {
    const frame = frameOf({
      Sage: { total: 6261, activeInContext: 3 },
      memoryContextMonitor: {
        memories: {},
        transitions: [],
        latest: {
          at: '2026-07-29T00:00:00.000Z',
          trigger: 'read',
          matched: 12,
          injected: 9,
          filtered: 4,
          contextPressure: 0.42,
          injectedChars: 5678,
        },
      },
    });

    expect(frame).toContain('12 matched');
    expect(frame).toContain('9 inj');
    expect(frame).toContain('4 filt');
    expect(frame).toContain('42% ctx');
  });

  it('renders context-pressure traffic light at warn threshold', () => {
    const frame = frameOf({
      Sage: { total: 100, activeInContext: 1 },
      memoryContextMonitor: {
        memories: {},
        transitions: [],
        latest: {
          at: '2026-07-29T00:00:00.000Z',
          trigger: 'read',
          matched: 5,
          injected: 3,
          filtered: 2,
          contextPressure: 0.7,
          injectedChars: 1000,
        },
      },
    });

    expect(frame).toContain('70% ctx');
  });

  it('hides pipeline counters when all counts are zero (idle session)', () => {
    const frame = frameOf({
      Sage: { total: 100, activeInContext: 0 },
      memoryContextMonitor: {
        memories: {},
        transitions: [],
        latest: {
          at: '2026-07-29T00:00:00.000Z',
          trigger: 'read',
          matched: 0,
          injected: 0,
          filtered: 0,
          contextPressure: 0,
          injectedChars: 0,
        },
      },
    });

    expect(frame).not.toContain('matched');
    expect(frame).not.toContain('inj');
    expect(frame).not.toContain('filt');
    expect(frame).not.toContain('ctx');
  });

  it('hides pipeline counters when injector outcome was error', () => {
    const frame = frameOf({
      Sage: { total: 100, activeInContext: 0 },
      memoryContextMonitor: {
        memories: {},
        transitions: [],
        latest: {
          at: '2026-07-29T00:00:00.000Z',
          trigger: 'read',
          matched: 12,
          injected: 0,
          filtered: 0,
          contextPressure: 0.5,
          injectedChars: 0,
          outcome: 'error',
          error: 'injector crashed',
        },
      },
    });

    expect(frame).not.toContain('12 matched');
    expect(frame).not.toContain('50% ctx');
  });

  it('places workspace identity on line 1 and provider/model after git', () => {
    const frame = frameOf({
      provider: 'openai',
      model: 'gpt-5.6',
      projectName: 'WrongStack',
      workingDir: 'packages/tui',
      context: { used: 25_000, max: 100_000 },
      hiddenItems: ['state'],
    });
    const [line1 = '', line2 = ''] = frame.split('\n');

    // Line 1 is now the workspace & identity rail: project → workdir → git →
    // provider/model. Line 2 carries the run-state rail with the context meter.
    expect(line1).toMatch(/▣ WrongStack.*⌁ packages\/tui.*openai\/gpt-5\.6/);
    expect(line2).toMatch(/\[00o/);
  });

  it('updates the rendered provider/model when current state changes', () => {
    const view = render(
      React.createElement(StatusBar, {
        provider: 'anthropic',
        model: 'claude-sonnet',
        state: 'idle',
        projectName: 'WrongStack',
        hiddenItems: ['state'],
      } as StatusBarProps),
    );
    expect(strip(view.lastFrame() ?? '')).toContain('anthropic/claude-sonnet');

    view.rerender(
      React.createElement(StatusBar, {
        provider: 'openai',
        model: 'gpt-5.6',
        state: 'idle',
        projectName: 'WrongStack',
        hiddenItems: ['state'],
      } as StatusBarProps),
    );
    const frame = strip(view.lastFrame() ?? '');
    expect(frame).toContain('openai/gpt-5.6');
    expect(frame).not.toContain('anthropic/claude-sonnet');
    view.unmount();
  });

  it('line 2: separates the run-state chips (state, yolo, autonomy)', () => {
    // Autonomy moved to the run-state rail (line 2) with state and yolo,
    // while project leads the workspace rail (line 1).
    const frame = frameOf({
      autonomy: 'auto',
      projectName: 'proj',
      hiddenItems: ['elapsed'],
      startedAt: undefined,
    });
    expect(frame).toContain('∞ AUTO');
    expect(frame).toContain('▣ proj');
    const [line1 = '', line2 = ''] = frame.split('\n');
    expect(line1).toMatch(/^▣ proj.*anthropic\/claude/);
    expect(line2).toMatch(/● idle.*AUTO/);
  });

  it('separates the task chip (line 3) from the fleet chip (line 4)', () => {
    // Tasks live on the active-work rail; fleet moved to the connectivity
    // rail below it. Each keeps its internal separators.
    const frame = frameOf({
      tasks: { pending: 1, inProgress: 0, completed: 0, blocked: 0, failed: 0 },
      fleet: { running: 1, idle: 0, pending: 0, completed: 0 },
    });
    const lines = frame.split('\n');
    const taskLine = lines.find((l) => l.includes('◆')) ?? '';
    const fleetLine = lines.find((l) => l.includes('◈')) ?? '';
    expect(taskLine).toBeTruthy();
    expect(fleetLine).toBeTruthy();
    expect(lines.indexOf(taskLine)).toBeLessThan(lines.indexOf(fleetLine));
  });

  it('renders todos on the active-work line (line 3)', () => {
    const frame = frameOf({
      todos: { pending: 2, inProgress: 1, completed: 0 },
    });
    // The todos chip now appears on line 3 (active work), not the secondary
    // line. Find the line that contains todos.
    const line = frame.split('\n').find((l) => l.includes('todos')) ?? '';
    expect(line).toContain('todos');
    // On line 3, todos is the first chip, so there is no transition before it.
    expect(line).toMatch(/^todos/);
  });

  it('renders the run-state band in order: state, YOLO, autonomy', () => {
    const frame = frameOf({
      yolo: true,
      autonomy: 'eternal',
    });
    // Line 2 is the run-state rail: state first, then the permission band
    // (yolo, autonomy), with separators between all adjacent chips.
    const line2 = frame.split('\n').find((l) => l.includes('YOLO')) ?? '';
    expect(line2).toMatch(/● idle.*! YOLO.*∞ ETERNAL/);
  });

  it('hides mailbox line content when mailbox is disabled', () => {
    const frame = frameOf({
      mailbox: {
        unread: 2,
        onlineAgents: 3,
        onlineClients: { tui: 1, webui: 1, repl: 0 },
        lastSubject: 'handoff',
        lastFrom: 'worker',
      },
      hiddenItems: ['mailbox'],
    });

    expect(frame).not.toContain('✉');
    expect(frame).not.toContain('handoff');
  });

  it('does not render an idle mailbox chip for the current TUI alone', () => {
    const frame = frameOf({
      mailbox: {
        unread: 0,
        onlineAgents: 1,
        onlineClients: { tui: 1, webui: 0, repl: 0 },
      },
    });

    expect(frame).not.toContain('✉');
    expect(frame).not.toContain('👥');
  });

  it('publishes fleet click spans on physical line 3 when work is active', () => {
    // Fleet + todos both present: work rail renders (physical line 2,
    // click-map line 2) and connectivity renders below it (physical line 3,
    // click-map line 3). The fleet span id must sit on line 3.
    const clickMapRef: { current: StatusBarClickMap | null } = { current: null };
    const { lastFrame, unmount } = render(
      React.createElement(StatusBar, {
        model: 'anthropic/claude',
        state: 'idle',
        todos: { pending: 2, inProgress: 1, completed: 0 },
        fleet: { running: 1, idle: 0, pending: 0, completed: 0 },
        clickMapRef,
      } as StatusBarProps),
    );
    expect(lastFrame()).toBeTruthy();
    const fleetLines = clickMapRef.current?.lines.filter((l) =>
      l.spans.some((s) => s.id === 'fleet'),
    );
    expect(fleetLines?.map((l) => l.line)).toEqual([3]);
    unmount();
  });

  it('publishes fleet click spans on physical line 2 when no work rail renders', () => {
    // Fleet WITHOUT todos/plan/tasks/goal: hasWorkActivity is false so the
    // work rail is gated off and connectivity physically renders as the
    // third row (line index 2). The click-map must track that — a stale
    // fixed line 3 would make every fleet-chip click miss.
    const clickMapRef: { current: StatusBarClickMap | null } = { current: null };
    const { lastFrame, unmount } = render(
      React.createElement(StatusBar, {
        model: 'anthropic/claude',
        state: 'idle',
        fleet: { running: 1, idle: 0, pending: 0, completed: 0 },
        clickMapRef,
      } as StatusBarProps),
    );
    expect(lastFrame()).toBeTruthy();
    const fleetLines = clickMapRef.current?.lines.filter((l) =>
      l.spans.some((s) => s.id === 'fleet'),
    );
    expect(fleetLines?.map((l) => l.line)).toEqual([2]);
    unmount();
  });

  it('renders mailbox when a peer surface is online even with no unread mail', () => {
    const frame = frameOf({
      mailbox: {
        unread: 0,
        onlineAgents: 1,
        onlineClients: { tui: 1, webui: 1, repl: 0 },
      },
    });

    // The mailbox chip sits on line 4 (fleet, connectivity & background
    // services). Mailbox is the only chip on line 4 here, so it should render
    // without overflow.
    expect(frame).toContain('✉ 0');
  });

  it('right-anchors the index-server chip so its column stays put while memory counters grow', () => {
    // Find the right-edge column of "index connected #4242" on the last
    // line under two different memory-detail widths, and assert the column
    // is identical — that's the regression check for the statusline
    // jitter that previously moved the index chip every heartbeat as
    // matched/injected/filtered counts and "ctx N%" updated.
    const narrow = frameOf({
      Sage: { total: 6261, activeInContext: 3 },
      indexState: {
        ready: true,
        indexing: false,
        currentFile: 0,
        totalFiles: 0,
        server: { status: 'connected', connected: true, pid: 4242 },
      },
    });
    const wide = frameOf({
      Sage: { total: 6261, activeInContext: 3 },
      memoryContextMonitor: {
        memories: {},
        transitions: [],
        latest: {
          at: '2026-07-28T00:00:00.000Z',
          matched: 12,
          injected: 9,
          filtered: 4,
          trigger: 'auth-refactor-bug',
          contextPressure: 0.5,
          injectedChars: 12345,
        },
      },
      indexState: {
        ready: true,
        indexing: false,
        currentFile: 0,
        totalFiles: 0,
        server: { status: 'connected', connected: true, pid: 4242 },
      },
    });

    const lastLineOf = (f: string) => f.split('\n').at(-1) ?? '';
    const endColumn = (line: string, needle: string) => {
      const idx = line.indexOf(needle);
      if (idx < 0) return -1;
      // Use display-width to match Ink's column accounting.
      let col = 0;
      for (let i = 0; i < idx; i++) col += displayWidth(line.charAt(i));
      col += displayWidth(needle);
      return col;
    };

    // The index chip is the rightmost content on the last line in both
    // cases. Asserting its trailing column is identical is the proof
    // that the right-anchored geometry holds the chip steady regardless
    // of how wide the memory counters grow.
    expect(endColumn(lastLineOf(narrow), 'index connected #4242')).toBeGreaterThan(0);
    expect(endColumn(lastLineOf(wide), 'index connected #4242')).toBe(
      endColumn(lastLineOf(narrow), 'index connected #4242'),
    );
  });
});
