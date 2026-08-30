// @vitest-environment jsdom

import { render } from '@testing-library/react';
import type React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Action, State } from '../src/app-reducer.js';
import type { SessionInterruptController } from '../src/hooks/use-session-interrupt-controller.js';
import { useSessionInterruptController } from '../src/hooks/use-session-interrupt-controller.js';
import { createTestState } from './helpers/create-test-state.js';

// ── Helpers ──────────────────────────────────────────────────────────────

interface MockRefs {
  interruptController: SessionInterruptController;
  dispatch: ReturnType<typeof vi.fn>;
  stateRef: { current: State };
  activeCtrlRef: { current: AbortController | null };
  activeRunSettledRef: { current: Promise<void> };
  sessionGenerationRef: { current: number };
  streamingTextRef: { current: string };
  streamSegmentsRef: { current: Array<{ kind: 'assistant' | 'thinking'; text: string }> };
  pendingDeltaRef: { current: string };
  assistantCommittedThisRunRef: { current: boolean };
  flushTimerRef: { current: ReturnType<typeof setTimeout> | null };
  eternalLoopRunningRef: { current: boolean };
  parallelLoopRunningRef: { current: boolean };
  tokenPreviewsRef: { current: { clear: () => void } };
  clearPendingConfirms: () => void;
}

function buildRefs(status: State['status'] = 'idle'): MockRefs {
  const state = createTestState() as State;
  state.status = status;
  return {
    interruptController: { abortLeader: () => false },
    dispatch: vi.fn(),
    stateRef: { current: state },
    activeCtrlRef: { current: new AbortController() },
    activeRunSettledRef: { current: Promise.resolve() },
    sessionGenerationRef: { current: 0 },
    streamingTextRef: { current: 'partial assistant text' },
    streamSegmentsRef: {
      current: [
        { kind: 'assistant', text: 'hello ' },
        { kind: 'thinking', text: 'hmm' },
      ],
    },
    pendingDeltaRef: { current: 'unflushed delta' },
    assistantCommittedThisRunRef: { current: true },
    flushTimerRef: { current: null },
    eternalLoopRunningRef: { current: false },
    parallelLoopRunningRef: { current: false },
    tokenPreviewsRef: { current: { clear: vi.fn<() => void>() } },
    clearPendingConfirms: vi.fn<() => void>(),
  };
}

function Harness({ refs }: { refs: MockRefs }): React.ReactElement {
  useSessionInterruptController({
    interruptController: refs.interruptController,
    dispatch: refs.dispatch as (action: Action) => void,
    stateRef: refs.stateRef,
    activeCtrlRef: refs.activeCtrlRef,
    activeRunSettledRef: refs.activeRunSettledRef,
    sessionGenerationRef: refs.sessionGenerationRef,
    streamingTextRef: refs.streamingTextRef,
    streamSegmentsRef: refs.streamSegmentsRef,
    pendingDeltaRef: refs.pendingDeltaRef,
    assistantCommittedThisRunRef: refs.assistantCommittedThisRunRef,
    flushTimerRef: refs.flushTimerRef,
    eternalLoopRunningRef: refs.eternalLoopRunningRef,
    parallelLoopRunningRef: refs.parallelLoopRunningRef,
    tokenPreviewsRef: refs.tokenPreviewsRef,
    clearPendingConfirms: refs.clearPendingConfirms,
    getEternalEngine: undefined,
    getParallelEngine: undefined,
    getSddRun: undefined,
    switchAutonomy: undefined,
  });
  return <span />;
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('useSessionInterruptController', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('abortLeader', () => {
    it('clears streaming refs when status is not idle', () => {
      const refs = buildRefs('running');
      const view = render(<Harness refs={refs} />);

      const interrupted = refs.interruptController.abortLeader?.();
      expect(interrupted).toBe(true);

      // Streaming refs must be cleared immediately — the abort prevents
      // provider.response from firing, so the normal turn-boundary
      // cleanup in use-provider-event-bridge won't run.
      expect(refs.streamingTextRef.current).toBe('');
      expect(refs.streamSegmentsRef.current).toEqual([]);
      expect(refs.pendingDeltaRef.current).toBe('');
      expect(refs.flushTimerRef.current).toBeNull();

      // AbortController must have been aborted.
      expect(refs.activeCtrlRef.current?.signal.aborted).toBe(true);

      // Must dispatch streamReset and 'aborting' status.
      expect(refs.dispatch).toHaveBeenCalledWith({ type: 'streamReset' });
      expect(refs.dispatch).toHaveBeenCalledWith({ type: 'status', status: 'aborting' });

      view.unmount();
    });

    it('clears a pending flush timer on abort', () => {
      const refs = buildRefs('running');
      const timer = setTimeout(() => {}, 60_000);
      refs.flushTimerRef.current = timer;
      const view = render(<Harness refs={refs} />);

      refs.interruptController.abortLeader?.();

      expect(refs.flushTimerRef.current).toBeNull();
      // The timer was cleared, not just nulled.
      // (If it weren't cleared, it would fire after the test — vitest
      // would report an open handle or the callback would throw.)

      view.unmount();
    });

    it('does not clear streaming refs when status is idle', () => {
      const refs = buildRefs('idle');
      const view = render(<Harness refs={refs} />);

      const interrupted = refs.interruptController.abortLeader?.();
      expect(interrupted).toBe(false);

      // Refs must be untouched — no active run to interrupt.
      expect(refs.streamingTextRef.current).toBe('partial assistant text');
      expect(refs.streamSegmentsRef.current).toHaveLength(2);
      expect(refs.pendingDeltaRef.current).toBe('unflushed delta');

      view.unmount();
    });
  });

  describe('resetSession', () => {
    it('clears all streaming refs and token previews', () => {
      const refs = buildRefs('idle');
      const view = render(<Harness refs={refs} />);

      refs.interruptController.resetSession?.();

      expect(refs.streamingTextRef.current).toBe('');
      expect(refs.streamSegmentsRef.current).toEqual([]);
      expect(refs.pendingDeltaRef.current).toBe('');
      expect(refs.assistantCommittedThisRunRef.current).toBe(false);
      expect(refs.flushTimerRef.current).toBeNull();
      expect(refs.tokenPreviewsRef.current.clear).toHaveBeenCalledTimes(1);

      view.unmount();
    });

    it('bumps session generation', () => {
      const refs = buildRefs('idle');
      refs.sessionGenerationRef.current = 5;
      const view = render(<Harness refs={refs} />);

      refs.interruptController.resetSession?.();

      expect(refs.sessionGenerationRef.current).toBe(6);

      view.unmount();
    });

    it('dispatches streamReset, toolStreamClear, and queueClear', () => {
      const refs = buildRefs('idle');
      const view = render(<Harness refs={refs} />);

      refs.interruptController.resetSession?.();

      const types = refs.dispatch.mock.calls.map((c: unknown[]) => (c[0] as Action).type);
      expect(types).toContain('streamReset');
      expect(types).toContain('toolStreamClear');
      expect(types).toContain('queueClear');

      view.unmount();
    });

    it('clears pending confirms', () => {
      const refs = buildRefs('idle');
      const view = render(<Harness refs={refs} />);

      refs.interruptController.resetSession?.();

      expect(refs.clearPendingConfirms).toHaveBeenCalledTimes(1);

      view.unmount();
    });
  });

  describe('teardown', () => {
    it('neuters abortLeader and resetSession on unmount', () => {
      const refs = buildRefs('running');
      const view = render(<Harness refs={refs} />);

      // Verify they work before unmount.
      expect(refs.interruptController.abortLeader?.()).toBe(true);

      view.unmount();

      // After unmount, abortLeader returns false (neutered).
      expect(refs.interruptController.abortLeader?.()).toBe(false);
      // resetSession is a no-op.
      refs.interruptController.resetSession?.();
      // No additional dispatches after unmount.
      const callCount = refs.dispatch.mock.calls.length;
      refs.interruptController.resetSession?.();
      expect(refs.dispatch.mock.calls.length).toBe(callCount);
    });
  });
});
