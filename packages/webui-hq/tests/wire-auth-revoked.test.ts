// @vitest-environment jsdom
/**
 * W4 #15 — the decision point behind `hq.auth_revoked`.
 *
 * This is the branch that is easiest to get wrong in a way nothing else
 * catches. The server broadcasts the frame to EVERY open browser socket
 * before its watcher closes only the affected ones, so receiving the frame
 * proves nothing about THIS tab. The payload carries server-side token
 * verifiers, which the client cannot match against its own raw token.
 *
 * So the only honest signal is behavioural: re-mint our own credential and
 * see whether it still works. The tests below pin both directions, because
 * the dangerous failure is the FALSE POSITIVE — telling a still-authorized
 * operator their token was revoked because a *different* browser's was.
 *
 * @module tests/wire-auth-revoked
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const upgradeStoredTokenToCookie = vi.fn();
const clearHqToken = vi.fn();
const hasAuthenticatedHqBrowserSession = vi.fn();

// The HTTP client boots an auth-store side effect at module scope; stub it so
// importing the wire module stays inert.
vi.mock('../src/data/api.js', () => ({ fetchJson: vi.fn() }));
vi.mock('../src/data/auth/index.js', () => ({
  upgradeStoredTokenToCookie,
  clearHqToken,
  hasAuthenticatedHqBrowserSession,
}));

const { applySocketMessage } = await import('../src/data/wire.js');
const { useHqStore } = await import('../src/data/store/index.js');

/** Flush the `.then()` the handler chains onto the re-mint promise. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('applySocketMessage hq.auth_revoked (W4 #15)', () => {
  beforeEach(() => {
    useHqStore.setState({ authRevoked: false });
    upgradeStoredTokenToCookie.mockReset();
    clearHqToken.mockReset();
    hasAuthenticatedHqBrowserSession.mockReset();
    hasAuthenticatedHqBrowserSession.mockResolvedValue(false);
  });

  it('says NOTHING when this browser re-mints — a different browser was revoked', async () => {
    // The capture case: another operator's token was revoked, ours is live.
    upgradeStoredTokenToCookie.mockResolvedValue(true);

    applySocketMessage(useHqStore, {
      type: 'hq.auth_revoked',
      revokedTokenKeys: ['verifier-belonging-to-someone-else'],
    });
    await flush();

    expect(upgradeStoredTokenToCookie).toHaveBeenCalled();
    // The load-bearing assertions: no credential cleared, no accusation made.
    expect(clearHqToken).not.toHaveBeenCalled();
    expect(useHqStore.getState().authRevoked).toBe(false);
  });

  it('clears the dead credential and raises the gate when the re-mint fails', async () => {
    upgradeStoredTokenToCookie.mockResolvedValue(false);

    applySocketMessage(useHqStore, {
      type: 'hq.auth_revoked',
      revokedTokenKeys: ['verifier-belonging-to-us'],
    });
    await flush();

    expect(clearHqToken).toHaveBeenCalled();
    expect(useHqStore.getState().authRevoked).toBe(true);
  });

  it('keeps a password/mobile session signed in: it has no stored token to re-mint', async () => {
    // Password login deliberately clears the stored token, so the re-mint
    // fails immediately — yet the cookie session a token revocation cannot
    // touch is still valid. Signing this operator out was the false positive.
    upgradeStoredTokenToCookie.mockResolvedValue(false);
    hasAuthenticatedHqBrowserSession.mockResolvedValue(true);

    applySocketMessage(useHqStore, {
      type: 'hq.auth_revoked',
      revokedTokenKeys: ['verifier-belonging-to-someone-else'],
    });
    await flush();

    expect(hasAuthenticatedHqBrowserSession).toHaveBeenCalled();
    expect(clearHqToken).not.toHaveBeenCalled();
    expect(useHqStore.getState().authRevoked).toBe(false);
  });

  it('does not raise the gate before the re-mint resolves', () => {
    // A never-settling re-mint must not pre-emptively accuse anyone — the
    // verdict has to come from the attempt, not from the frame's arrival.
    upgradeStoredTokenToCookie.mockReturnValue(new Promise(() => {}));

    applySocketMessage(useHqStore, {
      type: 'hq.auth_revoked',
      revokedTokenKeys: ['verifier-unknown'],
    });

    expect(useHqStore.getState().authRevoked).toBe(false);
    expect(clearHqToken).not.toHaveBeenCalled();
  });
});
