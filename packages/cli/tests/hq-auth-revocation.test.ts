/**
 * W4 #15 (RFC hq-improvements-2026-09.md) — browser-eviction path.
 *
 * `createHqAuthState` is the single projection choke point for `auth.json`, so
 * this suite pins the one thing the WS layer depends on: an `apply` that drops
 * a browser token reports exactly the dropped keys and their ids, and an
 * `apply` that does not drop one reports nothing at all.
 *
 * The "reports nothing" cases carry the weight here. A callback that fired on
 * every reload would close every operator's dashboard whenever anyone minted a
 * token, so the negative cases are the ones guarding real behaviour — not
 * padding around the positive one.
 *
 * @module tests/hq-auth-revocation
 */

import { emptyHqAuthFile, type HqAuthFile, type HqToken, hqTokenKey } from '@wrongstack/hq';
import { describe, expect, it, vi } from 'vitest';
import { createHqAuthState } from '../src/hq-server/auth-state.js';

/** A browser token as it appears in `auth.json` after WS-044: verifier only. */
function browserToken(id: string, verifier: string): HqToken {
  return { id, verifier, token: '', createdAt: '2026-09-13T00:00:00.000Z' };
}

function fileWithBrowserTokens(browserTokens: readonly HqToken[]): HqAuthFile {
  return { ...emptyHqAuthFile(), browserTokens: [...browserTokens] };
}

function stateFor(browserTokens: readonly HqToken[]) {
  const onTokensRevoked = vi.fn();
  const state = createHqAuthState(fileWithBrowserTokens(browserTokens), '/tmp/hq-w4-15-test', {
    onTokensRevoked,
  });
  return { state, onTokensRevoked };
}

describe('auth-state revocation reporting (W4 #15)', () => {
  it('reports the key and id of a revoked browser token', () => {
    const revokedKey = hqTokenKey(browserToken('id-b', 'verifier-b'));
    const { state, onTokensRevoked } = stateFor([
      browserToken('id-a', 'verifier-a'),
      browserToken('id-b', 'verifier-b'),
    ]);

    state.apply(fileWithBrowserTokens([browserToken('id-a', 'verifier-a')]));

    expect(onTokensRevoked).toHaveBeenCalledTimes(1);
    // `id-b` is the one that went away; `id-a` is still live and must not be
    // named, or the server would evict an operator who is still authorized.
    expect(onTokensRevoked).toHaveBeenCalledWith([revokedKey], ['id-b']);
  });

  it('reports nothing when a reload leaves the token set unchanged', () => {
    const { state, onTokensRevoked } = stateFor([browserToken('id-a', 'verifier-a')]);

    state.apply(fileWithBrowserTokens([browserToken('id-a', 'verifier-a')]));

    expect(onTokensRevoked).not.toHaveBeenCalled();
  });

  it('reports nothing when a token is ADDED', () => {
    // The case that must not log everyone out: minting a new credential
    // reloads auth.json exactly like revoking one does.
    const { state, onTokensRevoked } = stateFor([browserToken('id-a', 'verifier-a')]);

    state.apply(
      fileWithBrowserTokens([
        browserToken('id-a', 'verifier-a'),
        browserToken('id-b', 'verifier-b'),
      ]),
    );

    expect(onTokensRevoked).not.toHaveBeenCalled();
  });

  it('reports the removal when one token is swapped for another', () => {
    // Same cardinality, so a size-based guard would stay silent and leave the
    // revoked session authenticated.
    const { state, onTokensRevoked } = stateFor([browserToken('id-old', 'verifier-old')]);

    state.apply(fileWithBrowserTokens([browserToken('id-new', 'verifier-new')]));

    expect(onTokensRevoked).toHaveBeenCalledWith(
      [hqTokenKey(browserToken('id-old', 'verifier-old'))],
      ['id-old'],
    );
  });

  it('reports every token when the whole set is cleared', () => {
    const { state, onTokensRevoked } = stateFor([
      browserToken('id-a', 'verifier-a'),
      browserToken('id-b', 'verifier-b'),
    ]);

    state.apply(fileWithBrowserTokens([]));

    expect(onTokensRevoked).toHaveBeenCalledTimes(1);
    const [keys, ids] = onTokensRevoked.mock.calls[0] as [string[], string[]];
    expect(new Set(keys)).toEqual(
      new Set([
        hqTokenKey(browserToken('id-a', 'verifier-a')),
        hqTokenKey(browserToken('id-b', 'verifier-b')),
      ]),
    );
    expect(new Set(ids)).toEqual(new Set(['id-a', 'id-b']));
  });

  it('does not touch the live projection before reporting', () => {
    // The revocation is read before `projectAuthFile` runs, so the reported id
    // comes from the pre-reload map. If the order were reversed the id lookup
    // would miss and the server would have keys but nobody to evict.
    const { state, onTokensRevoked } = stateFor([browserToken('id-a', 'verifier-a')]);

    state.apply(fileWithBrowserTokens([]));

    const [, ids] = onTokensRevoked.mock.calls[0] as [string[], string[]];
    expect(ids).toEqual(['id-a']);
    expect(state.mutableAuth.browserTokens.size).toBe(0);
  });
});
