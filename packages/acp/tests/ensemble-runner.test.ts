/**
 * Tests for the ensemble runner — the engine that fans a single task
 * out to multiple ACP agents concurrently.
 *
 * We mock both the registry (so the install probe is deterministic)
 * and the runner factory (so we don't spawn real subprocesses). The
 * `runEnsemble` orchestrator is what we're testing — not the runner
 * itself, which has its own dedicated test file.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock the EnsembleRegistry so the install probe is deterministic. ──
const mockList = vi.fn();
vi.mock('../src/registry/ensemble-registry.js', () => ({
  EnsembleRegistry: class {
    list = mockList;
  },
}));

// ── Mock the runner factory so we don't spawn real child processes. ──
const makeACPSubagentRunnerWithStop = vi.fn();
vi.mock('../src/integration/acp-subagent-runner.js', () => ({
  makeACPSubagentRunnerWithStop: (...a: unknown[]) => makeACPSubagentRunnerWithStop(...a),
  ACP_AGENT_COMMANDS: {},
  // `defaultEnsembleCmdResolver` delegates to `resolveAcpAgentCommand`. The
  // resolver is only hit when a test doesn't pass its own `resolveCmd`; return
  // a trivial command so those paths resolve.
  resolveAcpAgentCommand: (id: string) => ({ command: id, args: [], role: id }),
}));

import {
  ensembleRunnerCoverage,
  renderEnsembleText,
  runEnsemble,
} from '../src/integration/ensemble-runner.js';

function fakeCmd(id: string) {
  return { command: id, args: [], role: id };
}

beforeEach(() => {
  mockList.mockReset();
  makeACPSubagentRunnerWithStop.mockReset();
});

describe('runEnsemble — argument parsing', () => {
  it('returns an empty result for an empty csv', async () => {
    const r = await runEnsemble({ agentIds: '', task: 'x' });
    expect(r.requested).toEqual([]);
    expect(r.results).toEqual([]);
    expect(r.summary).toEqual({ succeeded: 0, failed: 0, skipped: 0, cancelled: 0 });
  });

  it('dedupes ids and trims whitespace, preserving order', async () => {
    mockList.mockResolvedValue([
      { id: 'a', installed: true },
      { id: 'b', installed: true },
    ]);
    makeACPSubagentRunnerWithStop.mockResolvedValue({
      runner: async () => ({ result: 'ok', iterations: 1, toolCalls: 0 }),
      stop: () => undefined,
    });
    const r = await runEnsemble({ agentIds: ' a , b , a , a ', task: 't' });
    expect(r.requested).toEqual(['a', 'b']);
    expect(r.results).toHaveLength(2);
  });
});

describe('runEnsemble — skip / fail classification', () => {
  it('skips agents that are not installed and reports the reason', async () => {
    mockList.mockResolvedValue([
      { id: 'a', installed: true },
      { id: 'b', installed: false, reason: 'binary not found' },
    ]);
    makeACPSubagentRunnerWithStop.mockResolvedValue({
      runner: async () => ({ result: 'ok', iterations: 1, toolCalls: 0 }),
      stop: () => undefined,
    });
    const r = await runEnsemble({
      agentIds: 'a,b',
      task: 't',
      resolveCmd: fakeCmd,
    });
    expect(r.summary).toEqual({ succeeded: 1, failed: 0, skipped: 1, cancelled: 0 });
    const a = r.results.find((x) => x.agentId === 'a')!;
    const b = r.results.find((x) => x.agentId === 'b')!;
    expect(a.status).toBe('success');
    expect(b.status).toBe('skipped');
    expect(b.reason).toBe('binary not found');
    // Crucially: only ONE runner call, for the installed agent.
    expect(makeACPSubagentRunnerWithStop).toHaveBeenCalledTimes(1);
  });

  it('marks an agent as failed when the resolver returns null', async () => {
    mockList.mockResolvedValue([{ id: 'a', installed: true }]);
    const r = await runEnsemble({
      agentIds: 'a',
      task: 't',
      resolveCmd: () => null, // pretend nothing in the catalog knows this id
    });
    expect(r.summary).toEqual({ succeeded: 0, failed: 1, skipped: 0, cancelled: 0 });
    expect(r.results[0]!.status).toBe('failed');
    expect(r.results[0]!.error?.kind).toBe('unknown_agent');
  });
});

describe('runEnsemble — concurrent run', () => {
  it('runs all installed agents in parallel and aggregates results', async () => {
    mockList.mockResolvedValue([
      { id: 'a', installed: true },
      { id: 'b', installed: true },
      { id: 'c', installed: true },
    ]);
    let liveCount = 0;
    let maxLive = 0;
    makeACPSubagentRunnerWithStop.mockImplementation(async () => {
      liveCount++;
      maxLive = Math.max(maxLive, liveCount);
      // Stagger so concurrency is observable.
      await new Promise((r) => setTimeout(r, 20));
      liveCount--;
      return {
        runner: async () => ({ result: `from-${liveCount}`, iterations: 1, toolCalls: 0 }),
        stop: () => undefined,
      };
    });
    const t0 = Date.now();
    const r = await runEnsemble({
      agentIds: 'a,b,c',
      task: 'parallel-task',
      resolveCmd: fakeCmd,
    });
    const elapsed = Date.now() - t0;
    // Three 20ms tasks run in parallel → under 50ms (sequentially it
    // would be ≥60ms).
    expect(elapsed).toBeLessThan(55);
    expect(maxLive).toBeGreaterThanOrEqual(2);
    expect(r.summary).toEqual({ succeeded: 3, failed: 0, skipped: 0, cancelled: 0 });
  });

  it('captures per-agent failures and reports them as failed (not crashed)', async () => {
    mockList.mockResolvedValue([
      { id: 'a', installed: true },
      { id: 'b', installed: true },
    ]);
    makeACPSubagentRunnerWithStop.mockImplementation(async (cmd: { role: string }) => {
      const runner = async () => {
        if (cmd.role === 'a') {
          throw { kind: 'bridge_failed', message: 'spawn failed' };
        }
        return { result: 'a-ok', iterations: 1, toolCalls: 0 };
      };
      return { runner, stop: () => undefined };
    });
    const r = await runEnsemble({
      agentIds: 'a,b',
      task: 't',
      resolveCmd: fakeCmd,
    });
    expect(r.summary).toEqual({ succeeded: 1, failed: 1, skipped: 0, cancelled: 0 });
    const a = r.results.find((x) => x.agentId === 'a')!;
    expect(a.status).toBe('failed');
    expect(a.error?.kind).toBe('bridge_failed');
  });

  it('classifies AbortError as cancelled', async () => {
    mockList.mockResolvedValue([{ id: 'a', installed: true }]);
    makeACPSubagentRunnerWithStop.mockResolvedValue({
      runner: async () => {
        const e = new Error('aborted by parent');
        e.name = 'AbortError';
        throw e;
      },
      stop: () => undefined,
    });
    const r = await runEnsemble({
      agentIds: 'a',
      task: 't',
      resolveCmd: fakeCmd,
    });
    expect(r.summary.cancelled).toBe(1);
    expect(r.results[0]!.status).toBe('cancelled');
  });

  it('honors a pre-aborted signal by reporting cancelled for every agent', async () => {
    mockList.mockResolvedValue([
      { id: 'a', installed: true },
      { id: 'b', installed: true },
    ]);
    const ac = new AbortController();
    ac.abort();
    const r = await runEnsemble({
      agentIds: 'a,b',
      task: 't',
      resolveCmd: fakeCmd,
      signal: ac.signal,
    });
    expect(r.summary.cancelled).toBe(2);
    expect(makeACPSubagentRunnerWithStop).not.toHaveBeenCalled();
  });
});

describe('renderEnsembleText', () => {
  it('renders skipped agents with their reason', () => {
    const text = renderEnsembleText({
      task: 't',
      requested: ['a', 'b'],
      results: [
        {
          agentId: 'a',
          status: 'success',
          result: 'hello',
          durationMs: 12,
          iterations: 1,
          toolCalls: 0,
        },
        {
          agentId: 'b',
          status: 'skipped',
          reason: 'binary not found',
          durationMs: 0,
          iterations: 0,
          toolCalls: 0,
        },
      ],
      summary: { succeeded: 1, failed: 0, skipped: 1, cancelled: 0 },
      totalDurationMs: 12,
    });
    expect(text).toContain('=== a ===');
    expect(text).toContain('hello');
    expect(text).toContain('=== b ===');
    expect(text).toContain('skipped');
    expect(text).toContain('binary not found');
    expect(text).toContain('1 succeeded, 0 failed, 0 cancelled, 1 skipped');
  });

  it('renders failed agents with the error kind', () => {
    const text = renderEnsembleText({
      task: 't',
      requested: ['a'],
      results: [
        {
          agentId: 'a',
          status: 'failed',
          error: { kind: 'bridge_failed', message: 'crashed' },
          durationMs: 5,
          iterations: 0,
          toolCalls: 0,
        },
      ],
      summary: { succeeded: 0, failed: 1, skipped: 0, cancelled: 0 },
      totalDurationMs: 5,
    });
    expect(text).toContain('[bridge_failed]');
    expect(text).toContain('crashed');
    expect(text).toContain('0 succeeded, 1 failed');
  });

  it('handles an empty result set', () => {
    const text = renderEnsembleText({
      task: 't',
      requested: [],
      results: [],
      summary: { succeeded: 0, failed: 0, skipped: 0, cancelled: 0 },
      totalDurationMs: 0,
    });
    expect(text).toBe('No agent ids provided.');
  });
});

describe('ensemble runner completion coverage', () => {
  it('covers empty bounded maps and missing result updates', async () => {
    await expect(ensembleRunnerCoverage.mapBound([], async () => 1, 0)).resolves.toEqual([]);
    const results = [
      {
        agentId: 'present',
        status: 'skipped' as const,
        durationMs: 0,
        iterations: 0,
        toolCalls: 0,
      },
    ];
    ensembleRunnerCoverage.setResult(results, 'missing', { status: 'failed' });
    expect(results[0]!.status).toBe('skipped');
  });

  it('forwards progress, signals, null results, and throwing cleanup', async () => {
    mockList.mockResolvedValue([{ id: 'a', installed: true }]);
    const stop = vi.fn(() => {
      throw new Error('already stopped');
    });
    makeACPSubagentRunnerWithStop.mockImplementation(async (options) => {
      options.onProgress({ type: 'status' });
      return {
        runner: async () => ({ result: null, iterations: 1, toolCalls: 2 }),
        stop,
      };
    });
    const onProgress = vi.fn();
    const controller = new AbortController();
    const result = await runEnsemble({
      agentIds: 'a',
      task: 't',
      resolveCmd: fakeCmd,
      signal: controller.signal,
      onProgress,
      maxConcurrency: 0,
    });
    expect(result.results[0]).toMatchObject({ status: 'success', result: '' });
    expect(onProgress).toHaveBeenCalledWith('a', { type: 'status' });
  });

  it.each([
    [{ kind: 'aborted' }, 'cancelled'],
    [{ kind: 'aborted_by_parent' }, 'cancelled'],
    [{ message: 'operation ABORTED now' }, 'cancelled'],
    [
      Object.defineProperty(new Error(), 'message', {
        value: undefined,
        configurable: true,
      }),
      'failed',
    ],
    [null, 'failed'],
  ])('classifies failure variant %#', async (failure, status) => {
    mockList.mockResolvedValue([{ id: 'a', installed: true }]);
    makeACPSubagentRunnerWithStop.mockResolvedValue({
      runner: async () => {
        throw failure;
      },
      stop: () => undefined,
    });
    const result = await runEnsemble({
      agentIds: 'a',
      task: 't',
      resolveCmd: fakeCmd,
    });
    expect(result.results[0]!.status).toBe(status);
  });

  it('uses a fallback skip reason for uncatalogued agents', async () => {
    mockList.mockResolvedValue([]);
    const result = await runEnsemble({
      agentIds: 'missing',
      task: 't',
      resolveCmd: fakeCmd,
    });
    expect(result.results[0]!.reason).toBe('not in catalog');
  });

  it('renders every status fallback', () => {
    const text = renderEnsembleText({
      task: 't',
      requested: ['empty', 'failed', 'cancelled', 'skipped'],
      results: [
        {
          agentId: 'empty',
          status: 'success',
          result: '',
          durationMs: 0,
          iterations: 0,
          toolCalls: 0,
        },
        {
          agentId: 'failed',
          status: 'failed',
          durationMs: 0,
          iterations: 0,
          toolCalls: 0,
        },
        {
          agentId: 'cancelled',
          status: 'cancelled',
          durationMs: 0,
          iterations: 0,
          toolCalls: 0,
        },
        {
          agentId: 'skipped',
          status: 'skipped',
          durationMs: 0,
          iterations: 0,
          toolCalls: 0,
        },
      ],
      summary: { succeeded: 1, failed: 1, skipped: 1, cancelled: 1 },
      totalDurationMs: 0,
    });
    expect(text).toContain('(no result)');
    expect(text).toContain('[unknown] failed');
    expect(text).toContain('[aborted] cancelled');
    expect(text).toContain('skipped — not installed');
  });
});
