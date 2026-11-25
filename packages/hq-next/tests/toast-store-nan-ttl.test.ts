import { describe, expect, it } from 'vitest';
import { useToastStore } from '../src/hq/data/toast-store.js';

describe('useToastStore non-finite and overflow ttlMs (F1872)', () => {
  it('preserves 0 as sticky, defaults NaN/negative/Infinity to 6000, and caps overflow', () => {
    const seenDelays: number[] = [];
    const origSetTimeout = globalThis.setTimeout;
    (globalThis as { setTimeout: typeof setTimeout }).setTimeout = ((
      fn: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) => {
      seenDelays.push(delay as number);
      return origSetTimeout(fn, 60_000, ...args);
    }) as typeof setTimeout;

    try {
      useToastStore.getState().clearToasts();
      useToastStore.getState().addToast('sticky', 'info', 0);
      useToastStore.getState().addToast('nan', 'info', Number.NaN);
      useToastStore.getState().addToast('neg', 'info', -100);
      useToastStore.getState().addToast('inf', 'info', Number.POSITIVE_INFINITY);
      useToastStore.getState().addToast('huge', 'info', 5_000_000_000);

      const toasts = useToastStore.getState().toasts;
      expect(toasts.find((t) => t.message === 'sticky')?.ttlMs).toBe(0);
      expect(toasts.find((t) => t.message === 'nan')?.ttlMs).toBe(6000);
      expect(toasts.find((t) => t.message === 'neg')?.ttlMs).toBe(6000);
      expect(toasts.find((t) => t.message === 'inf')?.ttlMs).toBe(6000);
      expect(toasts.find((t) => t.message === 'huge')?.ttlMs).toBe(2_147_483_647);
      expect(seenDelays).toEqual([6000, 6000, 6000, 2_147_483_647]);
    } finally {
      useToastStore.getState().clearToasts();
      globalThis.setTimeout = origSetTimeout;
    }
  });
});
