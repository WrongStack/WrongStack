import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DashboardStdout } from '../src/server/terminal-dashboard.js';
import {
  prettifyStructuredLine,
  renderSessionPanelLines,
  startTerminalDashboard,
} from '../src/server/terminal-dashboard.js';

function fakeStdout(isTTY = true): DashboardStdout & { chunks: string[] } {
  const chunks: string[] = [];
  return {
    chunks,
    isTTY,
    columns: 100,
    write(chunk: string) {
      chunks.push(chunk);
    },
  };
}

function fakeConsole() {
  return {
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function outputText(stdout: { chunks: string[] }): string {
  return stdout.chunks.join('');
}

function lastChunk(stdout: { chunks: string[] }): string {
  return stdout.chunks.at(-1) ?? '';
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('startTerminalDashboard', () => {
  it('leaves non-TTY console output untouched', () => {
    const stdout = fakeStdout(false);
    const target = fakeConsole();
    const originalLog = target.log;

    const dashboard = startTerminalDashboard({ stdout, consoleTarget: target });

    expect(dashboard.enabled).toBe(false);
    target.log('kept by the normal sink');
    expect(originalLog).toHaveBeenCalledWith('kept by the normal sink');
    expect(stdout.chunks).toEqual([]);
    dashboard.stop();
  });

  it('leaves the console untouched when verbose is requested', () => {
    const stdout = fakeStdout(true);
    const target = fakeConsole();
    const originals = { ...target };

    const dashboard = startTerminalDashboard({ stdout, consoleTarget: target, verbose: true });

    expect(dashboard.enabled).toBe(false);
    expect(target).toEqual(originals);
    dashboard.stop();
  });

  it('wraps the console and prefixes forwarded lines with a timestamp and level', () => {
    const stdout = fakeStdout();
    const target = fakeConsole();
    const originalWarn = target.warn;

    const dashboard = startTerminalDashboard({ stdout, consoleTarget: target });
    expect(dashboard.enabled).toBe(true);

    target.warn('provider auto-discovery failed');

    expect(originalWarn).not.toHaveBeenCalled();
    const text = outputText(stdout);
    expect(text).toContain('WARN');
    expect(text).toContain('provider auto-discovery failed');
    dashboard.stop();
    expect(target.warn).toBe(originalWarn);
  });

  it('draws the session panel in place and skips identical redraws', () => {
    const stdout = fakeStdout();
    const target = fakeConsole();

    const dashboard = startTerminalDashboard({
      stdout,
      consoleTarget: target,
      getUrl: () => 'http://127.0.0.1:3456?token=operator-token',
      now: () => 10_000,
    });

    const rows = [
      {
        id: 'sess_abc12345',
        provider: 'anthropic',
        model: 'claude-3-5-sonnet',
        isRunning: true,
        iteration: { index: 2, max: 10 },
        runningSubagents: 1,
        totalSubagents: 3,
        runningSince: 4_000,
        agents: [
          {
            id: 'leader',
            label: 'leader',
            provider: 'anthropic',
            model: 'claude-3-5-sonnet',
            status: 'running',
            iteration: { index: 2, max: 10 },
            toolCalls: 4,
            startedAt: 4_000,
          },
          {
            id: 'sub_a',
            label: 'reviewer',
            provider: 'openai',
            model: 'gpt-5.3-codex',
            status: 'running',
            iteration: { index: 1 },
            toolCalls: 2,
            startedAt: 6_000,
          },
        ],
      },
      {
        id: 'sess_def45678',
        provider: 'zai',
        model: 'glm-5.3',
        isRunning: false,
        runningSubagents: 0,
        totalSubagents: 0,
      },
    ];
    dashboard.setSessions(rows);

    const text = outputText(stdout);
    expect(text).toContain('WebUI');
    expect(text).toContain('http://127.0.0.1:3456?token=operator-token');
    expect(text).toContain('1/2 running');
    expect(text).toContain('RUNNING');
    expect(text).toContain('IDLE');
    expect(text).toContain('iter 2/10');
    expect(text).toContain('sub 1/3');
    expect(text).toContain('leader:leader');
    expect(text).toContain('reviewer:sub_a');
    expect(text).toContain('tools 4');

    const writesAfterFirstDraw = stdout.chunks.length;
    dashboard.setSessions(rows);
    expect(stdout.chunks.length).toBe(writesAfterFirstDraw);
    dashboard.stop();
  });

  it('erases the panel before a log line and redraws it below', () => {
    const stdout = fakeStdout();
    const target = fakeConsole();

    const dashboard = startTerminalDashboard({
      stdout,
      consoleTarget: target,
      now: () => 10_000,
    });

    dashboard.setSessions([
      {
        id: 'sess_abc12345',
        provider: 'anthropic',
        model: 'claude-3-5-sonnet',
        isRunning: true,
        runningSubagents: 0,
        totalSubagents: 0,
      },
    ]);
    const heightLine = stdout.chunks.findIndex((c) => c.includes('\x1b['));
    expect(heightLine).toBeGreaterThanOrEqual(0);

    target.log('a fresh log line');
    const text = outputText(stdout);
    // Clear escape: move up + clear-to-end, then the log, then the panel again.
    expect(text).toContain('\x1b[0J');
    expect(text.indexOf('a fresh log line')).toBeGreaterThan(heightLine);
    expect(text.lastIndexOf('RUNNING')).toBeGreaterThan(text.indexOf('a fresh log line'));
    dashboard.stop();
  });

  it('keeps only the newest visible log lines in the dashboard frame', () => {
    const stdout = fakeStdout();
    const target = fakeConsole();

    const dashboard = startTerminalDashboard({
      stdout,
      consoleTarget: target,
      maxLogRows: 2,
      now: () => 10_000,
    });

    dashboard.setSessions([
      {
        id: 'sess_abc12345',
        provider: 'anthropic',
        model: 'claude-3-5-sonnet',
        isRunning: true,
        runningSubagents: 0,
        totalSubagents: 0,
      },
    ]);

    target.log('first visible log');
    target.log('second visible log');
    target.log('third visible log');

    const frame = lastChunk(stdout);
    expect(frame).not.toContain('first visible log');
    expect(frame).toContain('second visible log');
    expect(frame).toContain('third visible log');
    expect(frame).toContain('RUNNING');
    dashboard.stop();
  });

  it('mutes info chatter in quiet mode while warn/error still flow', () => {
    const stdout = fakeStdout();
    const target = fakeConsole();
    const originalLog = target.log;
    const originalWarn = target.warn;

    const dashboard = startTerminalDashboard({ stdout, consoleTarget: target, quiet: true });

    target.log('[WebUI] Tool registry loaded');
    target.info('[WebUI] Session created');
    target.warn('provider auto-discovery failed');

    // Chatter is muted; the warning flows through the coordinated stream,
    // never through the raw console method.
    expect(originalLog).not.toHaveBeenCalled();
    expect(originalWarn).not.toHaveBeenCalled();
    const text = outputText(stdout);
    expect(text).not.toContain('Tool registry loaded');
    expect(text).toContain('WARN');
    expect(text).toContain('provider auto-discovery failed');
    expect(dashboard.mutedCount).toBe(2);
    expect(dashboard.recent()).toEqual(['[WebUI] Tool registry loaded', '[WebUI] Session created']);
    dashboard.stop();
  });

  it('bounds the muted ring buffer while still counting every dropped line', () => {
    const stdout = fakeStdout();
    const target = fakeConsole();

    const dashboard = startTerminalDashboard({
      stdout,
      consoleTarget: target,
      quiet: true,
      bufferLines: 2,
    });

    target.log('one');
    target.log('two');
    target.log('three');

    expect(dashboard.mutedCount).toBe(3);
    expect(dashboard.recent()).toEqual(['two', 'three']);
    dashboard.stop();
  });

  it('collapses a repeated warning into a single trailing notice', () => {
    const stdout = fakeStdout();
    const target = fakeConsole();
    const originalWarn = target.warn;

    const dashboard = startTerminalDashboard({ stdout, consoleTarget: target });

    target.warn('watcher restart failed');
    target.warn('watcher restart failed');
    target.warn('watcher restart failed');
    // Only the first occurrence reaches the stream; the streak is pending.
    expect(outputText(stdout).match(/watcher restart failed/g)?.length).toBe(1);

    target.warn('a different problem');
    expect(outputText(stdout)).toContain('previous line repeated 2×');
    expect(originalWarn).not.toHaveBeenCalled();
    dashboard.stop();
  });

  it('flushes a pending repeat notice on stop and restores every wrapped method', () => {
    const stdout = fakeStdout();
    const target = fakeConsole();
    const originals = { ...target };

    const dashboard = startTerminalDashboard({ stdout, consoleTarget: target });
    target.error('the same failure');
    target.error('the same failure');
    dashboard.stop();

    expect(target).toEqual(originals);
    // The flushed notice goes through the ORIGINAL console, not the panel stream.
    expect(originals.log).toHaveBeenCalledWith('  ↑ previous line repeated 1×');

    // Idempotent: a second stop neither re-flushes nor re-wraps.
    dashboard.stop();
    expect(originals.log).toHaveBeenCalledTimes(1);
  });

  it('renders structured JSON lines as readable single lines', () => {
    const stdout = fakeStdout();
    const target = fakeConsole();

    const dashboard = startTerminalDashboard({ stdout, consoleTarget: target });

    target.warn(
      JSON.stringify({
        level: 'warn',
        event: 'webui.port_reassigned',
        message: 'bind-time EADDRINUSE retry',
        requested: 3456,
        sessionId: 'sess_abcdef12',
        timestamp: '2026-08-29T10:00:00.000Z',
      }),
    );

    const text = outputText(stdout);
    expect(text).toContain('webui.port_reassigned');
    expect(text).toContain('bind-time EADDRINUSE retry');
    expect(text).toContain('requested=3456');
    expect(text).toContain('sess:sess_abc');
    expect(text).not.toContain('{"level"');
    // The record is stamped exactly once — no ts/level echo from the body.
    expect(text.match(/WARN /g)?.length).toBe(1);
    dashboard.stop();
  });
});

describe('renderSessionPanelLines', () => {
  const baseRow = {
    runningSubagents: 0,
    totalSubagents: 0,
  };

  it('shows header counts, session rows and the +N overflow line', () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({
      id: `sess_${String(i).padStart(8, '0')}`,
      provider: 'p',
      model: 'm',
      isRunning: i < 2,
      ...baseRow,
    }));

    const lines = renderSessionPanelLines(rows, { title: 'WebUI', maxRows: 3, now: 1_000 });

    expect(lines[0]).toContain('2/8 running');
    expect(lines).toHaveLength(5); // header + 3 rows + overflow
    expect(lines[4]).toContain('+5 more sessions');
  });

  it('prints the FULL session id on every row', () => {
    // This panel is how a user connects a tab in the browser to a journal on
    // disk — for `--resume`, for `/rewind`, for finding the JSONL. It used to
    // print eight characters, which is not something you can resume with.
    const rows = [
      {
        id: 'sess_01M0TK9K2VYES2B6CSVM0XHHNB',
        provider: 'anthropic',
        model: 'opus',
        isRunning: false,
        ...baseRow,
      },
      {
        id: 'sess_01M0SGN4R8AJZ7J2BPFQXC2JXF',
        provider: 'anthropic',
        model: 'opus',
        isRunning: true,
        ...baseRow,
      },
    ];

    const lines = renderSessionPanelLines(rows, { title: 'WebUI', width: 200, now: 1_000 });

    expect(lines[1]).toContain('sess_01M0TK9K2VYES2B6CSVM0XHHNB');
    expect(lines[2]).toContain('sess_01M0SGN4R8AJZ7J2BPFQXC2JXF');
  });

  it('shows an empty-state line when no sessions are open', () => {
    const lines = renderSessionPanelLines([], { title: 'WebUI', now: 1_000 });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('WebUI');
    expect(lines[1]).toBe('  no open sessions');
  });

  it('formats elapsed time, iteration and subagent columns for running rows', () => {
    const lines = renderSessionPanelLines(
      [
        {
          id: 'sess_abc12345',
          provider: 'anthropic',
          model: 'claude-3-5-sonnet',
          isRunning: true,
          iteration: { index: 3 },
          runningSubagents: 2,
          totalSubagents: 5,
          runningSince: 40_000,
        },
      ],
      { title: 'WebUI', now: 154_000 },
    );

    expect(lines[1]).toContain('sess_abc');
    expect(lines[1]).toContain('anthropic/claude-3-5-sonnet');
    expect(lines[1]).toContain('RUNNING');
    expect(lines[1]).toContain('1m54s');
    expect(lines[1]).toContain('iter 3');
    expect(lines[1]).toContain('sub 2/5');
  });

  it('renders a session tree with leader and subagent table rows', () => {
    const lines = renderSessionPanelLines(
      [
        {
          id: 'sess_abc12345',
          provider: 'anthropic',
          model: 'claude-3-5-sonnet',
          isRunning: true,
          iteration: { index: 3, max: 9 },
          runningSubagents: 1,
          totalSubagents: 1,
          runningSince: 40_000,
          agents: [
            {
              id: 'leader',
              label: 'leader',
              provider: 'anthropic',
              model: 'claude-3-5-sonnet',
              status: 'running',
              iteration: { index: 3, max: 9 },
              toolCalls: 7,
              startedAt: 40_000,
            },
            {
              id: 'sub_reviewer',
              label: 'reviewer',
              provider: 'openai',
              model: 'gpt-5.3-codex',
              status: 'success',
              iteration: { index: 2 },
              toolCalls: 5,
              durationMs: 30_000,
            },
          ],
        },
      ],
      { title: 'WebUI', now: 154_000 },
    );

    expect(lines[1]).toContain('`-- sess_abc');
    expect(lines[2]).toContain('|-- leader:leader');
    expect(lines[2]).toContain('iter 3/9');
    expect(lines[2]).toContain('tools 7');
    expect(lines[3]).toContain('`-- reviewer:sub_revi');
    expect(lines[3]).toContain('openai/gpt-5.3-codex');
    expect(lines[3]).toContain('tools 5');
    expect(lines[3]).toContain('30s');
  });

  it('truncates rows to the terminal width', () => {
    const lines = renderSessionPanelLines(
      [
        {
          id: 'sess_abc12345',
          provider: 'anthropic',
          model: 'claude-3-5-sonnet-with-a-really-long-name-that-keeps-going',
          isRunning: true,
          runningSubagents: 0,
          totalSubagents: 0,
          runningSince: 0,
        },
      ],
      { title: 'WebUI', width: 60, now: 1_000 },
    );

    for (const line of lines) expect(line.length).toBeLessThanOrEqual(60);
  });
});

describe('prettifyStructuredLine', () => {
  it('returns null for non-JSON or non-structured lines', () => {
    expect(prettifyStructuredLine('[WebUI] plain progress', false)).toBeNull();
    expect(prettifyStructuredLine('{not json', false)).toBeNull();
    expect(prettifyStructuredLine(JSON.stringify([1, 2]), false)).toBeNull();
    expect(prettifyStructuredLine(JSON.stringify({ message: 'no level' }), false)).toBeNull();
  });

  it('splits the record level from the rendered body', () => {
    const line = prettifyStructuredLine(
      JSON.stringify({
        level: 'error',
        event: 'webui_server.error',
        message: 'port busy',
        timestamp: '2026-08-29T12:34:56.000Z',
      }),
      false,
    );
    expect(line).toEqual({ level: 'error', text: 'webui_server.error port busy' });
  });

  it('keeps scalar extras as key=value pairs', () => {
    const line = prettifyStructuredLine(
      JSON.stringify({ level: 'warn', message: 'slow', durationMs: 1200, ok: false }),
      false,
    );
    expect(line?.level).toBe('warn');
    expect(line?.text).toContain('durationMs=1200');
    expect(line?.text).toContain('ok=false');
  });
});
