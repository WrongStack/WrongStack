import { describe, expect, it } from 'vitest';
import type { FleetEntry } from '../src/app.js';
import {
  EMPTY_AGENTS_CLOSE_DELAY_MS,
  IDLE_HIDE_MS,
  agentRisk,
  fmtExactTokens,
  formatAgentDetailHeader,
  formatContextRunway,
  formatRecentToolChip,
  nextEmptyAgentsCloseStartedAt,
  selectAgentDetail,
  selectLiveAgents,
  shouldCloseEmptyAgentsMonitor,
} from '../src/components/agents-monitor.js';
import { bucketActivity, sparkline } from '../src/components/fleet-monitor.js';

function entry(over: Partial<FleetEntry> & Pick<FleetEntry, 'id' | 'status'>): FleetEntry {
  const { id, status, ...rest } = over;
  return {
    id,
    name: id,
    streamingText: '',
    iterations: 0,
    toolCalls: 0,
    recentTools: [],
    recentMessages: [],
    cost: 0,
    startedAt: 0,
    lastEventAt: 0,
    ...rest,
    status,
  } as FleetEntry;
}

describe('selectLiveAgents', () => {
  const now = 1_000_000;

  it('shows only running subagents while keeping leader as the detail fallback', () => {
    const agents = [
      entry({ id: 'leader', name: 'LEADER', status: 'idle' }),
      entry({ id: 'run', status: 'running' }),
      entry({ id: 'idle-worker', status: 'idle' }),
      entry({ id: 'ok', status: 'success' }),
      entry({ id: 'bad', status: 'failed' }),
      entry({ id: 'to', status: 'timeout' }),
      entry({ id: 'stop', status: 'stopped' }),
    ];
    const ids = selectLiveAgents(agents, now).map((e) => e.id);
    expect(ids).toEqual(['leader', 'run']);
  });

  it('returns an empty list when only an idle leader and inactive subagents remain', () => {
    const agents = [
      entry({ id: 'leader', name: 'LEADER', status: 'idle' }),
      entry({ id: 'idle-worker', status: 'idle' }),
      entry({ id: 'ok', status: 'success' }),
      entry({ id: 'bad', status: 'failed' }),
    ];
    expect(selectLiveAgents(agents, now)).toEqual([]);
  });

  it('keeps a running leader visible even when there are no active subagents', () => {
    const agents = [
      entry({ id: 'leader', name: 'LEADER', status: 'running' }),
      entry({ id: 'ok', status: 'success' }),
    ];
    expect(selectLiveAgents(agents, now).map((e) => e.id)).toEqual(['leader']);
  });

  it('hides idle subagents even when they are recent', () => {
    const agents = [
      entry({ id: 'leader', name: 'LEADER', status: 'idle' }),
      entry({ id: 'fresh', status: 'idle', lastEventAt: now - 5_000 }),
      entry({ id: 'stale', status: 'idle', lastEventAt: now - (IDLE_HIDE_MS + 1) }),
    ];
    expect(selectLiveAgents(agents, now)).toEqual([]);
  });

  it('preserves caller order for running subagents', () => {
    const agents = [
      entry({ id: 'leader', name: 'LEADER', status: 'idle' }),
      entry({ id: 'idle-old', status: 'idle', lastEventAt: now - 20_000 }),
      entry({ id: 'idle-new', status: 'idle', lastEventAt: now - 1_000 }),
      entry({ id: 'run-new', status: 'running', startedAt: now - 1_000, lastEventAt: now }),
      entry({ id: 'run-old', status: 'running', startedAt: now - 50_000, lastEventAt: now }),
    ];
    expect(selectLiveAgents(agents, now).map((e) => e.id)).toEqual(['leader', 'run-new', 'run-old']);
  });

  it('falls back to leader details when the selected agent disappears', () => {
    const agents = [
      entry({ id: 'leader', name: 'LEADER', status: 'running' }),
      entry({ id: 'run', status: 'running' }),
    ];
    const live = selectLiveAgents(agents, now);
    expect(selectAgentDetail(live, 'closed-agent')?.id).toBe('leader');
    expect(selectAgentDetail(live, 'run')?.id).toBe('run');
  });

  it('delays empty-list close and cancels it when agents return', () => {
    const emptyStartedAt = nextEmptyAgentsCloseStartedAt(0, now);
    expect(emptyStartedAt).toBe(now);
    expect(shouldCloseEmptyAgentsMonitor(0, now + EMPTY_AGENTS_CLOSE_DELAY_MS - 1, emptyStartedAt)).toBe(false);
    expect(shouldCloseEmptyAgentsMonitor(0, now + EMPTY_AGENTS_CLOSE_DELAY_MS, emptyStartedAt)).toBe(true);

    expect(nextEmptyAgentsCloseStartedAt(1, now + 1_000, emptyStartedAt)).toBeUndefined();
    expect(shouldCloseEmptyAgentsMonitor(1, now + EMPTY_AGENTS_CLOSE_DELAY_MS, emptyStartedAt)).toBe(false);
  });
});

describe('agents-monitor formatting', () => {
  it('renders exact model context windows instead of compact abbreviations', () => {
    expect(fmtExactTokens(1_050_000)).toBe('1,050,000 tok');
    expect(fmtExactTokens(128_000)).toBe('128,000 tok');
  });

  it('formats context runway with used/max/free tokens', () => {
    expect(formatContextRunway(80_000, 200_000)).toBe('80.0k/200.0k · 120.0k free');
    expect(formatContextRunway(undefined, 200_000)).toBe('ctx unknown');
  });

  it('formats recent tool chip content compactly', () => {
    expect(
      formatRecentToolChip({
        name: 'read',
        at: 1000,
        ok: true,
        durationMs: 1234,
        outputLines: 8,
        outputBytes: 2048,
      }),
    ).toBe('✓ read 1.2s 8L 2.0kB');
    expect(formatRecentToolChip({ name: 'bash', at: 1000, ok: false })).toBe('✗ bash');
  });

  it('formats the agent detail header as a non-duplicated title', () => {
    expect(
      formatAgentDetailHeader(
        entry({
          id: 'bug-hunter',
          name: 'Bug Hunter',
          status: 'running',
          provider: 'anthropic',
          model: 'anthropic-test-model',
          ctxPct: 0.8,
        }),
      ),
    ).toBe('Bug Hunter');
  });

  it('falls back to id when the agent detail header has no name', () => {
    expect(formatAgentDetailHeader(entry({ id: 'leader', name: '', status: 'running' }))).toBe('leader');
  });

  it('classifies agent pressure by context, budget, and status', () => {
    expect(agentRisk(entry({ id: 'idle', status: 'idle' }))).toBe('calm');
    expect(agentRisk(entry({ id: 'run', status: 'running' }))).toBe('busy');
    expect(agentRisk(entry({ id: 'hot', status: 'idle', ctxPct: 0.8 }))).toBe('hot');
    expect(agentRisk(entry({ id: 'crit', status: 'idle', ctxPct: 0.95 }))).toBe('critical');
    expect(agentRisk(entry({ id: 'warn', status: 'idle', budgetWarning: { kind: 'tokens', used: 9, limit: 10, at: 0 } }))).toBe('critical');
  });
});

describe('agents-monitor import re-exports', () => {
  it('re-exports bucketActivity from fleet-monitor', () => {
    expect(typeof bucketActivity).toBe('function');
  });

  it('re-exports sparkline from fleet-monitor', () => {
    expect(typeof sparkline).toBe('function');
  });
});

describe('bucketActivity (via fleet-monitor re-export)', () => {
  it('buckets tool timestamps into the trailing window', () => {
    const now = 100_000;
    // bins=5, binMs=2000 → window is [90_000, 100_000].
    const tools = [
      { at: 99_500 }, // last bin
      { at: 99_000 }, // last bin
      { at: 91_000 }, // first bin
      { at: 50_000 }, // out of window — ignored
    ];
    const out = bucketActivity(tools, now, 5, 2000);
    expect(out.length).toBe(5);
    expect(out[0]).toBe(1); // 91_000
    expect(out[4]).toBe(2); // 99_000 + 99_500
    expect(out.reduce((a, b) => a + b, 0)).toBe(3); // 50_000 excluded
  });

  it('returns all-zero for no recent activity', () => {
    expect(bucketActivity([], 1000, 4, 1000)).toEqual([0, 0, 0, 0]);
  });
});

describe('sparkline (via fleet-monitor re-export)', () => {
  it('returns empty string for empty input', () => {
    expect(sparkline([])).toBe('');
  });

  it('maps zero to the lowest glyph and the max to the highest', () => {
    const out = sparkline([0, 1, 2, 4, 8]);
    expect(out[0]).toBe('▁'); // zero
    expect(out[out.length - 1]).toBe('█'); // max
    expect(out.length).toBe(5);
  });

  it('scales relative to the series max', () => {
    const flat = sparkline([3, 3, 3]);
    // all equal to max → all full bars
    expect(flat).toBe('███');
  });
});
