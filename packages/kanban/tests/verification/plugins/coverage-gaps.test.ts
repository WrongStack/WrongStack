/**
 * Comprehensive coverage for Kanban verification plugins:
 * - MetricPlugin: metric comparison with met/missed/skipped paths
 * - CommandPlugin: shell command execution with pass/fail/reject paths
 * - FileExistsPlugin: file existence check
 * - FileMatchesPlugin: file content regex matching with JSON/description parsing
 */
import { describe, expect, it } from 'vitest';
import { MetricPlugin } from '../../../src/verification/plugins/metric.js';
import { CommandPlugin } from '../../../src/verification/plugins/command.js';
import { FileExistsPlugin } from '../../../src/verification/plugins/file-exists.js';
import { FileMatchesPlugin } from '../../../src/verification/plugins/file-matches.js';
import type { KanbanCheck, KanbanTask, KanbanGoalMetric } from '../../../src/types.js';
import type { VerificationContext } from '../../../src/verification/verification-context.js';

function makeCheck(overrides: Partial<KanbanCheck> = {}): KanbanCheck {
  return {
    id: 'check-1',
    description: 'Test check',
    type: 'metric' as KanbanCheck['type'],
    status: 'pending',
    ...overrides,
  } as KanbanCheck;
}

function makeContext(overrides: Partial<VerificationContext> = {}): VerificationContext {
  return {
    projectRoot: '/fake',
    board: {} as any,
    task: {} as KanbanTask,
    requireBackingEvidence: false,
    ...overrides,
  } as unknown as VerificationContext;
}

function commandResult(
  command: string,
  overrides: Partial<{
    exitCode: number;
    stdout: string;
    stderr: string;
    durationMs: number;
    rejected: boolean;
  }> = {},
) {
  return {
    command,
    exitCode: 0,
    stdout: '',
    stderr: '',
    durationMs: 0,
    ...overrides,
  };
}

function metricEvidence(result: { evidence: Record<string, unknown> }) {
  return result.evidence.metrics as Array<Record<string, unknown>>;
}

// ─── MetricPlugin ───────────────────────────────────────────────────────────

describe('MetricPlugin comprehensive', () => {
  const plugin = new MetricPlugin();

  it('returns skipped when task has no goal metrics', async () => {
    const result = await plugin.verify(
      makeCheck({ type: 'metric' }),
      makeContext({ task: { goalMetrics: [] } as unknown as KanbanTask }),
    );
    expect(result.status).toBe('skipped');
    expect(result.error).toContain('no goal metrics');
  });

  it('returns skipped when task has undefined goal metrics', async () => {
    const result = await plugin.verify(
      makeCheck({ type: 'metric' }),
      makeContext({ task: {} as KanbanTask }),
    );
    expect(result.status).toBe('skipped');
  });

  it('returns passed when all metrics meet targets', async () => {
    const metrics: KanbanGoalMetric[] = [
      { id: 'm1', name: 'coverage', status: 'pending', target: 80, current: 90 },
      { id: 'm2', name: 'speed', status: 'pending', target: 100, current: 100 },
    ];
    const result = await plugin.verify(
      makeCheck({ type: 'metric' }),
      makeContext({ task: { goalMetrics: metrics } as KanbanTask }),
    );
    expect(result.status).toBe('passed');
    expect(result.evidence.allMet).toBe(true);
    expect(result.evidence.total).toBe(2);
    expect(result.evidence.met).toBe(2);
    expect(result.evidence.missed).toBe(0);
    expect(result.error).toBeUndefined();
  });

  it('returns failed when some metrics do not meet targets', async () => {
    const metrics: KanbanGoalMetric[] = [
      { id: 'm1', name: 'coverage', status: 'pending', target: 80, current: 90 },
      { id: 'm2', name: 'speed', status: 'pending', target: 100, current: 50 },
    ];
    const result = await plugin.verify(
      makeCheck({ type: 'metric' }),
      makeContext({ task: { goalMetrics: metrics } as KanbanTask }),
    );
    expect(result.status).toBe('failed');
    expect(result.evidence.allMet).toBe(false);
    expect(result.evidence.missed).toBe(1);
    expect(result.error).toContain('1 metric(s) not met');
  });

  it('marks metrics with undefined target/current as not met', async () => {
    const metrics: KanbanGoalMetric[] = [{ id: 'm1', name: 'coverage', status: 'pending' }];
    const result = await plugin.verify(
      makeCheck({ type: 'metric' }),
      makeContext({ task: { goalMetrics: metrics } as KanbanTask }),
    );
    expect(result.status).toBe('failed');
    expect(metricEvidence(result)[0]?.met).toBe(false);
    expect(metricEvidence(result)[0]?.reason).toContain('Target or current');
  });

  it('converts string targets/current to numbers', async () => {
    const metrics: KanbanGoalMetric[] = [
      { id: 'm1', name: 'coverage', status: 'pending', target: '80', current: '90' },
    ];
    const result = await plugin.verify(
      makeCheck({ type: 'metric' }),
      makeContext({ task: { goalMetrics: metrics } as KanbanTask }),
    );
    expect(result.status).toBe('passed');
    expect(metricEvidence(result)[0]?.target).toBe(80);
    expect(metricEvidence(result)[0]?.current).toBe(90);
  });

  it('handles NaN values from invalid string conversion', async () => {
    const metrics: KanbanGoalMetric[] = [
      { id: 'm1', name: 'coverage', status: 'pending', target: 'abc', current: 'xyz' },
    ];
    const result = await plugin.verify(
      makeCheck({ type: 'metric' }),
      makeContext({ task: { goalMetrics: metrics } as KanbanTask }),
    );
    expect(result.status).toBe('failed');
    expect(metricEvidence(result)[0]?.met).toBe(false);
  });

  it('preserves unit field in evidence', async () => {
    const metrics: KanbanGoalMetric[] = [
      { id: 'm1', name: 'coverage', status: 'pending', target: 80, current: 90, unit: '%' },
    ];
    const result = await plugin.verify(
      makeCheck({ type: 'metric' }),
      makeContext({ task: { goalMetrics: metrics } as unknown as KanbanTask }),
    );
    expect(metricEvidence(result)[0]?.unit).toBe('%');
  });

  // ─── direction: at_most / at_least ────────────────────────────────────────

  it('at_most metric passes when current is below target (lower is better)', async () => {
    const metrics: KanbanGoalMetric[] = [
      {
        id: 'm1',
        name: 'error rate',
        status: 'pending',
        target: 5,
        current: 2,
        direction: 'at_most',
      },
    ];
    const result = await plugin.verify(
      makeCheck({ type: 'metric' }),
      makeContext({ task: { goalMetrics: metrics } as unknown as KanbanTask }),
    );
    expect(result.status).toBe('passed');
    expect(result.evidence.allMet).toBe(true);
    expect(metricEvidence(result)[0]?.met).toBe(true);
    expect(metricEvidence(result)[0]?.direction).toBe('at_most');
  });

  it('at_most metric passes when current equals target (boundary)', async () => {
    const metrics: KanbanGoalMetric[] = [
      {
        id: 'm1',
        name: 'cost ceiling',
        status: 'pending',
        target: 100,
        current: 100,
        direction: 'at_most',
      },
    ];
    const result = await plugin.verify(
      makeCheck({ type: 'metric' }),
      makeContext({ task: { goalMetrics: metrics } as unknown as KanbanTask }),
    );
    expect(result.status).toBe('passed');
    expect(metricEvidence(result)[0]?.met).toBe(true);
  });

  it('at_most metric fails when current exceeds target — the bug the old >= comparator had inverted', async () => {
    const metrics: KanbanGoalMetric[] = [
      {
        id: 'm1',
        name: 'open bugs',
        status: 'pending',
        target: 5,
        current: 50,
        direction: 'at_most',
      },
    ];
    const result = await plugin.verify(
      makeCheck({ type: 'metric' }),
      makeContext({ task: { goalMetrics: metrics } as unknown as KanbanTask }),
    );
    expect(result.status).toBe('failed');
    expect(result.evidence.missed).toBe(1);
    expect(metricEvidence(result)[0]?.met).toBe(false);
  });

  it('explicit at_least keeps the current >= target semantics', async () => {
    const metrics: KanbanGoalMetric[] = [
      {
        id: 'm1',
        name: 'coverage',
        status: 'pending',
        target: 80,
        current: 95,
        direction: 'at_least',
      },
      {
        id: 'm2',
        name: 'features',
        status: 'pending',
        target: 10,
        current: 3,
        direction: 'at_least',
      },
    ];
    const result = await plugin.verify(
      makeCheck({ type: 'metric' }),
      makeContext({ task: { goalMetrics: metrics } as unknown as KanbanTask }),
    );
    expect(result.status).toBe('failed');
    expect(result.evidence.met).toBe(1);
    expect(result.evidence.missed).toBe(1);
  });

  it('omitting direction defaults to at_least (back-compat with existing boards)', async () => {
    const metrics: KanbanGoalMetric[] = [
      { id: 'm1', name: 'coverage', status: 'pending', target: 80, current: 90 },
    ];
    const result = await plugin.verify(
      makeCheck({ type: 'metric' }),
      makeContext({ task: { goalMetrics: metrics } as unknown as KanbanTask }),
    );
    expect(result.status).toBe('passed');
    expect(metricEvidence(result)[0]?.direction).toBe('at_least');
  });

  it('mixed-direction metrics each use their own comparator', async () => {
    const metrics: KanbanGoalMetric[] = [
      { id: 'm1', name: 'coverage', status: 'pending', target: 80, current: 90 }, // at_least: met
      {
        id: 'm2',
        name: 'latency p95',
        status: 'pending',
        target: 200,
        current: 350,
        direction: 'at_most',
      }, // not met
      {
        id: 'm3',
        name: 'flaky tests',
        status: 'pending',
        target: 3,
        current: 1,
        direction: 'at_most',
      }, // met
    ];
    const result = await plugin.verify(
      makeCheck({ type: 'metric' }),
      makeContext({ task: { goalMetrics: metrics } as unknown as KanbanTask }),
    );
    expect(result.status).toBe('failed');
    expect(result.evidence.met).toBe(2);
    expect(result.evidence.missed).toBe(1);
    expect(result.error).toBe('1 metric(s) not met.');
  });

  it('at_most works with string-coerced numeric values', async () => {
    const metrics: KanbanGoalMetric[] = [
      {
        id: 'm1',
        name: 'cost',
        status: 'pending',
        target: '20',
        current: '15.5',
        direction: 'at_most',
      },
    ];
    const result = await plugin.verify(
      makeCheck({ type: 'metric' }),
      makeContext({ task: { goalMetrics: metrics } as unknown as KanbanTask }),
    );
    expect(result.status).toBe('passed');
    expect(metricEvidence(result)[0]?.met).toBe(true);
  });
});

// ─── CommandPlugin ──────────────────────────────────────────────────────────

describe('CommandPlugin comprehensive', () => {
  const plugin = new CommandPlugin();

  it('returns error when command is empty', async () => {
    const result = await plugin.verify(
      makeCheck({ type: 'command', description: '', notes: '' }),
      makeContext(),
    );
    expect(result.status).toBe('error');
    expect(result.error).toContain('requires a shell command');
  });

  it('uses command from notes when description is empty', async () => {
    const ctx = makeContext({
      runCommand: async (command) => commandResult(command, { stdout: 'ok', durationMs: 5 }),
    });
    const result = await plugin.verify(
      makeCheck({ type: 'command', description: '', notes: 'ls -la' }),
      ctx,
    );
    expect(result.status).toBe('passed');
    expect(result.evidence.command).toBe('ls -la');
    expect(result.evidence.exitCode).toBe(0);
  });

  it('returns passed when command exits 0', async () => {
    const ctx = makeContext({
      runCommand: async (command) => commandResult(command, { stdout: 'success', durationMs: 10 }),
    });
    const result = await plugin.verify(
      makeCheck({ type: 'command', description: 'echo hello' }),
      ctx,
    );
    expect(result.status).toBe('passed');
    expect(result.error).toBeUndefined();
  });

  it('returns failed when command exits non-zero', async () => {
    const ctx = makeContext({
      runCommand: async (command) =>
        commandResult(command, { exitCode: 1, stderr: 'error msg', durationMs: 10 }),
    });
    const result = await plugin.verify(makeCheck({ type: 'command', description: 'false' }), ctx);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('code 1');
  });

  it('returns error when command is rejected by security gate', async () => {
    const ctx = makeContext({
      runCommand: async (command) =>
        commandResult(command, {
          exitCode: -1,
          stderr: 'Blocked: shell operator detected',
          rejected: true,
        }),
    });
    const result = await plugin.verify(
      makeCheck({ type: 'command', description: 'rm -rf /' }),
      ctx,
    );
    expect(result.status).toBe('error');
    expect(result.evidence.rejectionReason).toContain('Blocked');
    expect(result.error).toContain('security gate');
  });

  it('truncates stdout and stderr in evidence', async () => {
    const longStdout = 'x'.repeat(10000);
    const longStderr = 'y'.repeat(3000);
    const ctx = makeContext({
      runCommand: async (command) =>
        commandResult(command, {
          exitCode: 1,
          stdout: longStdout,
          stderr: longStderr,
          durationMs: 5,
        }),
    });
    const result = await plugin.verify(makeCheck({ type: 'command', description: 'test' }), ctx);
    expect((result.evidence.stdout as string).length).toBe(5000);
    expect((result.evidence.stderr as string).length).toBe(2000);
  });

  it('prefers notes over description for command', async () => {
    let capturedCmd = '';
    const ctx = makeContext({
      runCommand: async (cmd: string) => {
        capturedCmd = cmd;
        return commandResult(cmd);
      },
    });
    await plugin.verify(
      makeCheck({ type: 'command', description: 'from-desc', notes: 'from-notes' }),
      ctx,
    );
    expect(capturedCmd).toBe('from-notes');
  });
});

// ─── FileExistsPlugin ───────────────────────────────────────────────────────

describe('FileExistsPlugin comprehensive', () => {
  const plugin = new FileExistsPlugin();

  it('returns error when path is empty', async () => {
    const result = await plugin.verify(
      makeCheck({ type: 'file_exists', description: '', notes: '' }),
      makeContext(),
    );
    expect(result.status).toBe('error');
    expect(result.error).toContain('requires a file path');
  });

  it('returns passed when file exists', async () => {
    const ctx = makeContext({
      fileStat: async () => ({ exists: true, size: 1024, mtime: '2026-01-01' }),
    });
    const result = await plugin.verify(
      makeCheck({ type: 'file_exists', description: 'src/index.ts' }),
      ctx,
    );
    expect(result.status).toBe('passed');
    expect(result.evidence.exists).toBe(true);
    expect(result.evidence.size).toBe(1024);
    expect(result.error).toBeUndefined();
  });

  it('returns failed when file does not exist', async () => {
    const ctx = makeContext({
      fileStat: (async () => ({
        exists: false,
        size: 0,
        mtime: null,
      })) as unknown as VerificationContext['fileStat'],
    });
    const result = await plugin.verify(
      makeCheck({ type: 'file_exists', description: 'missing.ts' }),
      ctx,
    );
    expect(result.status).toBe('failed');
    expect(result.evidence.exists).toBe(false);
    expect(result.error).toContain('File not found');
  });

  it('returns failed when fileStat returns null', async () => {
    const ctx = makeContext({
      fileStat: (async () => null) as unknown as VerificationContext['fileStat'],
    });
    const result = await plugin.verify(
      makeCheck({ type: 'file_exists', description: 'missing.ts' }),
      ctx,
    );
    expect(result.status).toBe('failed');
    expect(result.evidence.exists).toBe(false);
    expect(result.evidence.size).toBe(0);
    expect(result.evidence.mtime).toBeNull();
  });

  it('uses notes for file path when description is empty', async () => {
    let capturedPath = '';
    const ctx = makeContext({
      fileStat: async (p: string) => {
        capturedPath = p;
        return { exists: true, size: 100, mtime: '2026-01-01' };
      },
    });
    await plugin.verify(
      makeCheck({ type: 'file_exists', description: '', notes: 'config.json' }),
      ctx,
    );
    expect(capturedPath).toBe('config.json');
  });
});

// ─── FileMatchesPlugin ──────────────────────────────────────────────────────

describe('FileMatchesPlugin comprehensive', () => {
  const plugin = new FileMatchesPlugin();

  it('parses JSON config from notes and matches', async () => {
    const ctx = makeContext({
      readFile: async () => 'export const VERSION = "1.0.0";',
    });
    const result = await plugin.verify(
      makeCheck({
        type: 'file_matches',
        description: 'version check',
        notes: JSON.stringify({ file: 'version.ts', pattern: 'VERSION', flags: '' }),
      }),
      ctx,
    );
    expect(result.status).toBe('passed');
    expect(result.evidence.matched).toBe(true);
    expect(result.evidence.lineNumbers).toContain(1);
  });

  it('returns failed when pattern not found', async () => {
    const ctx = makeContext({
      readFile: async () => 'export const FOO = "bar";',
    });
    const result = await plugin.verify(
      makeCheck({
        type: 'file_matches',
        description: 'version check',
        notes: JSON.stringify({ file: 'version.ts', pattern: 'NONEXISTENT' }),
      }),
      ctx,
    );
    expect(result.status).toBe('failed');
    expect(result.evidence.matched).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('falls back to description parsing when notes is not JSON', async () => {
    const ctx = makeContext({
      readFile: async () => 'const foo = 42;',
    });
    const result = await plugin.verify(
      makeCheck({
        type: 'file_matches',
        description: 'src/foo.ts should contain foo',
        notes: 'not json',
      }),
      ctx,
    );
    expect(result.evidence.path).toBeDefined();
  });

  it('returns error when config has no file', async () => {
    const result = await plugin.verify(
      makeCheck({
        type: 'file_matches',
        description: '',
        notes: JSON.stringify({ pattern: 'test' }),
      }),
      makeContext(),
    );
    expect(result.status).toBe('error');
    expect(result.error).toContain('requires { file, pattern }');
  });

  it('returns error when config has no pattern', async () => {
    const result = await plugin.verify(
      makeCheck({
        type: 'file_matches',
        description: '',
        notes: JSON.stringify({ file: 'test.ts' }),
      }),
      makeContext(),
    );
    expect(result.status).toBe('error');
    expect(result.error).toContain('requires { file, pattern }');
  });

  it('returns error on file read failure', async () => {
    const ctx = makeContext({
      readFile: async () => {
        throw new Error('ENOENT');
      },
    });
    const result = await plugin.verify(
      makeCheck({
        type: 'file_matches',
        description: '',
        notes: JSON.stringify({ file: 'missing.ts', pattern: 'test' }),
      }),
      ctx,
    );
    expect(result.status).toBe('error');
    expect(result.error).toContain('ENOENT');
  });

  it('uses flags from config for regex', async () => {
    const ctx = makeContext({
      readFile: async () => 'CONSTANT_VALUE = 1;\nconstant_value = 2;',
    });
    const result = await plugin.verify(
      makeCheck({
        type: 'file_matches',
        description: '',
        notes: JSON.stringify({ file: 'test.ts', pattern: 'constant', flags: 'i' }),
      }),
      ctx,
    );
    expect(result.status).toBe('passed');
    expect(result.evidence.matchCount).toBe(2);
  });

  it('handles empty notes with empty description', async () => {
    const result = await plugin.verify(
      makeCheck({ type: 'file_matches', description: '', notes: '' }),
      makeContext(),
    );
    expect(result.status).toBe('error');
  });
});
