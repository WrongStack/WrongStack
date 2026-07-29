import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { StatusBar, type StatusBarProps } from '../src/components/status-bar.js';
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

  it('renders the current process RSS and V8 heap usage', () => {
    const frame = frameOf({
      processMemory: {
        ts: '2026-07-18T00:00:00.000Z',
        rss: 1.5 * 1024 ** 3,
        heapUsed: 768 * 1024 ** 2,
        heapTotal: 1024 ** 3,
        external: 0,
        heapLimit: 4 * 1024 ** 3,
        load: 0.1875,
      },
    });

    expect(frame).toContain('RAM 1.5G');
    expect(frame).toContain('heap 768M');
  });

  it('shows total SAGE records and the active-in-context summary', () => {
    // With no memory-context monitor prop the active count falls back to
    // Sage.activeInContext so the rail still surfaces it.
    const frame = frameOf({
      Sage: { total: 6261, activeInContext: 3 },
      hiddenItems: ['state'],
    });

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
          contextPressure: 0.70,
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

  it('places live provider/model before context and project/workdir on line 2', () => {
    const frame = frameOf({
      provider: 'openai',
      model: 'gpt-5.6',
      projectName: 'WrongStack',
      workingDir: 'packages/tui',
      context: { used: 25_000, max: 100_000 },
      hiddenItems: ['state'],
    });
    const [line1 = '', line2 = ''] = frame.split('\n');

    expect(line1).toMatch(/openai\/gpt-5\.6.*▶.*\[00o/);
    expect(line2).toMatch(/▣ WrongStack.*▶.*⌁ packages\/tui/);
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

  it('line 1: separates the autonomy chip from subsequent runtime chips', () => {
    // Autonomy stays on line 1 with provider/model and state, while project
    // starts line 2. Both rails should keep their internal separators.
    const frame = frameOf({
      autonomy: 'auto',
      projectName: 'proj',
      hiddenItems: ['elapsed'],
      startedAt: undefined,
    });
    expect(frame).toContain('∞ AUTO');
    expect(frame).toContain('▣ proj');
    const [line1 = '', line2 = ''] = frame.split('\n');
    expect(line1).toMatch(/AUTO.*▶.*anthropic\/claude.*▶.*● idle/);
    expect(line2).toMatch(/^◖ ▣ proj/);
  });

  it('line 2: separates the task chip from the fleet chip without todos/plan present', () => {
    // On the combined secondary line, tasks and fleet chips appear with
    // Powerline transitions between all adjacent chips.
    const frame = frameOf({
      tasks: { pending: 1, inProgress: 0, completed: 0, blocked: 0, failed: 0 },
      fleet: { running: 1, idle: 0, pending: 0, completed: 0 },
    });
    // Both task and fleet glyphs appear on the same line with separators
    expect(frame).toContain('◆');
    expect(frame).toContain('◈');
    expect(frame).toMatch(/◆.*▶.*◈/);
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
    expect(line).toMatch(/^◖ todos/);
  });

  it('inserts a Powerline transition between every pair of visible chips on line 1', () => {
    const frame = frameOf({
      yolo: true,
      autonomy: 'eternal',
    });
    // YOLO is first on line 1, followed by autonomy, then state/idle, then model.
    // Every adjacent pair should have a Powerline transition.
    const line1 = frame.split('\n').find((l) => l.includes('YOLO')) ?? '';
    expect(line1).toMatch(/YOLO.*▶.*∞ ETERNAL/);
    expect(line1).toMatch(/∞ ETERNAL.*▶.*●/);
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

  it('renders mailbox when a peer surface is online even with no unread mail', () => {
    const frame = frameOf({
      mailbox: {
        unread: 0,
        onlineAgents: 1,
        onlineClients: { tui: 1, webui: 1, repl: 0 },
      },
    });

    // The mailbox chip sits on line 3 (active work + connectivity). Mailbox
    // is the only chip on line 3 here, so it should render without overflow.
    expect(frame).toContain('✉');
    expect(frame).toContain('0');
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
