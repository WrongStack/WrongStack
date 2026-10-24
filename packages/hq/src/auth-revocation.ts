/**
 * W4 #15 (RFC hq-improvements-2026-09.md) — browser-token revocation detection.
 *
 * The HQ server live-reloads `auth.json` through {@link module:hq/auth-store}'s
 * watcher, so revoking a token takes effect on the *next* request that
 * presents it. A browser already holding an authenticated session never makes
 * that request — it sits on an open WebSocket — so a revoked operator kept a
 * working dashboard until the 30-minute idle eviction happened to catch it.
 *
 * Detecting the revocation is pure set arithmetic, deliberately kept free of
 * I/O and WebSocket knowledge so it can be tested exhaustively and reused by
 * any surface that needs to react. Deciding what to *do* about it (broadcast a
 * frame, close a socket) belongs to the caller.
 *
 * @module hq/auth-revocation
 */

/**
 * Token keys that were live before and are not live now — i.e. the operator
 * revoked them.
 *
 * Keyed on the stored verifier (`hqTokenKey`), which is what every live-token
 * set in HQ is keyed on, so a legacy cleartext file and a hashed one produce
 * the same answer for the same token.
 *
 * Expiry is NOT revocation-by-another-name here: an expired token is already
 * filtered out of both sets by the projection, so a token that simply aged out
 * also shows up as "revoked". That is the intended behaviour — from the open
 * socket's point of view the two are indistinguishable, and in both cases the
 * browser must re-authenticate.
 *
 * Order follows `previous`'s iteration order, so the result is stable for a
 * given pair of sets rather than dependent on hash seeding.
 */
export function findRevokedTokenKeys(
  previous: ReadonlySet<string>,
  next: ReadonlySet<string>,
): string[] {
  const revoked: string[] = [];
  for (const key of previous) {
    // An empty key is not a token: `hqTokenKey` returns '' for a malformed
    // entry, and reporting '' as revoked would name a token that never existed.
    if (key.length > 0 && !next.has(key)) revoked.push(key);
  }
  return revoked;
}

/**
 * True when the revocation touched a session minted from one of the revoked
 * keys.
 *
 * A session identifies its origin by token *id*, while the revoked set holds
 * token *keys*, so the caller supplies the key→id mapping. A session with no
 * originating id (a password session) is never evicted by a token revocation:
 * it was never authenticated by a token in the first place.
 */
export function sessionAffectedByRevocation(
  sessionTokenId: string | undefined,
  revokedTokenIds: ReadonlySet<string>,
): boolean {
  if (sessionTokenId === undefined || sessionTokenId.length === 0) return false;
  return revokedTokenIds.has(sessionTokenId);
}

/**
 * True when an open browser socket must be closed because the auth file
 * changed.
 *
 * A socket is bound at upgrade time to the session that authorized it, so only
 * sockets whose OWN session was revoked are closed — revoking one token no
 * longer logs out every operator.
 *
 * A socket with no recorded session authenticated with a bare `?token=` rather
 * than a cookie session. It cannot be matched to any surviving session, so it
 * is treated as affected: failing closed here reproduces the behaviour that
 * existed before the binding was recorded, which is the safe direction for a
 * predicate that decides whether to drop an authenticated connection.
 */
export function shouldCloseBrowserSocket(
  boundSessionId: string | undefined,
  revokedSessionIds: ReadonlySet<string>,
): boolean {
  if (boundSessionId === undefined || boundSessionId.length === 0) return true;
  return revokedSessionIds.has(boundSessionId);
}
