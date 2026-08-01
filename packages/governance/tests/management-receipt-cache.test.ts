import { describe, expect, it } from 'vitest';
import {
  GovernanceManagementReceiptCache,
  type GovernanceServiceCredential,
  type GovernanceServiceResponse,
} from '../src/index.js';

const credential: GovernanceServiceCredential = {
  token: 'wsg_admin.0123456789abcdefghijklmnopqrstuvwxyzABCDEFG',
  projectId: 'project-1',
  clientId: 'admin-client',
};

const response: GovernanceServiceResponse = {
  ok: true,
  requestId: 'rotate-1',
  result: {
    type: 'capability_grant_revoked',
    grantId: 'grant-1',
    revoked: true,
  },
};

describe('governance management receipt cache', () => {
  it('replays only the same credential, request id, and canonical payload', () => {
    const cache = new GovernanceManagementReceiptCache();
    const input = {
      protocolVersion: 1,
      requestId: 'rotate-1',
      type: 'revoke_capability_grant',
      grantId: 'grant-1',
      reason: 'completed',
    };
    const reservation = cache.reserve({ input, credential });
    expect(reservation).not.toBeNull();
    if (!reservation) throw new Error('Expected a management receipt reservation.');
    cache.commit(reservation, response);

    expect(
      cache.lookup(
        {
          reason: 'completed',
          grantId: 'grant-1',
          type: 'revoke_capability_grant',
          requestId: 'rotate-1',
          protocolVersion: 1,
        },
        credential,
      ),
    ).toMatchObject({ kind: 'replay', response });
    expect(cache.lookup({ ...input, reason: 'different' }, credential)).toMatchObject({
      kind: 'conflict',
    });
    expect(cache.lookup(input, { ...credential, token: `${credential.token}tampered` })).toEqual({
      kind: 'miss',
    });
    expect(Object.isFrozen(response)).toBe(true);
    expect(Object.isFrozen(response.result)).toBe(true);
  });

  it('expires receipts and bounds reservations without evicting a live retry receipt', () => {
    let now = 100;
    const cache = new GovernanceManagementReceiptCache({
      now: () => now,
      ttlMs: 20,
      maxEntries: 1,
    });
    const firstInput = { requestId: 'first', type: 'issue_capability_grant' };
    const first = cache.reserve({ input: firstInput, credential });
    expect(first).not.toBeNull();
    expect(
      cache.reserve({
        input: { requestId: 'second', type: 'issue_capability_grant' },
        credential,
      }),
    ).toBeNull();
    if (!first) throw new Error('Expected the first management receipt reservation.');
    cache.commit(first, { ...response, requestId: 'first' });

    now = 120;
    expect(cache.lookup(firstInput, credential)).toEqual({ kind: 'miss' });
    expect(
      cache.reserve({
        input: { requestId: 'second', type: 'issue_capability_grant' },
        credential,
      }),
    ).not.toBeNull();
  });

  it('releases an uncommitted reservation for a failed mutation', () => {
    const cache = new GovernanceManagementReceiptCache({ maxEntries: 1 });
    const first = cache.reserve({
      input: { requestId: 'failed', type: 'rotate_capability_grant' },
      credential,
    });
    expect(first).not.toBeNull();
    if (!first) throw new Error('Expected the first management receipt reservation.');
    cache.release(first);

    expect(
      cache.reserve({
        input: { requestId: 'replacement', type: 'rotate_capability_grant' },
        credential,
      }),
    ).not.toBeNull();
  });

  it('fingerprints the wire form, not a separately-decoded form', () => {
    // The decode path produces a structuredClone of the raw wire payload, so
    // today `input` and `wireInput` share a fingerprint. This test pins the
    // contract: the stored fingerprint MUST be computed from `wireInput` when
    // one is supplied, so a future decoder that introduces a content-altering
    // normalization cannot cause legitimate retries to be reported as
    // "requestId already used" conflicts.
    const cache = new GovernanceManagementReceiptCache();
    const wire = {
      requestId: 'rot-1',
      type: 'rotate_capability_grant',
      grantId: 'g1',
      ttlMs: 1000,
    };
    // Build a "decoded" object whose fingerprint diverges from the wire form
    // (extra field, normalized field). This simulates a future decoder that
    // adds or drops a field while keeping the request semantically the same.
    const decoded = { ...wire, decodedAt: '2026-08-01T00:00:00.000Z' };
    const reservation = cache.reserve({ input: decoded, wireInput: wire, credential });
    expect(reservation).not.toBeNull();
    if (!reservation) throw new Error('Expected a management receipt reservation.');
    cache.commit(reservation, { ...response, requestId: 'rot-1' });

    // The stored fingerprint is derived from the wire form. Replay with the
    // wire form succeeds.
    expect(cache.lookup(wire, credential)).toMatchObject({ kind: 'replay' });
    // The decoded form (which has an extra field) conflicts — exactly the
    // behavior that protects the cache from a future decoder adding fields
    // that the raw wire form did not carry.
    expect(cache.lookup(decoded, credential)).toMatchObject({ kind: 'conflict' });
  });
});
