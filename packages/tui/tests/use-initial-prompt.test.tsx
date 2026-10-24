// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import type { ContentBlock } from '@wrongstack/contracts/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useInitialPrompt } from '../src/hooks/use-initial-prompt.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe('useInitialPrompt lifecycle', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('cancels the delayed boot injection when unmounted before the banner delay', async () => {
    const builder = {
      appendText: vi.fn(),
      submit: vi.fn(async (): Promise<ContentBlock[]> => []),
    };
    const runBlocks = vi.fn(async () => undefined);
    const dispatch = vi.fn();
    const { unmount } = renderHook(() =>
      useInitialPrompt({
        initialGoal: undefined,
        initialAsk: 'run after startup',
        builderRef: { current: builder } as never,
        runBlocksRef: { current: runBlocks },
        dispatch,
      }),
    );

    unmount();
    await act(async () => {
      vi.advanceTimersByTime(50);
      await Promise.resolve();
    });

    expect(dispatch).not.toHaveBeenCalled();
    expect(builder.appendText).not.toHaveBeenCalled();
    expect(builder.submit).not.toHaveBeenCalled();
    expect(runBlocks).not.toHaveBeenCalled();
  });

  it('does not start a run when builder submission settles after unmount', async () => {
    const submitted = deferred<ContentBlock[]>();
    const builder = {
      appendText: vi.fn(),
      submit: vi.fn(() => submitted.promise),
    };
    const runBlocks = vi.fn(async () => undefined);
    const dispatch = vi.fn();
    const { unmount } = renderHook(() =>
      useInitialPrompt({
        initialGoal: undefined,
        initialAsk: 'submit once',
        builderRef: { current: builder } as never,
        runBlocksRef: { current: runBlocks },
        dispatch,
      }),
    );

    await act(async () => {
      vi.advanceTimersByTime(50);
      await Promise.resolve();
    });
    expect(builder.submit).toHaveBeenCalledOnce();

    unmount();
    submitted.resolve([{ type: 'text', text: 'submit once' }]);
    await Promise.resolve();
    await Promise.resolve();

    expect(runBlocks).not.toHaveBeenCalled();
  });
});
