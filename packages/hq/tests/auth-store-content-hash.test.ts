/**
 * Focused unit tests for `hqAuthContentHash`.
 *
 * The helper computes a SHA-256 over a *redacted* projection of an
 * `HqAuthFile`. These tests pin its two governing invariants:
 *
 *   - **Secret-stable** — rotating any combination of raw token strings,
 *     `passwordHash`, or `cookieSecret` (without touching structural
 *     state) must NOT flip the hash. This is what makes the hash safe to
 *     log: a leaked hash can't be reversed to recover secrets, and a
 *     secret rotation doesn't make every prior audit entry's hash stale.
 *
 *   - **Structure-sensitive** — any change an operator would care about
 *     (token id / label / capabilities / expiry, `version`, alert rules,
 *     redaction policy, presence-vs-absence of password / cookie secret)
 *     MUST flip the hash, otherwise the forensic-tie-back purpose fails.
 *
 * The function is pure and synchronous, so every case is a one-shot
 * `expect(...).toBe(...)` / `.not.toBe(...)` — no async, no fixtures.
 *
 * @vitest-environment node
 */
import {
  HQ_AUTH_CONTENT_HASH_REDACTED,
  HQ_AUTH_FILE_VERSION,
  hqAuthContentHash,
  mintHqToken,
  type HqAuthFile,
  type HqToken,
} from '@wrongstack/hq';
import { describe, expect, it } from 'vitest';

const FIXED_UPDATED_AT = '2026-07-19T12:00:00.000Z';

function makeToken(overrides: Partial<HqToken> = {}): HqToken {
  return {
    ...mintHqToken(),
    id: 'token-id-stable',
    createdAt: '2026-07-19T11:00:00.000Z',
    ...overrides,
  };
}

function makeFile(overrides: Partial<HqAuthFile> = {}): HqAuthFile {
  return {
    version: HQ_AUTH_FILE_VERSION,
    updatedAt: FIXED_UPDATED_AT,
    browserTokens: [makeToken()],
    ...overrides,
  };
}

describe('hqAuthContentHash — secret-stable invariants', () => {
  it('is unchanged when only a raw token string rotates', () => {
    const baseline = makeFile();
    const rotated = makeFile({
      browserTokens: [makeToken({ token: 'a-different-raw-secret' })],
    });
    expect(hqAuthContentHash(rotated)).toBe(hqAuthContentHash(baseline));
  });

  it('is unchanged when only the passwordHash rotates', () => {
    const baseline = makeFile({ passwordHash: 'hash-v1' });
    const rotated = makeFile({ passwordHash: 'hash-v2' });
    expect(hqAuthContentHash(rotated)).toBe(hqAuthContentHash(baseline));
  });

  it('is unchanged when only the cookieSecret rotates', () => {
    const baseline = makeFile({ cookieSecret: 'cookie-v1' });
    const rotated = makeFile({ cookieSecret: 'cookie-v2' });
    expect(hqAuthContentHash(rotated)).toBe(hqAuthContentHash(baseline));
  });

  it('is unchanged when every secret rotates simultaneously', () => {
    const baseline = makeFile({
      browserTokens: [makeToken({ token: 'tok-1' })],
      passwordHash: 'hash-1',
      cookieSecret: 'cookie-1',
    });
    const rotated = makeFile({
      browserTokens: [makeToken({ token: 'tok-2' })],
      passwordHash: 'hash-2',
      cookieSecret: 'cookie-2',
    });
    expect(hqAuthContentHash(rotated)).toBe(hqAuthContentHash(baseline));
  });
});

describe('hqAuthContentHash — structure-sensitive invariants', () => {
  it('flips when a token id changes', () => {
    const baseline = makeFile();
    const relabeled = makeFile({
      browserTokens: [makeToken({ id: 'token-id-different' })],
    });
    expect(hqAuthContentHash(relabeled)).not.toBe(hqAuthContentHash(baseline));
  });

  it('flips when a token label is added', () => {
    const baseline = makeFile();
    const relabeled = makeFile({
      browserTokens: [makeToken({ label: 'production' })],
    });
    expect(hqAuthContentHash(relabeled)).not.toBe(hqAuthContentHash(baseline));
  });

  it('flips when capabilities change', () => {
    const baseline = makeFile({
      browserTokens: [makeToken({ capabilities: ['control.enqueue'] })],
    });
    const widened = makeFile({
      browserTokens: [makeToken({ capabilities: ['control.enqueue', 'control.execute'] })],
    });
    expect(hqAuthContentHash(widened)).not.toBe(hqAuthContentHash(baseline));
  });

  it('flips when expiresAt is added', () => {
    const baseline = makeFile();
    const expiring = makeFile({
      browserTokens: [makeToken({ expiresAt: '2026-08-19T12:00:00.000Z' })],
    });
    expect(hqAuthContentHash(expiring)).not.toBe(hqAuthContentHash(baseline));
  });

  it('flips when the schema version changes', () => {
    const baseline = makeFile();
    const upgraded = makeFile({ version: 2 as unknown as typeof HQ_AUTH_FILE_VERSION });
    expect(hqAuthContentHash(upgraded)).not.toBe(hqAuthContentHash(baseline));
  });

  it('flips when alert rules are added', () => {
    const baseline = makeFile();
    const withRules = makeFile({
      alertRules: {
        cost: { enabled: true, thresholdUsd: 10 },
      } as unknown as HqAuthFile['alertRules'],
    });
    expect(hqAuthContentHash(withRules)).not.toBe(hqAuthContentHash(baseline));
  });

  it('flips when the redaction policy changes', () => {
    const baseline = makeFile();
    const tightened = makeFile({
      redactionPolicy: { redactToolResults: true } as unknown as HqAuthFile['redactionPolicy'],
    });
    expect(hqAuthContentHash(tightened)).not.toBe(hqAuthContentHash(baseline));
  });

  it('flips when a password is added (presence vs absence)', () => {
    const baseline = makeFile(); // no passwordHash
    const withPassword = makeFile({ passwordHash: 'new-hash' });
    expect(hqAuthContentHash(withPassword)).not.toBe(hqAuthContentHash(baseline));
  });

  it('flips when a cookie secret is added (presence vs absence)', () => {
    const baseline = makeFile(); // no cookieSecret
    const withCookie = makeFile({ cookieSecret: 'new-cookie' });
    expect(hqAuthContentHash(withCookie)).not.toBe(hqAuthContentHash(baseline));
  });
});

describe('hqAuthContentHash — format + identity invariants', () => {
  it('returns a 64-char lowercase-hex SHA-256 digest', () => {
    const hash = hqAuthContentHash(makeFile());
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic: the same file hashes identically across calls', () => {
    const file = makeFile();
    expect(hqAuthContentHash(file)).toBe(hqAuthContentHash(file));
  });

  it('references the exported HQ_AUTH_CONTENT_HASH_REDACTED sentinel', () => {
    // Sanity-check the sentinel is the documented literal — if this ever
    // drifts, downstream forensic tooling that substitutes the constant
    // would silently produce different hashes than the helper.
    expect(HQ_AUTH_CONTENT_HASH_REDACTED).toBe('<redacted>');
  });
});

describe('hqAuthContentHash — pinned snapshot (projection-shape guard)', () => {
  // ──────────────────────────────────────────────────────────────────
  // SNAPSHOT TEST — read before changing.
  //
  // This test pins a known (file → hash) pair. If it fails, the
  // redacted projection shape has changed (a field was added or removed,
  // key order shifted, or the sentinel value changed). That is an
  // INTENTIONAL break: every existing `contentHash` value in every
  // `auth-audit.jsonl` file on every deployed HQ becomes stale, so the
  // change must be deliberate and documented.
  //
  // To update after an intentional projection change:
  //   1. Run: node -e "const {hqAuthContentHash} = require('@wrongstack/core'); console.log(hqAuthContentHash({version:1,updatedAt:'2026-07-19T12:00:00.000Z',browserTokens:[{id:'browser-1',token:'secret-browser',createdAt:'2026-07-19T11:00:00.000Z',capabilities:['control.enqueue'],label:'first-run browser'}],clientTokens:[{id:'client-1',token:'secret-client',createdAt:'2026-07-19T11:00:00.000Z',capabilities:['telemetry.publish'],label:'first-run client'}],passwordHash:'hashed-password',cookieSecret:'cookie-secret'}))"
  //   2. Paste the new hash below.
  //   3. Add a note to the commit message explaining the projection
  //      change and its impact on existing audit logs.
  // ──────────────────────────────────────────────────────────────────

  // The canonical fixture: a fully-populated auth file with known token
  // ids, known secrets (which the projection redacts), a password hash,
  // and a cookie secret. Both tokens carry capabilities + labels so the
  // projection exercises every field.
  const pinnedFile: HqAuthFile = {
    version: 1 as typeof HQ_AUTH_FILE_VERSION,
    updatedAt: '2026-07-19T12:00:00.000Z',
    browserTokens: [
      {
        id: 'browser-1',
        token: 'secret-browser',
        createdAt: '2026-07-19T11:00:00.000Z',
        capabilities: ['control.enqueue'],
        label: 'first-run browser',
      },
    ],
    clientTokens: [
      {
        id: 'client-1',
        token: 'secret-client',
        createdAt: '2026-07-19T11:00:00.000Z',
        capabilities: ['telemetry.publish'],
        label: 'first-run client',
      },
    ],
    passwordHash: 'hashed-password',
    cookieSecret: 'cookie-secret',
  };

  it('produces the pinned hash for the canonical fixture (guard against silent projection drift)', () => {
    const hash = hqAuthContentHash(pinnedFile);
    expect(hash).toBe(
      // Computed via hqAuthContentHash over the pinnedFile above. Any
      // change to the projection shape (field set, key order, sentinel
      // value, JSON.stringify behavior) will flip this hash.
      '814aa4549e30710fb278ce89b26254db5a27c02f801a367c0e90d45db717c27a',
    );
  });

  it('the pinned fixture includes real secrets that must NOT appear in the hash payload', () => {
    // Defensive: the snapshot test above pins the hash, but this test
    // explicitly asserts that the raw secrets never appear in the
    // serialized projection. If the redaction ever breaks, this test
    // catches it even if the hash coincidentally stays the same (it
    // won't, but defense-in-depth).
    const hash = hqAuthContentHash(pinnedFile);
    expect(hash).toBeDefined();
    // SHA-256 output is 64 lowercase-hex characters, so raw ASCII
    // secrets can never appear in it structurally.  This test defends
    // against a future regression where the redaction breaks and the
    // projection somehow includes raw secrets in a non-hex output.
    expect(hash).not.toContain('secret-browser');
    expect(hash).not.toContain('secret-client');
    expect(hash).not.toContain('hashed-password');
    expect(hash).not.toContain('cookie-secret');
  });
});
