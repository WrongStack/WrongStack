import React from 'react';
import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EventBus } from '@wrongstack/core/kernel';
import type { TokenCounter } from '@wrongstack/core/types';
import { Text } from '../src/ink.js';
import {
  snapshotTokenCounter,
  useTokenCounterRefresh,
} from '../src/hooks/use-token-counter-refresh.js';

function fakeTokenCounter(): TokenCounter {
  return {
    account: () => undefined,
    setCurrentRequestTokens: () => undefined,
    currentRequestTokens: () => ({ input: 123, cacheRead: 45, cacheWrite: 6 }),
    total: () => ({ input: 1234, output: 567, cacheRead: 89, cacheWrite: 10 }),
    estimateCost: () => ({ input: 0.0123, output: 0.0456, total: 0.0579, currency: 'USD' }),
    cacheStats: () => ({ readTokens: 89, writeTokens: 10, hitRatio: 0.0672 }) as never,
    reset: () => undefined,
  };
}

function noopEventBus(): EventBus {
  return {
    on: vi.fn(() => vi.fn()),
    emit: vi.fn(),
    off: vi.fn(),
    once: vi.fn(),
    listeners: vi.fn(() => []),
    removeAllListeners: vi.fn(),
  } as unknown as EventBus;
}

describe('snapshotTokenCounter', () => {
  it('reads live token, cost, and cache totals from the provided counter', () => {
    expect(snapshotTokenCounter(fakeTokenCounter())).toEqual({
      usage: { input: 1234, output: 567, cacheRead: 89, cacheWrite: 10 },
      currentRequest: { input: 123, cacheRead: 45, cacheWrite: 6 },
      cost: { input: 0.0123, output: 0.0456, total: 0.0579, currency: 'USD' },
      cacheStats: { readTokens: 89, writeTokens: 10, hitRatio: 0.0672 },
    });
  });
});

describe('useTokenCounterRefresh', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns undefined when tokenCounter is undefined', () => {
    let result: unknown;
    function Harness(): React.ReactElement {
      result = useTokenCounterRefresh(undefined, noopEventBus());
      return React.createElement(Text, null, 'test');
    }
    render(React.createElement(Harness));
    expect(result).toBeUndefined();
  });

  it('returns initial snapshot when tokenCounter is provided', () => {
    let result: unknown;
    function Harness(): React.ReactElement {
      result = useTokenCounterRefresh(fakeTokenCounter(), noopEventBus());
      return React.createElement(Text, null, 'test');
    }
    render(React.createElement(Harness));
    expect(result).toBeDefined();
    expect((result as Record<string, unknown>).usage).toBeDefined();
  });

  it('subscribes to events and cleans up on unmount', () => {
    const off = vi.fn();
    const events = {
      on: vi.fn(() => off),
    } as unknown as EventBus;

    function Harness(): React.ReactElement {
      useTokenCounterRefresh(fakeTokenCounter(), events);
      return React.createElement(Text, null, 'test');
    }
    const view = render(React.createElement(Harness));
    expect(events.on).toHaveBeenCalledWith('token.accounted', expect.any(Function));

    view.unmount();
    expect(off).toHaveBeenCalled();
  });

  it('does not subscribe when events is undefined', () => {
    let result: unknown;
    function Harness(): React.ReactElement {
      result = useTokenCounterRefresh(fakeTokenCounter(), undefined);
      return React.createElement(Text, null, 'test');
    }
    render(React.createElement(Harness));
    expect(result).toBeDefined();
  });

  it('handles tokenCounter without events gracefully', () => {
    let result: unknown;
    function Harness(): React.ReactElement {
      result = useTokenCounterRefresh(fakeTokenCounter(), undefined);
      return React.createElement(Text, null, 'test');
    }
    render(React.createElement(Harness));
    expect(result).toBeDefined();
  });
});
