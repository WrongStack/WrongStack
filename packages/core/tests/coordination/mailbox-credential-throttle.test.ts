/**
 * WS-025 — `credential_verify` is no longer an unthrottled guessing oracle.
 *
 * The operation takes a `credentialId` and a `secret` and answers whether they
 * match, as often as it is asked, from every mailbox surface: the MCP admin
 * tool, the project IPC daemon, an in-process caller. The secret is 32 random
 * bytes so exhaustive search was never the threat — but an unbounded oracle
 * turns a weak, reused, or partially-leaked secret into a remotely exploitable
 * one, and burns CPU answering.
 */
import { describe, expect, it } from 'vitest';
import {
  CREDENTIAL_VERIFY_COOLDOWN_MS,
  CREDENTIAL_VERIFY_MAX_FAILURES,
  CREDENTIAL_VERIFY_WINDOW_MS,
  CredentialVerifyThrottle,
} from '../../src/coordination/mailbox-credential-throttle.js';

const ID = 'cred_abc';

describe('CredentialVerifyThrottle', () => {
  it('allows attempts until the failure limit is reached', () => {
    const throttle = new CredentialVerifyThrottle();
    for (let i = 0; i < CREDENTIAL_VERIFY_MAX_FAILURES - 1; i++) {
      expect(throttle.check(ID, 1000).allowed).toBe(true);
      throttle.recordFailure(ID, 1000);
    }
    expect(throttle.check(ID, 1000).allowed).toBe(true);
  });

  it('refuses further attempts once the limit is hit, and reports a retry delay', () => {
    const throttle = new CredentialVerifyThrottle();
    for (let i = 0; i < CREDENTIAL_VERIFY_MAX_FAILURES; i++) throttle.recordFailure(ID, 1000);

    const decision = throttle.check(ID, 1000);
    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterMs).toBe(CREDENTIAL_VERIFY_COOLDOWN_MS);
  });

  it('lets attempts resume after the cooldown', () => {
    const throttle = new CredentialVerifyThrottle();
    for (let i = 0; i < CREDENTIAL_VERIFY_MAX_FAILURES; i++) throttle.recordFailure(ID, 1000);
    expect(throttle.check(ID, 1000).allowed).toBe(false);
    expect(throttle.check(ID, 1000 + CREDENTIAL_VERIFY_COOLDOWN_MS + 1).allowed).toBe(true);
  });

  it('does not re-arm the cooldown immediately from the stale failure count', () => {
    const throttle = new CredentialVerifyThrottle();
    const start = 1000;
    for (let i = 0; i < CREDENTIAL_VERIFY_MAX_FAILURES; i++) throttle.recordFailure(ID, start);
    const after = start + CREDENTIAL_VERIFY_COOLDOWN_MS + 1;
    expect(throttle.check(ID, after).allowed).toBe(true);
    // One more failure must not instantly block again.
    throttle.recordFailure(ID, after);
    expect(throttle.check(ID, after).allowed).toBe(true);
  });

  it('forgets failures that fall outside the window', () => {
    const throttle = new CredentialVerifyThrottle();
    for (let i = 0; i < CREDENTIAL_VERIFY_MAX_FAILURES - 1; i++) throttle.recordFailure(ID, 1000);
    // A failure past the window starts a fresh count rather than tipping the
    // limit — slow, spread-out typos must not accumulate into a lockout.
    throttle.recordFailure(ID, 1000 + CREDENTIAL_VERIFY_WINDOW_MS + 1);
    expect(throttle.check(ID, 1000 + CREDENTIAL_VERIFY_WINDOW_MS + 1).allowed).toBe(true);
  });

  it('clears the counter on success so a legitimate holder is never stuck', () => {
    const throttle = new CredentialVerifyThrottle();
    for (let i = 0; i < CREDENTIAL_VERIFY_MAX_FAILURES - 1; i++) throttle.recordFailure(ID, 1000);
    throttle.recordSuccess(ID);
    for (let i = 0; i < CREDENTIAL_VERIFY_MAX_FAILURES - 1; i++) {
      throttle.recordFailure(ID, 1000);
      expect(throttle.check(ID, 1000).allowed).toBe(true);
    }
  });

  it('tracks credential ids independently', () => {
    const throttle = new CredentialVerifyThrottle();
    for (let i = 0; i < CREDENTIAL_VERIFY_MAX_FAILURES; i++) throttle.recordFailure(ID, 1000);
    expect(throttle.check(ID, 1000).allowed).toBe(false);
    expect(throttle.check('cred_other', 1000).allowed).toBe(true);
  });

  it('bounds how many ids it tracks — the id is caller-supplied', () => {
    const throttle = new CredentialVerifyThrottle();
    // Well past the internal cap. This must not grow without bound: an
    // attacker cycling fabricated ids would otherwise be a memory exhaustion
    // vector against the very thing that is supposed to limit them.
    for (let i = 0; i < 6000; i++) throttle.recordFailure(`cred_${i}`, 1000);
    // Still functional for a fresh id after the churn.
    for (let i = 0; i < CREDENTIAL_VERIFY_MAX_FAILURES; i++)
      throttle.recordFailure('cred_last', 1000);
    expect(throttle.check('cred_last', 1000).allowed).toBe(false);
  });
});
