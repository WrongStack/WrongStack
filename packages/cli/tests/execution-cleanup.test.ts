import { afterEach, describe, expect, it, vi } from 'vitest';
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
    const pendingWork = vi.fn().mockResolvedValue(undefined);
    const director = { terminateAll: vi.fn().mockResolvedValue(undefined) };
    const { result, startupSession } = cleanupInput({
      agent: { ctx: { session: active } },
      getPendingChimeraWork: () => pendingWork(),
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
    expect(pendingWork).toHaveBeenCalledOnce();
    expect(director.terminateAll).toHaveBeenCalledOnce();
    expect(active.close).toHaveBeenCalledOnce();
    expect(result.reader.close).toHaveBeenCalledOnce();
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
      getPendingChimeraWork: () => Promise.reject('chimera failed'),
      director: { terminateAll: vi.fn().mockRejectedValue('terminate failed') },
      reader: { close: vi.fn().mockRejectedValue('reader failed') },
    });

    await expect(finalizeExecutionCleanup(result as never)).resolves.toBeUndefined();

    expect(result.events.emit).toHaveBeenCalled();
    expect(warnings).toHaveBeenCalledTimes(6);
    const warningText = warnings.mock.calls.flat().join(' ');
    expect(warningText).toContain('shutdown.mcp_stop_failed');
    expect(warningText).toContain('shutdown.session_end_append_failed');
    expect(warningText).toContain('shutdown.chimera_work_failed');
    expect(warningText).toContain('shutdown.director_terminate_all_failed');
    expect(warningText).toContain('shutdown.session_close_failed');
    expect(warningText).toContain('shutdown.reader_close_failed');
  });
});
