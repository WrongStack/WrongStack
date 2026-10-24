/**
 * W4 #15 (RFC hq-improvements-2026-09.md) — token revocation detection.
 *
 * The detector is pure set arithmetic, so these tests pin the subtraction
 * semantics directly rather than going through the watcher. The cases that
 * matter are the ones a naive `previous.size !== next.size` check would get
 * wrong: a swap (one token added, one removed) leaves the count identical
 * while a real revocation happened, and an added token must never be reported
 * as revoked.
 *
 * @module tests/hq/auth-revocation
 */

import { describe, expect, it } from 'vitest';
import { findRevokedTokenKeys, sessionAffectedByRevocation } from '../src/index.js';

describe('findRevokedTokenKeys (W4 #15)', () => {
  it('reports a key that is gone', () => {
    const revoked = findRevokedTokenKeys(new Set(['k1', 'k2']), new Set(['k1']));
    expect(revoked).toEqual(['k2']);
  });

  it('reports nothing when the live set is unchanged', () => {
    expect(findRevokedTokenKeys(new Set(['k1', 'k2']), new Set(['k1', 'k2']))).toEqual([]);
  });

  it('reports nothing when a token is ADDED', () => {
    expect(findRevokedTokenKeys(new Set(['k1']), new Set(['k1', 'k2']))).toEqual([]);
  });

  it('reports the removal when a token is swapped for another', () => {
    // The trap: same cardinality, but one real revocation. A size-based check
    // would report nothing and leave the revoked session alive.
    const revoked = findRevokedTokenKeys(new Set(['old']), new Set(['new']));
    expect(revoked).toEqual(['old']);
  });

  it('reports every key when the whole set is cleared', () => {
    const revoked = findRevokedTokenKeys(new Set(['k1', 'k2', 'k3']), new Set());
    expect(revoked).toEqual(['k1', 'k2', 'k3']);
  });

  it('reports nothing when going from empty to populated', () => {
    expect(findRevokedTokenKeys(new Set(), new Set(['k1']))).toEqual([]);
  });

  it('ignores an empty key rather than naming a token that never existed', () => {
    // `hqTokenKey` yields '' for a malformed entry; reporting '' as revoked
    // would put a meaningless value in the frame.
    const revoked = findRevokedTokenKeys(new Set(['', 'k1']), new Set());
    expect(revoked).toEqual(['k1']);
  });

  it('preserves the previous set order so the result is stable', () => {
    const revoked = findRevokedTokenKeys(new Set(['b', 'a', 'c']), new Set(['c']));
    expect(revoked).toEqual(['b', 'a']);
  });

  it('treats an expiry-driven drop as a revocation', () => {
    // The projection filters expired tokens out of BOTH sets, so a token that
    // simply aged out is indistinguishable from one revoked by hand — and from
    // the open socket's point of view it must be, because both require re-auth.
    const before = new Set(['still-valid', 'just-expired']);
    const after = new Set(['still-valid']);
    expect(findRevokedTokenKeys(before, after)).toEqual(['just-expired']);
  });
});

describe('sessionAffectedByRevocation (W4 #15)', () => {
  const revoked = new Set(['token-a']);

  it('evicts a token session minted from a revoked token', () => {
    expect(sessionAffectedByRevocation('token-a', revoked)).toBe(true);
  });

  it('leaves a session minted from a still-live token alone', () => {
    expect(sessionAffectedByRevocation('token-b', revoked)).toBe(false);
  });

  it('never evicts a password session, which no token revocation touches', () => {
    expect(sessionAffectedByRevocation(undefined, revoked)).toBe(false);
  });

  it('does not treat an empty id as a match', () => {
    expect(sessionAffectedByRevocation('', new Set(['']))).toBe(false);
  });
});
