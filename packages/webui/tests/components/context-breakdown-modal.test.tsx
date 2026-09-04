import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextBreakdownModal } from '../../src/components/ContextBreakdownModal.js';
import { useSessionStore } from '../../src/stores/session-store.js';

/** Subscribed handlers keyed by message type. The production modal registers
 *  one handler for `context.debug` and never unsubscribes until unmount,
 *  so a plain map (test-only) mirrors the WS-client contract. */
type Handler = (msg: { type: string; payload?: unknown }) => void;
const handlers = new Map<string, Set<Handler>>();
const sendMock = vi.fn();

vi.mock('@/lib/ws-client', () => ({
  getWSClient: () => ({
    send: sendMock,
    on: (type: string, handler: Handler) => {
      let set = handlers.get(type);
      if (!set) {
        set = new Set();
        handlers.set(type, set);
      }
      set.add(handler);
      return () => set?.delete(handler);
    },
  }),
}));

/** Emit a `context.debug` payload to every registered subscriber. */
function emitContextDebug(payload: unknown) {
  const set = handlers.get('context.debug');
  if (!set) return;
  for (const h of set) h({ type: 'context.debug', payload });
}

beforeEach(() => {
  handlers.clear();
  sendMock.mockClear();
  // Force document.hidden = false so the visibility-gated polling path
  // actually fires in the test environment.
  Object.defineProperty(document, 'hidden', { value: false, configurable: true });
  useSessionStore.setState({ cacheStats: null });
});

afterEach(cleanup);

describe('ContextBreakdownModal', () => {
  it('renders MiniMax and Anthropic cache hit ratios from the live stats snapshot', async () => {
    useSessionStore.setState({
      cacheStats: {
        readTokens: 1100,
        writeTokens: 100,
        hitRatio: 0.6875,
        coverageTokens: 800,
        providers: [
          { provider: 'minimax', input: 200, cacheRead: 800, cacheWrite: 0, hitRatio: 0.8 },
          {
            provider: 'anthropic',
            input: 100,
            cacheRead: 300,
            cacheWrite: 100,
            hitRatio: 0.6,
          },
        ],
      },
      maxContext: 200_000,
    });
    render(<ContextBreakdownModal open={true} onClose={() => {}} />);
    await act(async () => {
      emitContextDebug({
        total: 1000,
        systemPrompt: 200,
        tools: { total: 300, count: 4, breakdown: [] },
        messages: { total: 500, count: 3, breakdown: [] },
      });
    });
    expect(screen.getByText('minimax')).toBeTruthy();
    expect(screen.getByText('80.0% hit')).toBeTruthy();
    expect(screen.getByText('anthropic')).toBeTruthy();
    expect(screen.getByText('60.0% hit')).toBeTruthy();
  });

  it('opens after initially rendering closed without changing the hook order', () => {
    const onClose = vi.fn();
    const { rerender } = render(<ContextBreakdownModal open={false} onClose={onClose} />);

    expect(screen.queryByRole('dialog')).toBeNull();

    expect(() => {
      rerender(<ContextBreakdownModal open={true} onClose={onClose} />);
    }).not.toThrow();

    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('requests a context.debug snapshot on open and then continues to poll', async () => {
    vi.useFakeTimers();
    try {
      const onClose = vi.fn();
      render(<ContextBreakdownModal open={true} onClose={onClose} />);

      // On open: one immediate request.
      expect(sendMock).toHaveBeenCalledTimes(1);
      expect(sendMock).toHaveBeenLastCalledWith(
        { type: 'context.debug' },
        { echoToChat: false, queueIfDisconnected: false },
      );

      // Each subsequent tick of the polling interval re-requests.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(sendMock).toHaveBeenCalledTimes(2);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(sendMock).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refreshes the modal content as new context.debug snapshots arrive', async () => {
    vi.useFakeTimers();
    try {
      const onClose = vi.fn();
      const { container } = render(<ContextBreakdownModal open={true} onClose={onClose} />);

      // First snapshot populates the breakdown.
      await act(async () => {
        emitContextDebug({
          total: 1000,
          systemPrompt: 200,
          tools: { total: 300, count: 4, breakdown: [] },
          messages: {
            total: 500,
            count: 3,
            breakdown: [
              { index: 0, role: 'user', tokens: 100, preview: 'hi' },
              { index: 1, role: 'assistant', tokens: 200, preview: 'hello' },
              { index: 2, role: 'tool', tokens: 200, preview: 'result' },
            ],
          },
        });
      });
      // The total label renders inside the token-allocation header. The
      // production formatter renders 1_000 as "1.0k", so we assert on
      // that suffix rather than the raw "1,000".
      expect(container.textContent).toContain('1.0k');

      // A subsequent snapshot overwrites the prior one — latest wins.
      await act(async () => {
        emitContextDebug({
          total: 2000,
          systemPrompt: 400,
          tools: { total: 600, count: 5, breakdown: [] },
          messages: { total: 1000, count: 6, breakdown: [] },
        });
      });
      expect(container.textContent).toContain('2.0k');
    } finally {
      vi.useRealTimers();
    }
  });

  it('pauses polling while the tab is hidden and resumes on visibility regain', async () => {
    vi.useFakeTimers();
    try {
      const onClose = vi.fn();
      render(<ContextBreakdownModal open={true} onClose={onClose} />);
      expect(sendMock).toHaveBeenCalledTimes(1);

      // Tab goes hidden — polling should NOT fire while hidden.
      Object.defineProperty(document, 'hidden', { value: true, configurable: true });
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6000);
      });
      // Only the initial request has fired — no interval ticks while hidden.
      expect(sendMock).toHaveBeenCalledTimes(1);

      // Tab becomes visible again — one catch-up request, then cadence resumes.
      Object.defineProperty(document, 'hidden', { value: false, configurable: true });
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      // The catch-up request fires synchronously inside the handler.
      expect(sendMock).toHaveBeenCalledTimes(2);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(sendMock).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops polling and unsubscribes when the modal closes', async () => {
    vi.useFakeTimers();
    try {
      const onClose = vi.fn();
      const { rerender } = render(<ContextBreakdownModal open={true} onClose={onClose} />);
      expect(sendMock).toHaveBeenCalledTimes(1);
      expect(handlers.get('context.debug')?.size ?? 0).toBe(1);

      // React 18 schedules passive-effect cleanups asynchronously — under
      // full-suite load the unsubscribe can land after a synchronous read.
      // Await the flush so this asserts the app contract (subscription gone,
      // no polling after close) rather than React's effect-flush timing.
      await act(async () => {
        rerender(<ContextBreakdownModal open={false} onClose={onClose} />);
      });
      // Subscription is gone — no further ticks should reach us.
      expect(handlers.get('context.debug')?.size ?? 0).toBe(0);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6000);
      });
      // Closing must not have queued any extra requests.
      expect(sendMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
