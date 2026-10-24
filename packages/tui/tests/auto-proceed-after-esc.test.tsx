// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { EventBus } from '@wrongstack/contracts/kernel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useNextStepsAutoSubmit } from '../src/hooks/use-next-steps-auto-submit.js';
import { createTestState } from './helpers/create-test-state.js';

/**
 * Esc (or /steer) stops the leader and waits for the user's new direction:
 * `steeringPending` stays set until their next message. An open todo must not
 * restart the run on a countdown in between — that overrides the stop.
 */
describe('auto-proceed after the user stopped the run', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(steeringPending: boolean) {
    const runBlocks = vi.fn(async (_blocks: unknown) => undefined);
    const stable = {
      autonomyLive: 'auto' as const,
      agent: {
        ctx: {
          todos: [{ id: 't1', content: 'Finish the parser', status: 'in_progress' }],
          session: { id: 'leader' },
        },
        events: new EventBus(),
      } as never,
      getAutonomy: () => 'auto' as const,
      getSettings: () => ({ delayMs: 0, autoProceedMaxIterations: 0 }) as never,
      getSuggestions: () => [],
      getAutoSuggestions: () => [],
      getYolo: () => false,
      setSuggestions: vi.fn(),
      autonomyNextPrompt: undefined,
      dispatch: vi.fn(),
      clearDraft: vi.fn(),
      runBlocksRef: { current: runBlocks },
    };
    const hook = renderHook(
      ({ pending }: { pending: boolean }) =>
        useNextStepsAutoSubmit({
          ...stable,
          state: createTestState({ status: 'idle', steeringPending: pending }),
        }),
      { initialProps: { pending: steeringPending } },
    );
    return { runBlocks, hook };
  }

  const tick = async (ms: number) => {
    for (let elapsed = 0; elapsed < ms; elapsed += 250) {
      await act(async () => {
        vi.advanceTimersByTime(250);
        await Promise.resolve();
      });
    }
  };

  it('continues an open todo when nothing stopped the run', async () => {
    const { runBlocks, hook } = setup(false);
    await tick(3_000);
    expect(runBlocks).toHaveBeenCalledTimes(1);
    hook.unmount();
  });

  it('waits for the user after Esc, however long', async () => {
    const { runBlocks, hook } = setup(true);
    await tick(10_000);
    expect(runBlocks).not.toHaveBeenCalled();
    hook.unmount();
  });
});
