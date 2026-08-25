import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChimeraWorkRegistry } from '../src/chimera-work-registry.js';
import { finalizeExecutionCleanup } from '../src/execution-cleanup.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function session(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    pendingToolUses: [],
    append: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function cleanupInput(overrides: Record<string, unknown> = {}) {
  const startupSession = session('startup');
  const result = {
    offStorageObservability: vi.fn(),
    fleetStatusLine: { stop: vi.fn() },
    onCoordinatorStop: vi.fn(),
    stats: { render: vi.fn() },
    renderer: {},
    detachTodosCheckpoint: vi.fn().mockResolvedValue(undefined),
    mcpRegistry: { stopAll: vi.fn().mockResolvedValue(undefined) },
    agent: { ctx: { session: undefined } },
    session: startupSession,
    tokenCounter: { total: vi.fn().mockReturnValue({ input: 10, output: 2 }) },
    events: { emit: vi.fn() },
    reader: { close: vi.fn().mockResolvedValue(undefined) },
    ...overrides,
  };
  return { result, startupSession };
}

describe('finalizeExecutionCleanup', () => {
  it('runs the full cleanup sequence and finalizes the current resumed session', async () => {
    const active = session('resumed', { pendingToolUses: [{ id: 'tool-1' }] });
    const chimeraWork = { drainAndClose: vi.fn().mockResolvedValue(undefined) };
    const director = {
      requestFinish: vi.fn().mockReturnValue(0),
      terminateAll: vi.fn().mockResolvedValue(undefined),
    };
    const { result, startupSession } = cleanupInput({
      agent: { ctx: { session: active } },
      chimeraWork,
      director,
    });

    await finalizeExecutionCleanup(result as never);

    expect(result.offStorageObservability).toHaveBeenCalledOnce();
    expect(result.fleetStatusLine.stop).toHaveBeenCalledOnce();
    expect(result.onCoordinatorStop).toHaveBeenCalledOnce();
    expect(result.stats.render).toHaveBeenCalledWith(result.renderer);
    expect(result.detachTodosCheckpoint).toHaveBeenCalledOnce();
    expect(result.mcpRegistry.stopAll).toHaveBeenCalledOnce();
    expect(startupSession.append).not.toHaveBeenCalled();
    expect(active.append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'session_end',
        pendingToolUses: [{ id: 'tool-1' }],
      }),
    );
    expect(result.events.emit).toHaveBeenCalledWith(
      'session.ended',
      expect.objectContaining({ id: 'resumed' }),
    );
    expect(chimeraWork.drainAndClose).toHaveBeenCalledOnce();
    expect(director.requestFinish).toHaveBeenCalledWith(
      'leader session ended — finish your review now',
    );
    expect(director.terminateAll).toHaveBeenCalledOnce();
    expect(active.close).toHaveBeenCalledOnce();
    expect(result.reader.close).toHaveBeenCalledOnce();
  });

  it('keeps the session open until every overlapping Chimera review settles', async () => {
    let finishFirst!: () => void;
    let finishSecond!: () => void;
    const first = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const second = new Promise<void>((resolve) => {
      finishSecond = resolve;
    });
    const registry = createChimeraWorkRegistry();
    registry.track(first);
    registry.track(second);
    let signalDrainStarted!: () => void;
    const drainStarted = new Promise<void>((resolve) => {
      signalDrainStarted = resolve;
    });
    const chimeraWork = {
      drainAndClose: vi.fn(() => {
        signalDrainStarted();
        return registry.drainAndClose();
      }),
    };
    const active = session('active');
    const { result } = cleanupInput({
      agent: { ctx: { session: active } },
      chimeraWork,
    });

    const cleanup = finalizeExecutionCleanup(result as never);
    finishSecond();
    const phase = await Promise.race([
      cleanup.then(() => 'closed' as const),
      drainStarted.then(() => 'draining' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 1_000)),
    ]);
    expect(phase).toBe('draining');
    expect(active.close).not.toHaveBeenCalled();

    finishFirst();
    await cleanup;
    expect(active.close).toHaveBeenCalledOnce();
  });

  it('waits for delayed session-end producers before draining Chimera work and closing', async () => {
    const order: string[] = [];
    let releaseProducer!: () => void;
    const producer = new Promise<void>((resolve) => {
      releaseProducer = () => {
        order.push('producer');
        resolve();
      };
    });
    const active = session('active', {
      close: vi.fn(async () => {
        order.push('close');
      }),
    });
    let producerRegistered = false;
    const events = {
      emit: vi.fn((_name: string, payload: { waitUntil?: (work: Promise<void>) => void }) => {
        payload.waitUntil?.(producer);
        producerRegistered = true;
      }),
    };
    const chimeraWork = {
      drainAndClose: vi.fn(async () => {
        order.push('drain');
      }),
    };
    const { result } = cleanupInput({
      agent: { ctx: { session: active } },
      events,
      chimeraWork,
    });

    const cleanup = finalizeExecutionCleanup(result as never);
    await vi.waitFor(() => expect(producerRegistered).toBe(true));
    expect(chimeraWork.drainAndClose).not.toHaveBeenCalled();
    expect(active.close).not.toHaveBeenCalled();

    releaseProducer();
    await cleanup;

    expect(order).toEqual(['producer', 'drain', 'close']);
  });

  it('continues through every guarded cleanup failure', async () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const active = session('active', {
      append: vi.fn().mockRejectedValue('append failed'),
      close: vi.fn().mockRejectedValue(new Error('close failed')),
    });
    const { result } = cleanupInput({
      stats: {
        render: vi.fn(() => {
          throw new Error('render failed');
        }),
      },
      detachTodosCheckpoint: vi.fn().mockRejectedValue('detach failed'),
      mcpRegistry: { stopAll: vi.fn().mockRejectedValue('mcp failed') },
      agent: { ctx: { session: active } },
      chimeraWork: { drainAndClose: vi.fn().mockRejectedValue('chimera failed') },
      director: {
        requestFinish: vi.fn().mockReturnValue(0),
        terminateAll: vi.fn().mockRejectedValue('terminate failed'),
      },
      reader: { close: vi.fn().mockRejectedValue('reader failed') },
    });

    await expect(finalizeExecutionCleanup(result as never)).resolves.toBeUndefined();

    expect(result.events.emit).toHaveBeenCalled();
    expect(warnings).toHaveBeenCalledTimes(7);
    const warningText = warnings.mock.calls.flat().join(' ');
    expect(warningText).toContain('shutdown.wrongtrace_telemetry_skipped');
    expect(warningText).toContain('shutdown.mcp_stop_failed');
    expect(warningText).toContain('shutdown.session_end_append_failed');
    expect(warningText).toContain('shutdown.chimera_work_failed');
    expect(warningText).toContain('shutdown.director_terminate_all_failed');
    expect(warningText).toContain('shutdown.session_close_failed');
    expect(warningText).toContain('shutdown.reader_close_failed');
  });
});
