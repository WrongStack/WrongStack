import { EventBus } from '@wrongstack/contracts/kernel';
import type { Logger } from '@wrongstack/contracts/types';
import { expect, it, vi } from 'vitest';
import { createMCPServerOperationState } from '../src/operations.js';
import { scheduleRegistryReconnect } from '../src/registry-reconnect.js';

it('caps the scheduled reconnect delay after applying jitter', async () => {
  vi.useFakeTimers();
  const random = vi.spyOn(Math, 'random').mockReturnValue(0.95);
  const attemptReconnect = vi.fn(async () => {});
  const log: Logger = {
    level: 'error',
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: () => log,
  };
  try {
    scheduleRegistryReconnect({
      slot: {
        cfg: { name: 'fixture', transport: 'stdio', command: 'unused' },
        state: 'disconnected',
        toolNames: [],
        lazyTools: [],
        attempts: 0,
        reconnectCycles: 4,
        reconnectPending: false,
        lazy: false,
        lastUsed: 0,
        registeredLazy: false,
        operations: createMCPServerOperationState(),
      },
      events: new EventBus(),
      log,
      maxReconnectCycles: 5,
      baseReconnectDelayMs: 1_000,
      maxReconnectDelayMs: 10_000,
      recordReconnectExhausted() {},
      attemptReconnect,
    });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(attemptReconnect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(attemptReconnect).toHaveBeenCalledOnce();
  } finally {
    random.mockRestore();
    vi.useRealTimers();
  }
});
