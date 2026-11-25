import { describe, expect, it } from 'vitest';
import { useToastStore } from '../src/hq/data/toast-store';

describe('useToastStore sub-1ms ttlMs guard (F2272)', () => {
  it('falls back to default TTL for sub-1ms positive ttlMs instead of creating a sticky toast', () => {
    useToastStore.getState().clearToasts();
    useToastStore.getState().addToast('Brief notice', 'info', 0.5);
    const toast = useToastStore.getState().toasts[0];
    useToastStore.getState().clearToasts();
    expect(toast?.ttlMs).toBe(6_000);
  });
});
