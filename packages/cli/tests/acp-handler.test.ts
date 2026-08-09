/**
 * Tests for the `wstack acp` subcommand handler.
 *
 * The handler has two top-level concerns:
 *  1. Argument parsing & dispatch (list / spawn / parallel / help / server).
 *  2. For `parallel`, fanning a task out to multiple ACP agents concurrently
 *     and rendering the aggregate result.
 *
 * The actual ACP runner (`@wrongstack/acp`) is heavy — it spawns child
 * processes, opens stdio JSON-RPC, talks to LLM providers. We mock it
 * and assert on the dispatch / aggregation logic in this CLI layer.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock @wrongstack/acp — we don't want to spawn real agents in unit tests.
// We mock `runEnsemble` (used by parallel) and `runOneAcpTask` (used by
// spawn) directly. The runner-level integration is tested separately in
// packages/acp/tests/{ensemble-runner,acp-subagent-runner}.test.ts.
const runEnsemble = vi.fn();
const runOneAcpTask = vi.fn();
const ensembleList = vi.fn();
const runAcpBench = vi.fn();
const renderAcpBenchText = vi.fn(() => 'BENCH_TEXT');
const probeAcpAgents = vi.fn();
vi.mock('@wrongstack/acp', () => ({
  runEnsemble: (...a: unknown[]) => runEnsemble(...a),
  runOneAcpTask: (...a: unknown[]) => runOneAcpTask(...a),
  runAcpBench: (...a: unknown[]) => runAcpBench(...a),
  renderAcpBenchText: (...a: unknown[]) =>
    (renderAcpBenchText as (...a: unknown[]) => unknown)(...a),
  probeAcpAgents: (...a: unknown[]) => probeAcpAgents(...a),
  defaultPermissionPolicy: { evaluate: () => ({ permission: 'auto' }) },
  EnsembleRegistry: class {
    list = ensembleList;
  },
  // `spawn` + `parallel` resolve agent ids through this:
  resolveAcpAgentCommand: (id: string) => {
    const catalog: Record<string, { command: string; args: string[]; role: string }> = {
      'claude-code': { command: 'claude', args: [], role: 'claude-code' },
      'gemini-cli': { command: 'gemini', args: [], role: 'gemini-cli' },
      'codex-cli': { command: 'codex', args: [], role: 'codex-cli' },
    };
    return catalog[id] ?? null;
  },
}));
vi.mock('@wrongstack/acp/agent', () => ({
  WrongStackACPServer: class {
    start = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn();
  },
}));

import { acpCmd } from '../src/subcommands/handlers/acp.js';

function fakeDeps() {
  return {
    config: {} as never,
    renderer: {
      write: vi.fn(),
      writeError: vi.fn(),
      writeInfo: vi.fn(),
      writeWarning: vi.fn(),
    },
    reader: { readLine: vi.fn() },
    modelsRegistry: {},
    vault: {},
    paths: { globalConfig: '/tmp/cfg.json' },
    cwd: '/tmp',
    projectRoot: '/tmp',
    userHome: '/tmp',
    flags: {},
  } as never as Parameters<typeof acpCmd>[1];
}

function flattenWriteCalls(deps: ReturnType<typeof fakeDeps>): string {
  return (deps.renderer.write as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]).join('');
}
function flattenWriteInfoCalls(deps: ReturnType<typeof fakeDeps>): string {
  return (deps.renderer.writeInfo as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]).join('');
}
function flattenWriteErrorCalls(deps: ReturnType<typeof fakeDeps>): string {
  return (deps.renderer.writeError as ReturnType<typeof vi.fn>).mock.calls
    .map((c) => c[0])
    .join('');
}
function flattenWriteWarningCalls(deps: ReturnType<typeof fakeDeps>): string {
  return (deps.renderer.writeWarning as ReturnType<typeof vi.fn>).mock.calls
    .map((c) => c[0])
    .join('');
}

/**
 * Mock `runEnsemble` to return a synthetic `EnsembleResult` driven by a
 * per-agent status map. The mock honours the `signal` option: if the
 * signal is already aborted, all agents are reported as cancelled. The
 * CLI's renderer wrapper should handle each status correctly.
 */
function mockEnsembleRun(
  results: Record<
    string,
    {
      status: 'success' | 'failed';
      result?: unknown;
      error?: { kind: string; message: string };
      iterations?: number;
      toolCalls?: number;
    }
  >,
) {
  runEnsemble.mockImplementation(async (opts: { agentIds: string; signal?: AbortSignal }) => {
    const ids = opts.agentIds
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const aborted = opts.signal?.aborted === true;
    const ensembleResults = ids.map((id) => {
      if (aborted) {
        return {
          agentId: id,
          status: 'cancelled' as const,
          error: { kind: 'aborted', message: 'aborted by parent' },
          durationMs: 0,
          iterations: 0,
          toolCalls: 0,
        };
      }
      const r = results[id];
      if (!r || r.status === 'failed') {
        return {
          agentId: id,
          status: 'failed' as const,
          error: r?.error ?? { kind: 'unknown', message: 'no mock for ' + id },
          durationMs: 5,
          iterations: 0,
          toolCalls: 0,
        };
      }
      return {
        agentId: id,
        status: 'success' as const,
        result: r.result,
        durationMs: 100,
        iterations: r.iterations ?? 1,
        toolCalls: r.toolCalls ?? 0,
      };
    });
    const summary = { succeeded: 0, failed: 0, skipped: 0, cancelled: 0 };
    for (const r of ensembleResults) {
      if (r.status === 'success') summary.succeeded++;
      else summary[r.status]++;
    }
    return {
      task: '',
      requested: ids,
      results: ensembleResults,
      summary,
      totalDurationMs: 100,
    };
  });
}

beforeEach(() => {
  runEnsemble.mockReset();
  runOneAcpTask.mockReset();
  ensembleList.mockReset();
  runAcpBench.mockReset();
  renderAcpBenchText.mockClear();
  probeAcpAgents.mockReset();
});

describe('acpCmd — dispatch', () => {
  it('shows help for `acp help`', async () => {
    const deps = fakeDeps();
    const code = await acpCmd(['help'], deps);
    expect(code).toBe(0);
    const out = flattenWriteCalls(deps);
    expect(out).toContain('wstack acp — ACP');
    expect(out).toContain('wstack acp parallel');
    expect(out).toContain('wstack acp spawn');
  });

  it('returns 1 for an unknown subcommand', async () => {
    const deps = fakeDeps();
    const code = await acpCmd(['nonsense'], deps);
    expect(code).toBe(1);
    expect(flattenWriteErrorCalls(deps)).toContain('Unknown acp subcommand');
  });

  it('shows detected agents for `acp list`', async () => {
    ensembleList.mockResolvedValue([
      { id: 'claude-code', displayName: 'Claude Code', installed: true, version: '2.1.178' },
      { id: 'gemini-cli', displayName: 'Gemini CLI', installed: true, version: '0.45.1' },
      { id: 'goose', displayName: 'Goose', installed: false, reason: 'binary not found' },
    ]);
    const deps = fakeDeps();
    const code = await acpCmd(['list'], deps);
    expect(code).toBe(0);
    const out = flattenWriteCalls(deps);
    expect(out).toContain('claude-code');
    expect(out).toContain('gemini-cli');
    expect(out).toContain('2.1.178');
    expect(out).toContain('2 of 3 agents available');
  });
});

describe('acpCmd — parallel', () => {
  it('returns 1 with usage when no args', async () => {
    const deps = fakeDeps();
    const code = await acpCmd(['parallel'], deps);
    expect(code).toBe(1);
    expect(flattenWriteErrorCalls(deps)).toContain('Usage: wstack acp parallel');
  });

  it('returns 1 when csv given but no task', async () => {
    const deps = fakeDeps();
    const code = await acpCmd(['parallel', 'claude-code,gemini-cli'], deps);
    expect(code).toBe(1);
    expect(flattenWriteErrorCalls(deps)).toContain('Task description is required');
  });

  it('renders a fan-out with success + skip + run when mixed', async () => {
    // `goose` is missing → renderer should print a warning; the two
    // installed agents should each get a "===" header and a success footer.
    runEnsemble.mockImplementationOnce(async (opts: { agentIds: string; signal?: AbortSignal }) => {
      const ids = opts.agentIds
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const ensembleResults = [
        {
          agentId: 'claude-code',
          status: 'success' as const,
          result: 'fix applied',
          durationMs: 100,
          iterations: 3,
          toolCalls: 5,
        },
        {
          agentId: 'gemini-cli',
          status: 'success' as const,
          result: 'no changes needed',
          durationMs: 100,
          iterations: 2,
          toolCalls: 1,
        },
        {
          agentId: 'goose',
          status: 'skipped' as const,
          reason: 'binary not found',
          durationMs: 0,
          iterations: 0,
          toolCalls: 0,
        },
      ];
      return {
        task: 'review diff',
        requested: ids,
        results: ensembleResults,
        summary: { succeeded: 2, failed: 0, skipped: 1, cancelled: 0 },
        totalDurationMs: 100,
      };
    });

    const deps = fakeDeps();
    const code = await acpCmd(['parallel', 'claude-code,gemini-cli,goose', 'review diff'], deps);
    expect(code).toBe(0);

    const info = flattenWriteInfoCalls(deps);
    const warn = flattenWriteWarningCalls(deps);
    const out = flattenWriteCalls(deps);

    expect(warn).toContain('goose');
    expect(warn).toContain('not installed');
    expect(info).toContain('claude-code');
    expect(info).toContain('gemini-cli');
    expect(info).toContain('review diff');
    expect(out).toContain('=== claude-code ===');
    expect(out).toContain('=== gemini-cli ===');
    expect(out).toContain('fix applied');
    expect(out).toContain('no changes needed');
    expect(out).toContain('2 succeeded, 0 failed, 0 cancelled, 1 skipped');
  });

  it('returns 1 when ALL agents fail', async () => {
    mockEnsembleRun({
      'claude-code': {
        status: 'failed',
        error: { kind: 'bridge_failed', message: 'spawn failed' },
      },
      'gemini-cli': { status: 'failed', error: { kind: 'timeout', message: 'timed out' } },
    });
    const deps = fakeDeps();
    const code = await acpCmd(['parallel', 'claude-code,gemini-cli', 'do thing'], deps);
    expect(code).toBe(1);
    const out = flattenWriteCalls(deps);
    const err = flattenWriteErrorCalls(deps);
    expect(out).toContain('0 succeeded, 2 failed, 0 cancelled, 0 skipped');
    expect(err).toContain('bridge_failed');
    expect(err).toContain('timeout');
  });

  it('returns 1 when none of the requested agents are installed', async () => {
    runEnsemble.mockResolvedValueOnce({
      task: '',
      requested: ['goose', 'openhands'],
      results: [
        {
          agentId: 'goose',
          status: 'skipped',
          reason: 'not installed',
          durationMs: 0,
          iterations: 0,
          toolCalls: 0,
        },
        {
          agentId: 'openhands',
          status: 'skipped',
          reason: 'not installed',
          durationMs: 0,
          iterations: 0,
          toolCalls: 0,
        },
      ],
      summary: { succeeded: 0, failed: 0, skipped: 2, cancelled: 0 },
      totalDurationMs: 0,
    });
    const deps = fakeDeps();
    const code = await acpCmd(['parallel', 'goose,openhands', 'task'], deps);
    expect(code).toBe(1);
    expect(flattenWriteErrorCalls(deps)).toContain('No installed agents to run');
  });

  it('passes the abort signal into runEnsemble for cancellation', async () => {
    mockEnsembleRun({ 'claude-code': { status: 'success' } });
    const deps = fakeDeps();
    await acpCmd(['parallel', 'claude-code', 'task'], deps);
    expect(runEnsemble).toHaveBeenCalledTimes(1);
    const call = runEnsemble.mock.calls[0]![0] as { signal?: AbortSignal };
    expect(call.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('acpCmd — probe', () => {
  it('probes an explicit agent list (bounded) and returns 0 when one handshakes', async () => {
    probeAcpAgents.mockResolvedValue([
      { id: 'gemini-cli', ok: true, ms: 120, agentInfo: { name: 'gemini', version: '1' } },
      { id: 'codex-cli', ok: false, ms: 8000, error: 'initialize timed out' },
    ]);
    const deps = fakeDeps();
    const code = await acpCmd(['probe', 'gemini-cli,codex-cli'], deps);
    expect(code).toBe(0);
    const arg = probeAcpAgents.mock.calls[0]![0] as { agentIds: string[] };
    expect(arg.agentIds).toEqual(['gemini-cli', 'codex-cli']);
    const out = flattenWriteCalls(deps);
    expect(out).toContain('✓ gemini-cli');
    expect(out).toContain('✗ codex-cli');
    expect(out).toContain('1 of 2 agents completed the ACP handshake');
  });

  it('returns 1 when no agent handshakes', async () => {
    probeAcpAgents.mockResolvedValue([{ id: 'gemini-cli', ok: false, ms: 8000, error: 'x' }]);
    const deps = fakeDeps();
    const code = await acpCmd(['probe', 'gemini-cli'], deps);
    expect(code).toBe(1);
  });
});

describe('acpCmd — bench', () => {
  it('benches an explicit agent list and returns 0 when one passes', async () => {
    runAcpBench.mockResolvedValue({ summary: { pass: 1, partial: 0, fail: 1, skipped: 0 } });
    const deps = fakeDeps();
    const code = await acpCmd(['bench', 'gemini-cli,codex-cli'], deps);
    expect(code).toBe(0);
    expect(runAcpBench).toHaveBeenCalledTimes(1);
    const arg = runAcpBench.mock.calls[0]![0] as { agentIds: string[]; checkFs?: boolean };
    expect(arg.agentIds).toEqual(['gemini-cli', 'codex-cli']);
    expect(arg.checkFs).toBe(false);
    expect(flattenWriteCalls(deps)).toContain('BENCH_TEXT');
  });

  it('returns 1 when no agent passes the bench', async () => {
    runAcpBench.mockResolvedValue({ summary: { pass: 0, partial: 1, fail: 1, skipped: 0 } });
    const deps = fakeDeps();
    const code = await acpCmd(['bench', 'gemini-cli', '--fs'], deps);
    expect(code).toBe(1);
    const arg = runAcpBench.mock.calls[0]![0] as { checkFs?: boolean };
    expect(arg.checkFs).toBe(true);
  });
});

describe('acpCmd — spawn', () => {
  it('returns 1 with usage when no agent id', async () => {
    const deps = fakeDeps();
    const code = await acpCmd(['spawn'], deps);
    expect(code).toBe(1);
    expect(flattenWriteErrorCalls(deps)).toContain('Usage: wstack acp spawn');
  });

  it('runs a single agent and renders the result', async () => {
    // `spawn` calls `runOneAcpTask` directly, so we mock that here
    // (the `parallel` tests mock `runEnsemble`).
    runOneAcpTask.mockResolvedValueOnce({
      result: 'analysis complete',
      iterations: 4,
      toolCalls: 7,
    });
    const deps = fakeDeps();
    const code = await acpCmd(['spawn', 'claude-code', 'explain this code'], deps);
    expect(code).toBe(0);
    const out = flattenWriteCalls(deps);
    const info = flattenWriteInfoCalls(deps);
    expect(out).toContain('analysis complete');
    expect(info).toContain('iterations=4');
    expect(info).toContain('toolCalls=7');
  });

  it('returns 1 with the error kind when the runner throws', async () => {
    runOneAcpTask.mockImplementationOnce(async () => {
      throw { kind: 'bridge_failed', message: 'agent crashed' };
    });
    const deps = fakeDeps();
    const code = await acpCmd(['spawn', 'claude-code', 'do thing'], deps);
    expect(code).toBe(1);
    const err = flattenWriteErrorCalls(deps);
    expect(err).toContain('[bridge_failed]');
    expect(err).toContain('agent crashed');
  });
});
