/**
 * Which browser sockets an auth change must close.
 *
 * The HQ server binds every open browser socket to the session that authorized
 * it, then closes only the sockets whose OWN session died. Before that binding
 * existed, any revocation closed EVERY browser — so revoking one operator's
 * token logged out every other operator too.
 *
 * The predicate is deliberately asymmetric: a socket with no recorded session
 * authenticated with a bare `?token=` rather than a cookie session, so it can
 * never be proven safe and is closed. Failing closed here reproduces the
 * pre-binding behaviour exactly, which is the right direction for a predicate
 * that decides whether to drop an authenticated connection.
 *
 * @module tests/hq/browser-socket-close
 */
import { describe, expect, it } from 'vitest';
import { shouldCloseBrowserSocket } from '../src/index.js';

describe('shouldCloseBrowserSocket', () => {
  it('closes the socket whose own session was revoked', () => {
    expect(shouldCloseBrowserSocket('session-1', new Set(['session-1']))).toBe(true);
  });

  it('leaves a socket alone when a DIFFERENT session was revoked', () => {
    // The assertion the pre-binding code could not pass: it closed all.
    expect(shouldCloseBrowserSocket('session-2', new Set(['session-1']))).toBe(false);
  });

  it('leaves a bound socket alone when nothing was revoked', () => {
    expect(shouldCloseBrowserSocket('session-1', new Set())).toBe(false);
  });

  it('closes an unbound socket, which cannot be matched to a surviving session', () => {
    expect(shouldCloseBrowserSocket(undefined, new Set(['session-1']))).toBe(true);
  });

  it('closes an unbound socket even when the revoked set is empty', () => {
    // Not "affected because something was revoked" — unbound is never safe.
    expect(shouldCloseBrowserSocket(undefined, new Set())).toBe(true);
  });

  it('treats an empty session id as unbound rather than as a match', () => {
    expect(shouldCloseBrowserSocket('', new Set(['']))).toBe(true);
  });

  it('handles a multi-session revocation, sparing the sessions in between', () => {
    const revoked = new Set(['session-1', 'session-3']);
    expect(shouldCloseBrowserSocket('session-1', revoked)).toBe(true);
    expect(shouldCloseBrowserSocket('session-2', revoked)).toBe(false);
    expect(shouldCloseBrowserSocket('session-3', revoked)).toBe(true);
  });
});
