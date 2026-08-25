import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '@wrongstack/core/kernel';
import { installChimeraCascadeHandler } from '../src/execution-chimera-cascade.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

function harness(
  director: Record<string, unknown> | null,
  opts: {
    verifyEvidence?: Parameters<typeof installChimeraCascadeHandler>[0]['verifyEvidence'];
    persistEvidence?: Parameters<typeof installChimeraCascadeHandler>[0]['persistEvidence'];
    teardownHandlers?: Array<() => void>;
  } = {},
) {
  let handler: ((event: unknown, payload: unknown) => void) | undefined;
  let pending: Promise<void> | undefined;
  const session = { append: vi.fn().mockResolvedValue(undefined) };
  const events = {
    onPattern: vi.fn((_name, value) => {
      handler = value;
    }),
    emitCustom: vi.fn(),
  };
  installChimeraCascadeHandler({
    events: events as never,
    director: director as never,
    session: session as never,
    getPendingWork: () => pending,
    trackWork: (work) => {
      pending = work;
    },
    verifyEvidence: opts.verifyEvidence,
    persistEvidence: opts.persistEvidence,
    teardownHandlers: opts.teardownHandlers,
  });
  return {
    events,
    session,
    emit: (payload: unknown) => handler?.({}, payload),
    wait: () => pending,
  };
}

describe('installChimeraCascadeHandler', () => {
  it('captures its wildcard disposer into teardownHandlers (EventBus leak fix)', () => {
    const bus = new EventBus();
    const teardownHandlers: Array<() => void> = [];
    installChimeraCascadeHandler({
      events: bus as never,
      director: null as never,
      session: { append: vi.fn().mockResolvedValue(undefined) } as never,
      getPendingWork: () => undefined,
      trackWork: vi.fn(),
      persistEvidence: vi.fn(),
      teardownHandlers,
    });
    expect(bus.wildcardCount()).toBe(1);
    expect(teardownHandlers).toHaveLength(1);
    teardownHandlers[0]!();
    expect(bus.wildcardCount()).toBe(0);
  });

  it('skips cascades without a Director or requested agents', () => {
    const absent = harness(null);
    absent.emit({ agents: ['bug-hunter'] });
    expect(absent.wait()).toBeUndefined();

    const empty = harness({ spawn: vi.fn() });
    empty.emit({ agents: [] });
    expect(empty.wait()).toBeUndefined();
  });

  it('runs successful and failed cascade agents, terminates them, and enforces depth', async () => {
    const director = {
      spawn: vi.fn().mockResolvedValueOnce('agent-1').mockResolvedValueOnce('agent-2'),
      assign: vi.fn().mockResolvedValue(undefined),
      awaitTasks: vi
        .fn()
        .mockResolvedValueOnce([{ status: 'success', result: { fixed: true } }])
        .mockResolvedValueOnce([{ status: 'failed', error: new Error('not fixed') }]),
      terminate: vi.fn().mockResolvedValue(undefined),
    };
    const h = harness(director);
    h.emit({
      agents: ['security-scanner', 'bug-hunter'],
      bundle: {
        cwd: 'D:/repo',
        files: [],
        cascadeDepth: 1,
        maxCascadeDepth: 1,
      },
      reviewText: 'review',
      severities: { critical: 0, high: 1, medium: 0 },
    });
    await h.wait();

    expect(director.spawn).toHaveBeenCalledTimes(2);
    expect(director.spawn).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ role: 'security-scanner' }),
    );
    // Cascade agents are opted into the graceful-finish lifecycle: a rung
    // crossing its wall-clock budget is notified in-band (never killed) and
    // finishes its own turn within the grace window. Ladder retry still
    // applies — a grace-exhausted rung lands as `timeout` and advances.
    expect(director.spawn).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ gracefulFinish: true }),
    );
    expect(director.spawn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ gracefulFinish: true }),
    );
    expect(director.terminate).toHaveBeenCalledTimes(2);
    const writes = h.session.append.mock.calls.map(([entry]) => entry);
    expect(writes.some((entry) => entry.type === 'llm_response')).toBe(true);
    expect(writes.some((entry) => entry.type === 'error')).toBe(true);
  });

  it('re-reads changed files and records verified cascade evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chimera-cascade-'));
    roots.push(root);
    await writeFile(join(root, 'changed.ts'), 'changed');
    const director = {
      spawn: vi.fn().mockRejectedValueOnce('spawn failed').mockResolvedValueOnce('agent-2'),
      assign: vi.fn().mockResolvedValue(undefined),
      awaitTasks: vi.fn().mockResolvedValue([
        {
          status: 'success',
          result:
            'fixed\n```json\n{"verification_evidence":{"typecheck":{"command":"pnpm typecheck","exitCode":0}}}\n```',
        },
      ]),
      terminate: vi.fn().mockRejectedValue('terminate failed'),
    };
    const verification = {
      status: 'verified' as const,
      checks: [
        {
          name: 'typecheck' as const,
          command: 'pnpm typecheck',
          claimedExitCode: 0,
          actualExitCode: 0,
          ok: true,
        },
      ],
      summary: 'verified',
    };
    const verifyEvidence = vi.fn().mockResolvedValue(verification);
    const persistEvidence = vi.fn().mockResolvedValue(undefined);
    const h = harness(director, { verifyEvidence, persistEvidence });
    h.emit({
      agents: ['bug-hunter', 'security-scanner'],
      reportId: 'report-verified',
      bundle: {
        cwd: root,
        files: [{ path: 'changed.ts' }, { path: 'deleted.ts' }],
        cascadeDepth: 0,
        maxCascadeDepth: 2,
      },
      reviewText: 'review',
      severities: { critical: 0, high: 1, medium: 0 },
    });
    await h.wait();

    expect(verifyEvidence).toHaveBeenCalledWith(
      { typecheck: { command: 'pnpm typecheck', exitCode: 0 } },
      root,
      undefined,
      expect.any(Number),
    );
    expect(persistEvidence).toHaveBeenCalledWith(
      'report-verified',
      'verified',
      verification.checks,
    );
    const writes = JSON.stringify(h.session.append.mock.calls);
    expect(writes).toContain('spawn failed');
    expect(writes).toContain('re-reviewing 1 file');
  });

  it('persists failed evidence and skips re-review', async () => {
    const director = {
      spawn: vi.fn().mockResolvedValue('agent-1'),
      assign: vi.fn().mockResolvedValue(undefined),
      awaitTasks: vi.fn().mockResolvedValue([
        {
          status: 'success',
          result:
            'fixed\n```json\n{"verification_evidence":{"typecheck":{"command":"pnpm typecheck","exitCode":0}}}\n```',
        },
      ]),
      terminate: vi.fn().mockResolvedValue(undefined),
    };
    const checks = [
      {
        name: 'typecheck' as const,
        command: 'pnpm typecheck',
        claimedExitCode: 0,
        actualExitCode: 1,
        ok: false,
      },
    ];
    const persistEvidence = vi.fn().mockResolvedValue(undefined);
    const h = harness(director, {
      verifyEvidence: vi.fn().mockResolvedValue({ status: 'failed', checks, summary: 'failed' }),
      persistEvidence,
    });
    h.emit({
      agents: ['bug-hunter'],
      reportId: 'report-failed',
      bundle: { cwd: 'D:/repo', files: [], cascadeDepth: 0, maxCascadeDepth: 2 },
      reviewText: 'review',
      severities: { critical: 0, high: 1, medium: 0 },
    });
    await h.wait();

    expect(persistEvidence).toHaveBeenCalledWith('report-failed', 'failed', checks);
    expect(h.events.emitCustom).not.toHaveBeenCalled();
    expect(JSON.stringify(h.session.append.mock.calls)).toContain('skipping re-review');
  });

  it('continues verified re-review when evidence persistence fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chimera-cascade-persist-'));
    roots.push(root);
    await writeFile(join(root, 'changed.ts'), 'changed');
    const director = {
      spawn: vi.fn().mockResolvedValue('agent-1'),
      assign: vi.fn().mockResolvedValue(undefined),
      awaitTasks: vi.fn().mockResolvedValue([
        {
          status: 'success',
          result:
            'fixed\n```json\n{"verification_evidence":{"typecheck":{"command":"pnpm typecheck","exitCode":0}}}\n```',
        },
      ]),
      terminate: vi.fn().mockResolvedValue(undefined),
    };
    const checks = [
      {
        name: 'typecheck' as const,
        command: 'pnpm typecheck',
        claimedExitCode: 0,
        actualExitCode: 0,
        ok: true,
      },
    ];
    const h = harness(director, {
      verifyEvidence: vi.fn().mockResolvedValue({ status: 'verified', checks }),
      persistEvidence: vi.fn().mockRejectedValue(new Error('store unavailable')),
    });
    h.emit({
      agents: ['bug-hunter'],
      reportId: 'report-persist-failed',
      bundle: {
        cwd: root,
        files: [{ path: 'changed.ts' }],
        cascadeDepth: 0,
        maxCascadeDepth: 2,
      },
      reviewText: 'review',
      severities: { critical: 0, high: 1, medium: 0 },
    });
    await h.wait();

    expect(h.events.emitCustom).toHaveBeenCalledWith(
      'chimera.review_needed',
      expect.objectContaining({ evidenceStatus: 'verified', evidenceChecks: checks }),
    );
    expect(JSON.stringify(h.session.append.mock.calls)).toContain('store unavailable');
  });

  it('persists missing evidence and skips re-review without running commands', async () => {
    const director = {
      spawn: vi.fn().mockResolvedValue('agent-1'),
      assign: vi.fn().mockResolvedValue(undefined),
      awaitTasks: vi
        .fn()
        .mockResolvedValue([{ status: 'success', result: 'fixed without evidence' }]),
      terminate: vi.fn().mockResolvedValue(undefined),
    };
    const verifyEvidence = vi.fn();
    const persistEvidence = vi.fn().mockResolvedValue(undefined);
    const h = harness(director, { verifyEvidence, persistEvidence });
    h.emit({
      agents: ['bug-hunter'],
      reportId: 'report-missing',
      bundle: { cwd: 'D:/repo', files: [], cascadeDepth: 0, maxCascadeDepth: 2 },
      reviewText: 'review',
      severities: { critical: 0, high: 1, medium: 0 },
    });
    await h.wait();

    expect(verifyEvidence).not.toHaveBeenCalled();
    expect(persistEvidence).toHaveBeenCalledWith('report-missing', 'missing', []);
    expect(h.events.emitCustom).not.toHaveBeenCalled();
    expect(JSON.stringify(h.session.append.mock.calls)).toContain('evidence missing');
  });
});
