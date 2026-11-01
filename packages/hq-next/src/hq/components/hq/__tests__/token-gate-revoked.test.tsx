// @vitest-environment jsdom
/**
 * W4 #15 — the operator-visible half of token-revoked broadcast.
 *
 * The server sends `hq.auth_revoked`, then closes the socket. Before this the
 * two cases — "your credential was revoked" and "the network blipped" — looked
 * identical: a bare disconnect and an endless "reconnecting…". The operator's
 * only recourse was to guess.
 *
 * These tests pin the rendering contract only: with the flag raised the gate
 * must say WHY, and with it clear it must stay silent (a false accusation on
 * every ordinary reconnect would be worse than the original silence).
 *
 * The store contract is pinned separately in `tests/auth-revoked.test.ts`; the
 * transport's call site lives in `data/wire.ts`.
 *
 * @module components/hq/__tests__/token-gate-revoked
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useHqStore } from '../../../data/store/index.js';
import { TokenGate } from '../token-gate.js';

/** Mode payload that renders `TokenForm` directly (no password tab). */
const TOKEN_ONLY_STATUS = { tokenMode: true, passwordMode: false };

describe('TokenGate revoked notice (W4 #15)', () => {
  beforeEach(() => {
    useHqStore.setState({ authRevoked: false });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => TOKEN_ONLY_STATUS,
      })),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('explains that a revocation — not a network fault — ended the session', async () => {
    useHqStore.setState({ authRevoked: true });

    render(<TokenGate hadToken={false} />);

    await waitFor(() => {
      expect(screen.getByText(/token was revoked by an operator/i)).toBeTruthy();
    });
  });

  it('stays silent on an ordinary visit, so a reconnect is never a false accusation', async () => {
    render(<TokenGate hadToken={false} />);

    // Wait for the auth-status probe to settle, so the gate is past its
    // loading state and this asserts on the real render, not a placeholder.
    await waitFor(() => {
      expect(screen.queryByText(/Checking auth mode/i)).toBeNull();
    });
    expect(screen.queryByText(/token was revoked by an operator/i)).toBeNull();
  });

  it('surfaces the remedy, not just the cause — the operator cannot self-serve a token', async () => {
    useHqStore.setState({ authRevoked: true });

    render(<TokenGate hadToken={false} />);

    await waitFor(() => {
      expect(screen.getByText(/Ask them for a new token/i)).toBeTruthy();
    });
  });
});
