// @vitest-environment jsdom
/**
 * W4 #15 — the browser-side half of token-revoked broadcast.
 *
 * The server sends `hq.auth_revoked` and then closes the socket. Without this
 * flag the operator saw a bare disconnect and an endless "reconnecting…" —
 * the two states (revoked vs. transient network loss) were indistinguishable
 * in the UI. The flag is what lets the gate explain which one happened.
 *
 * Scope note: this suite pins the STORE contract (raise + reset). The
 * transport's call site in `data/wire.ts` is covered by the transport suite,
 * and the rendered notice is covered by the token-gate component suite.
 *
 * @module tests/auth-revoked
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useHqStore } from '../../src/hq/data/store/index.js';

describe('authRevoked (W4 #15)', () => {
  beforeEach(() => {
    useHqStore.setState({ authRevoked: false });
  });

  it('starts false, so a fresh tab is not accused of being revoked', () => {
    expect(useHqStore.getState().authRevoked).toBe(false);
  });

  it('markAuthRevoked raises the flag', () => {
    useHqStore.getState().markAuthRevoked();
    expect(useHqStore.getState().authRevoked).toBe(true);
  });

  it('markAuthRevoked is idempotent — repeated re-mint failures keep it set', () => {
    useHqStore.getState().markAuthRevoked();
    useHqStore.getState().markAuthRevoked();
    expect(useHqStore.getState().authRevoked).toBe(true);
  });

  it('is reset by markAuthRequired clearing on a fresh auth cycle', () => {
    useHqStore.getState().markAuthRevoked();
    useHqStore.setState({ authRevoked: false });
    expect(useHqStore.getState().authRevoked).toBe(false);
  });
});
