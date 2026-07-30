import type { Config } from '@wrongstack/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRuntimeLifecycleDeps } from '../src/wiring/runtime-lifecycle-deps.js';

const suggestionMocks = vi.hoisted(() => ({
  getSuggestions: vi.fn(),
  setSuggestions: vi.fn(),
}));
const sddMocks = vi.hoisted(() => ({
  applySddLifecycle: vi.fn(),
}));

vi.mock('../src/services/suggestion-store.js', () => suggestionMocks);
vi.mock('@wrongstack/sdd', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wrongstack/sdd')>();
  return { ...actual, applySddLifecycle: sddMocks.applySddLifecycle };
});

function input(overrides: Record<string, unknown> = {}) {
  const provider = {
    complete: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'YES, proceed' }] }),
  };
  const active = { stop: vi.fn(), isRunning: vi.fn().mockReturnValue(false) };
  const result = {
    getConfig: () =>
      ({
        autonomy: { autoProceedDelayMs: 123, autoProceedMaxIterations: 7 },
      }) as Config,
    context: { model: 'model', provider },
    getCurrentSuggestions: vi.fn().mockReturnValue(['local']),
    setCurrentSuggestions: vi.fn(),
    getEternalEngine: vi.fn().mockReturnValue(null),
    getParallelEngine: vi.fn().mockReturnValue(null),
    sddRunRegistry: { getActive: vi.fn().mockReturnValue(active) },
    projectRoot: 'D:/repo',
    paths: {
      projectSpecs: 'specs',
      projectTaskGraphs: 'graphs',
      projectSddSession: 'session',
      projectSddBoards: 'boards',
    },
    eternalListeners: new Set(),
    stageListeners: new Set(),
    runSageSessionHygiene: vi.fn().mockResolvedValue(undefined),
    pluginHost: { dispose: vi.fn().mockResolvedValue(undefined) },
    teardownHandlers: [vi.fn()],
    stats: { destroy: vi.fn() },
    events: {},
    logger: { warn: vi.fn() },
    ...overrides,
  };
  return { result, provider, active };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('createRuntimeLifecycleDeps', () => {
  it('synchronizes suggestions and validates safe auto-proceed responses', async () => {
    const { result, provider } = input();
    suggestionMocks.getSuggestions.mockReturnValue([]);
    const deps = createRuntimeLifecycleDeps(result as never);

    deps.onSuggestionsParsed?.(['first']);
    expect(result.setCurrentSuggestions).toHaveBeenCalledWith(['first']);
    expect(suggestionMocks.setSuggestions).toHaveBeenCalledWith(['first']);
    expect(deps.getSuggestions?.()).toEqual(['local']);
    suggestionMocks.getSuggestions.mockReturnValue(['shared']);
    expect(deps.getSuggestions?.()).toEqual(['shared']);
    expect(deps.autoProceedDelayMs).toBe(123);
    expect(deps.autoProceedMaxIterations).toBe(7);
    await expect(deps.onValidateAutoProceed?.('continue', 'recent output')).resolves.toBe(true);

    provider.complete.mockResolvedValueOnce({ content: [{ type: 'text', text: 'NO' }] });
    await expect(deps.onValidateAutoProceed?.('unsafe', '')).resolves.toBe(false);
    provider.complete.mockRejectedValueOnce(new Error('provider down'));
    await expect(deps.onValidateAutoProceed?.('unknown', '')).resolves.toBe(false);
  });

  it('subscribes, unsubscribes, and applies SDD lifecycle safeguards', async () => {
    const { result, active } = input();
    const deps = createRuntimeLifecycleDeps(result as never);
    const eternal = vi.fn();
    const stage = vi.fn();
    const offEternal = deps.subscribeEternalIteration?.(eternal);
    const offStage = deps.subscribeEternalStage?.(stage);
    expect(result.eternalListeners.has(eternal)).toBe(true);
    expect(result.stageListeners.has(stage)).toBe(true);
    offEternal?.();
    offStage?.();
    expect(result.eternalListeners.size).toBe(0);
    expect(result.stageListeners.size).toBe(0);

    active.isRunning.mockReturnValueOnce(true);
    await expect(deps.onSddLifecycle?.('rollback')).resolves.toMatchObject({ ok: false });
    await deps.onSddLifecycle?.('destroy');
    expect(active.stop).toHaveBeenCalledOnce();
    sddMocks.applySddLifecycle.mockResolvedValueOnce({ op: 'destroy', ok: true });
    await deps.onSddLifecycle?.('destroy', { revertMerged: true });
    expect(sddMocks.applySddLifecycle).toHaveBeenCalledWith(
      'destroy',
      expect.objectContaining({ projectRoot: 'D:/repo', revertMerged: true }),
    );
  });

  it('runs every cleanup and reports rejected best-effort cleanup', async () => {
    const hygiene = vi.fn().mockRejectedValue('hygiene failed');
    const dispose = vi.fn().mockRejectedValue(new Error('dispose failed'));
    const teardown = vi.fn();
    const { result } = input({
      runSageSessionHygiene: hygiene,
      pluginHost: { dispose },
      teardownHandlers: [teardown],
    });
    const deps = createRuntimeLifecycleDeps(result as never);

    deps.onDestroy?.();
    await new Promise((resolve) => setImmediate(resolve));

    expect(teardown).toHaveBeenCalledOnce();
    expect(result.stats.destroy).toHaveBeenCalledWith(result.events);
    expect(result.logger.warn).toHaveBeenCalledTimes(2);
  });
});
