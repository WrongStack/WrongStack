// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { EventBus } from '@wrongstack/contracts/kernel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createFailedRunTracker,
  FAILED_RUN_CONTINUE_PROMPT,
} from '../src/hooks/failed-run-tracker.js';
import {
  selectAutoProceedCandidate,
  useNextStepsAutoSubmit,
} from '../src/hooks/use-next-steps-auto-submit.js';
import { createTestState } from './helpers/create-test-state.js';

type Emit = (name: string, payload: unknown) => void;
const emitter = (events: EventBus): Emit => (events.emit as unknown as Emit).bind(events);

/** One leader run: started, a provider failure, and its end. */
function failRun(emit: Emit, opts: { retryable: boolean; sessionId?: string }) {
  const sessionId = opts.sessionId ?? 'leader';
  emit('agent.run.started', { sessionId, ctx: {}, model: 'm', at: '' });
  emit('provider.error', {
    sessionId,
    providerId: 'p',
    status: opts.retryable ? 529 : 400,
    description: 'boom',
    retryable: opts.retryable,
  });
  emit('agent.run.completed', {
    sessionId,
    ctx: {},
    status: 'failed',
    iterations: 1,
    at: '',
    durationMs: 1,
  });
}

describe('createFailedRunTracker', () => {
  it('holds a run that failed on a retryable provider error, until consumed', () => {
    const events = new EventBus();
    const tracker = createFailedRunTracker(events, () => 'leader');
    failRun(emitter(events), { retryable: true });
    expect(tracker.pending()).toBe(true);
    expect(tracker.consume()).toBe(true);
    expect(tracker.pending()).toBe(false);
    tracker.dispose();
  });

  it('ignores non-retryable failures, recovered calls, subagents and new runs', () => {
    const events = new EventBus();
    const emit = emitter(events);
    const tracker = createFailedRunTracker(events, () => 'leader');

    failRun(emit, { retryable: false });
    expect(tracker.pending()).toBe(false);

    // The fallback chain found a working model: the run failed for another reason.
    emit('agent.run.started', { sessionId: 'leader', ctx: {}, model: 'm', at: '' });
    emit('provider.error', {
      sessionId: 'leader',
      providerId: 'p',
      status: 529,
      description: 'x',
      retryable: true,
    });
    emit('provider.response', {
      sessionId: 'leader',
      ctx: {},
      model: 'm2',
      usage: {},
      stopReason: 'end_turn',
    });
    emit('agent.run.completed', {
      sessionId: 'leader',
      ctx: {},
      status: 'failed',
      iterations: 1,
      at: '',
      durationMs: 1,
    });
    expect(tracker.pending()).toBe(false);

    failRun(emit, { retryable: true, sessionId: 'subagent-7' });
    expect(tracker.pending()).toBe(false);

    failRun(emit, { retryable: true });
    emit('agent.run.started', { sessionId: 'leader', ctx: {}, model: 'm', at: '' });
    expect(tracker.pending()).toBe(false);
    tracker.dispose();
  });
});

describe('selectAutoProceedCandidate: failed run', () => {
  it('is the last resort, after todos and suggestions', () => {
    expect(selectAutoProceedCandidate({ failedRun: true })).toMatchObject({
      source: 'failed-run',
      prompt: FAILED_RUN_CONTINUE_PROMPT,
    });
    expect(
      selectAutoProceedCandidate({ failedRun: true, suggestions: ['Run the tests'] })?.source,
    ).toBe('suggestion');
    expect(
      selectAutoProceedCandidate({
        failedRun: true,
        todos: [{ id: 't', content: 'Finish it', status: 'in_progress' }],
      })?.source,
    ).toBe('todo');
    expect(selectAutoProceedCandidate({})).toBeNull();
  });
});

describe('useNextStepsAutoSubmit: a run an API error killed', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(autonomy: 'auto' | 'off') {
    const events = new EventBus();
    const runBlocks = vi.fn(async (_blocks: unknown) => undefined);
    const dispatch = vi.fn();
    // Everything but the state is stable across renders, as in the app: the
    // callbacks are effect dependencies, and the agent keys the tracker.
    const stable = {
      autonomyLive: autonomy,
      agent: { ctx: { todos: [], session: { id: 'leader' } }, events } as never,
      getAutonomy: () => autonomy,
      getSettings: () => ({ delayMs: 0, autoProceedMaxIterations: 0 }) as never,
      getSuggestions: () => [],
      getAutoSuggestions: () => [],
      getYolo: () => false,
      setSuggestions: vi.fn(),
      autonomyNextPrompt: undefined,
      dispatch,
      clearDraft: vi.fn(),
      runBlocksRef: { current: runBlocks },
    };
    const options = (status: 'idle' | 'running'): Parameters<typeof useNextStepsAutoSubmit>[0] => ({
      ...stable,
      state: createTestState({ status }),
    });
    const hook = renderHook(
      ({ status }: { status: 'idle' | 'running' }) => useNextStepsAutoSubmit(options(status)),
      { initialProps: { status: 'idle' as 'idle' | 'running' } },
    );
    return { emit: emitter(events), runBlocks, dispatch, hook };
  }

  // Small steps: each timer (the idle re-check, the countdown interval) is
  // armed by an effect that only runs after the previous step's act() flushes.
  const tick = async (ms: number) => {
    for (let elapsed = 0; elapsed < ms; elapsed += 250) {
      await act(async () => {
        vi.advanceTimersByTime(250);
        await Promise.resolve();
      });
    }
  };

  it('continues once in auto mode, then halts when the retry dies the same way', async () => {
    const { emit, runBlocks, dispatch, hook } = setup('auto');
    failRun(emit, { retryable: true });
    await tick(3_000);
    expect(runBlocks).toHaveBeenCalledTimes(1);
    expect(runBlocks.mock.calls[0]?.[0]).toEqual([
      { type: 'text', text: FAILED_RUN_CONTINUE_PROMPT },
    ]);

    // The retry runs (running → idle) and dies the same way.
    hook.rerender({ status: 'running' });
    failRun(emit, { retryable: true });
    hook.rerender({ status: 'idle' });
    await tick(3_000);
    expect(runBlocks).toHaveBeenCalledTimes(1);
    const warned = dispatch.mock.calls
      .map(([action]) => action as { entry?: { kind: string; text: string } })
      .some((a) => a.entry?.kind === 'warn' && a.entry.text.includes('API error again'));
    expect(warned).toBe(true);
    hook.unmount();
  });

  it('does nothing for a non-retryable failure, or outside auto mode', async () => {
    const auto = setup('auto');
    failRun(auto.emit, { retryable: false });
    await tick(3_000);
    expect(auto.runBlocks).not.toHaveBeenCalled();
    auto.hook.unmount();

    const off = setup('off');
    failRun(off.emit, { retryable: true });
    await tick(3_000);
    expect(off.runBlocks).not.toHaveBeenCalled();
    off.hook.unmount();
  });
});
