/**
 * F3 at real terminal sizes. The panel used to overflow its own frame at
 * common sizes (the shell then clipped it behind an "Alt+PgUp/Dn scroll" bar,
 * hiding the newest transcript rows), wrap its dashboard and roster rows
 * mid-word, and drop a failed agent from view before its reason could be read.
 */
import { describe, expect, it } from 'vitest';
import type { FleetEntry } from '../src/app.js';
import { AgentsMonitor } from '../src/components/agents-monitor.js';
import { MonitorViewportProvider } from '../src/components/monitor-shell.js';
import { renderRealTty, settle } from './helpers/real-tty.js';

const NOW = 1_800_000_000_000;

function agent(over: Partial<FleetEntry> & Pick<FleetEntry, 'id' | 'status'>): FleetEntry {
  return {
    name: over.id,
    streamingText: '',
    iterations: 1,
    toolCalls: 3,
    recentTools: [],
    recentMessages: [],
    cost: 0.01,
    startedAt: NOW - 120_000,
    lastEventAt: NOW - 1_000,
    ...over,
  };
}

const FLEET: Record<string, FleetEntry> = {
  leader: agent({
    id: 'leader',
    name: 'LEADER',
    status: 'running',
    provider: 'anthropic',
    model: 'claude-opus-5-5',
    ctxPct: 0.4,
    ctxTokens: 80_000,
    ctxMaxTokens: 200_000,
  }),
  worker: agent({
    id: 'worker',
    name: 'claude-code',
    status: 'running',
    provider: 'acp',
    task: 'refactor the ACP session so a prompt turn is timed by silence, then run the tests',
    currentTool: { name: 'bun test packages/acp', startedAt: NOW - 40_000 },
    recentTools: [
      { name: 'mcp__wrongstack-index__codebase_search', ok: true, durationMs: 300, at: NOW - 9e4 },
      { name: 'git push --force', ok: false, durationMs: 5, at: NOW - 6e4 },
    ],
  }),
  researcher: agent({
    id: 'researcher',
    status: 'running',
    provider: 'openai',
    model: 'gpt-5.5',
    ctxPct: 0.78,
    budgetWarning: { kind: 'tool_calls', used: 540, limit: 600, at: NOW - 3_000 },
  }),
  reviewer: agent({
    id: 'reviewer',
    status: 'failed',
    endedAt: NOW - 20_000,
    task: 'review the permission bridge diff',
    failureReason: 'reviewer: usage quota spent — resets 3pm',
  }),
};

function show(columns: number, rows: number, fullscreen = false) {
  return renderRealTty(
    <MonitorViewportProvider value={{ columns, rows }}>
      <AgentsMonitor
        entries={FLEET}
        totalCost={0.28}
        leaderCost={0.41}
        totalTokens={{ input: 412_000, output: 38_000 }}
        nowTick={NOW}
        transcripts={{ getTranscript: () => [] }}
        leaderTranscript={() => []}
        fullscreen={fullscreen}
      />
    </MonitorViewportProvider>,
    { columns, rows },
  );
}

describe('F3 layout at real terminal sizes', () => {
  it.each([
    [160, 50, false],
    [120, 40, false],
    [100, 30, false],
    [90, 24, false],
    [80, 20, false],
    [100, 30, true],
    [80, 24, true],
  ])('fits %ix%i (fullscreen %s) without clipping or wrapping', async (columns, rows, full) => {
    const view = show(columns, rows, full);
    try {
      await settle(60);
      const frame = view.lastFrame();
      const lines = frame.split('\n');
      expect(frame).not.toContain('Alt+PgUp/Dn scroll');
      expect(lines.length).toBeLessThanOrEqual(rows);
      // One-line rows stay one line: the dashboard and each roster row.
      expect(lines.some((l) => l.includes('ctx 78%') && l.includes('total'))).toBe(true);
      expect(lines.some((l) => l.includes('researcher') && /\d\d:\d\d/.test(l))).toBe(true);
      // A finished agent stays listed, under its own heading.
      expect(frame).toContain('finished');
      expect(lines.some((l) => l.includes('✗') && l.includes('reviewer'))).toBe(true);
    } finally {
      view.unmount();
    }
  });

  it('shows what a worker was asked and why a finished one failed', async () => {
    const view = show(110, 32);
    try {
      await settle(60);
      view.stdin.write('\u001B[B');
      await settle(40);
      let frame = view.lastFrame();
      expect(frame).toContain('ACP subagent');
      expect(frame).toContain('task refactor the ACP session');
      expect(frame).not.toContain('ctx unknown');
      for (let i = 0; i < 2; i++) {
        view.stdin.write('\u001B[B');
        await settle(40);
      }
      frame = view.lastFrame();
      expect(frame).toContain('✗ reviewer: usage quota spent — resets 3pm');
      expect(frame).toContain('took 01:40');
    } finally {
      view.unmount();
    }
  });
});
