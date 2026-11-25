import { describe, expect, it } from 'vitest';
import { providerSignal } from '../src/runtime/host-state.js';

describe('providerSignal non-AbortSignal guard (F2254)', () => {
  it('falls back to host abort signal when context.signal is not an AbortSignal', () => {
    const abort = new AbortController();
    const sig = providerSignal({ abort, extensionUnregister: null }, { signal: 'not-a-signal' });
    expect(sig).toBe(abort.signal);
  });
});
