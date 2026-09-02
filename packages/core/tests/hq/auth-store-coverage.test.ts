/**
 * Additional coverage for hq/auth-store.ts — pure token/TTL/capability
 * functions, content hashing, password hashing, and data-dir resolution.
 */
import { describe, expect, it } from 'vitest';
import {
  HQ_AUTH_CONTENT_HASH_REDACTED,
  HQ_AUTH_FILE_VERSION,
  type HqAuthFile,
  type HqToken,
  emptyHqAuthFile,
  hashHqPassword,
  hqAuthContentHash,
  hqAuthFilePath,
  hqRuntimeFilePath,
  isTokenExpired,
  mintHqToken,
  resolveHqDataDir,
  tokenHasCapability,
  verifyHqPassword,
} from '../../src/hq/auth-store.js';
import * as path from 'node:path';

// ── isTokenExpired ───────────────────────────────────────────────────────────

describe('isTokenExpired', () => {
  it('returns false for undefined token', () => {
    expect(isTokenExpired(undefined)).toBe(false);
  });

  it('returns false when expiresAt is absent', () => {
    expect(isTokenExpired({})).toBe(false);
  });

  it('returns false for unparseable expiresAt', () => {
    expect(isTokenExpired({ expiresAt: 'not-a-date' })).toBe(false);
  });

  it('returns true when expired', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(isTokenExpired({ expiresAt: past })).toBe(true);
  });

  it('returns false when not yet expired', () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(isTokenExpired({ expiresAt: future })).toBe(false);
  });

  it('clock skew shifts the effective expiry earlier', () => {
    // Token expires 15s in the future. With 10s skew, effective expiry
    // is 15s - 10s = 5s in the future → still valid.
    const future = new Date(Date.now() + 15_000).toISOString();
    expect(isTokenExpired({ expiresAt: future }, Date.now(), 10_000)).toBe(false);
    // Token expires 5s in the future. With 10s skew, effective expiry
    // is 5s - 10s = 5s in the PAST → expired.
    const nearFuture = new Date(Date.now() + 5_000).toISOString();
    expect(isTokenExpired({ expiresAt: nearFuture }, Date.now(), 10_000)).toBe(true);
  });

  it('accepts a custom "at" timestamp', () => {
    const at = Date.parse('2026-01-01T00:00:00Z');
    const expiresAt = '2026-01-01T01:00:00Z';
    expect(isTokenExpired({ expiresAt }, at)).toBe(false);
    expect(isTokenExpired({ expiresAt }, at + 7_200_000)).toBe(true);
  });
});

// ── tokenHasCapability ───────────────────────────────────────────────────────

describe('tokenHasCapability', () => {
  it('returns false for undefined token', () => {
    expect(tokenHasCapability(undefined, 'control.enqueue')).toBe(false);
  });

  it('returns true for unrestricted token (no capabilities field)', () => {
    const token: HqToken = { id: '1', token: 't', createdAt: new Date().toISOString() };
    expect(tokenHasCapability(token, 'anything')).toBe(true);
  });

  it('returns true when capability is listed', () => {
    const token: HqToken = {
      id: '1',
      token: 't',
      createdAt: new Date().toISOString(),
      capabilities: ['control.enqueue', 'telemetry.publish'],
    };
    expect(tokenHasCapability(token, 'control.enqueue')).toBe(true);
  });

  it('returns false when capability is not listed', () => {
    const token: HqToken = {
      id: '1',
      token: 't',
      createdAt: new Date().toISOString(),
      capabilities: ['control.enqueue'],
    };
    expect(tokenHasCapability(token, 'control.execute')).toBe(false);
  });

  it('returns false for expired token even with capability', () => {
    const token: HqToken = {
      id: '1',
      token: 't',
      createdAt: new Date().toISOString(),
      capabilities: ['control.enqueue'],
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    };
    expect(tokenHasCapability(token, 'control.enqueue')).toBe(false);
  });
});

// ── mintHqToken ──────────────────────────────────────────────────────────────

describe('mintHqToken', () => {
  it('mints a token with unique id and token', () => {
    const a = mintHqToken();
    const b = mintHqToken();
    expect(a.id).not.toBe(b.id);
    expect(a.token).not.toBe(b.token);
    expect(a.token.length).toBeGreaterThan(30);
  });

  it('accepts a string label (backward compat)', () => {
    const token = mintHqToken('my-label');
    expect(token.label).toBe('my-label');
  });

  it('accepts an options object', () => {
    const token = mintHqToken({ label: 'test', ttlMs: 3600_000 });
    expect(token.label).toBe('test');
    expect(token.expiresAt).toBeDefined();
  });

  it('stamps expiresAt from ttlMs', () => {
    const now = Date.now();
    const token = mintHqToken({ ttlMs: 60_000, now });
    expect(token.expiresAt).toBe(new Date(now + 60_000).toISOString());
  });

  it('omits expiresAt when ttlMs is absent', () => {
    const token = mintHqToken({});
    expect(token.expiresAt).toBeUndefined();
  });

  it('omits expiresAt for non-positive ttlMs', () => {
    expect(mintHqToken({ ttlMs: 0 }).expiresAt).toBeUndefined();
    expect(mintHqToken({ ttlMs: -100 }).expiresAt).toBeUndefined();
  });

  it('uses deterministic now for createdAt', () => {
    const now = Date.parse('2026-06-15T12:00:00Z');
    const token = mintHqToken({ now });
    expect(token.createdAt).toBe('2026-06-15T12:00:00.000Z');
  });
});

// ── hqAuthContentHash ────────────────────────────────────────────────────────

describe('hqAuthContentHash', () => {
  it('returns a hex string for a valid file', () => {
    const file = emptyHqAuthFile();
    const hash = hqAuthContentHash(file);
    expect(hash).toBeDefined();
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces the same hash regardless of token secrets', () => {
    const base: HqAuthFile = {
      version: HQ_AUTH_FILE_VERSION,
      updatedAt: '2026-01-01T00:00:00Z',
      browserTokens: [{ id: 'a', token: 'secret-1', createdAt: '2026-01-01T00:00:00Z' }],
    };
    const rotated: HqAuthFile = {
      ...base,
      browserTokens: [{ id: 'a', token: 'secret-2-rotated', createdAt: '2026-01-01T00:00:00Z' }],
    };
    expect(hqAuthContentHash(base)).toBe(hqAuthContentHash(rotated));
  });

  it('produces different hashes for structural changes', () => {
    const base = emptyHqAuthFile();
    const withToken: HqAuthFile = {
      ...base,
      browserTokens: [{ id: 'a', token: 't', createdAt: '2026-01-01T00:00:00Z' }],
    };
    expect(hqAuthContentHash(base)).not.toBe(hqAuthContentHash(withToken));
  });

  it('redacts passwordHash and cookieSecret', () => {
    const file: HqAuthFile = {
      version: HQ_AUTH_FILE_VERSION,
      updatedAt: '2026-01-01T00:00:00Z',
      passwordHash: 'scrypt$salt$hash',
      cookieSecret: 'super-secret',
    };
    const hash = hqAuthContentHash(file);
    expect(hash).toBeDefined();
    // The hash should NOT contain the raw secrets
    expect(hash).not.toContain('scrypt');
    expect(hash).not.toContain('super-secret');
  });
});

// ── emptyHqAuthFile ──────────────────────────────────────────────────────────

describe('emptyHqAuthFile', () => {
  it('returns a valid empty auth file', () => {
    const file = emptyHqAuthFile();
    expect(file.version).toBe(HQ_AUTH_FILE_VERSION);
    expect(file.updatedAt).toBeDefined();
    expect(file.browserTokens).toBeUndefined();
    expect(file.clientTokens).toBeUndefined();
  });
});

// ── resolveHqDataDir ─────────────────────────────────────────────────────────

describe('resolveHqDataDir', () => {
  it('uses override when provided', () => {
    const dir = resolveHqDataDir('/custom/hq');
    expect(dir).toBe(path.resolve('/custom/hq'));
  });

  it('uses env var when no override', () => {
    const dir = resolveHqDataDir(undefined, { WRONGSTACK_HQ_DATA_DIR: '/env/hq' });
    expect(dir).toBe(path.resolve('/env/hq'));
  });

  it('falls back to default when neither override nor env', () => {
    const dir = resolveHqDataDir(undefined, {});
    expect(dir).toContain('hq');
  });

  it('resolves relative paths against cwd', () => {
    const dir = resolveHqDataDir('relative/hq', {});
    expect(path.isAbsolute(dir)).toBe(true);
  });
});

// ── path helpers ─────────────────────────────────────────────────────────────

describe('path helpers', () => {
  it('hqAuthFilePath joins auth.json', () => {
    expect(hqAuthFilePath('/data')).toBe(path.join('/data', 'auth.json'));
  });

  it('hqRuntimeFilePath joins runtime.json', () => {
    expect(hqRuntimeFilePath('/data')).toBe(path.join('/data', 'runtime.json'));
  });
});

// ── password hashing ─────────────────────────────────────────────────────────

describe('hashHqPassword / verifyHqPassword', () => {
  it('hashes and verifies a password', async () => {
    const hash = await hashHqPassword('my-secret-password');
    expect(hash).toContain('scrypt$');
    expect(await verifyHqPassword('my-secret-password', hash)).toBe(true);
  });

  it('rejects wrong password', async () => {
    const hash = await hashHqPassword('correct');
    expect(await verifyHqPassword('wrong', hash)).toBe(false);
  });

  it('rejects malformed hash', async () => {
    expect(await verifyHqPassword('x', 'not-a-hash')).toBe(false);
    expect(await verifyHqPassword('x', 'scrypt$')).toBe(false);
    expect(await verifyHqPassword('x', 'scrypt$$')).toBe(false);
  });

  it('produces different hashes for the same password (random salt)', async () => {
    const a = await hashHqPassword('same');
    const b = await hashHqPassword('same');
    expect(a).not.toBe(b);
  });
});

// ── HQ_AUTH_CONTENT_HASH_REDACTED sentinel ───────────────────────────────────

describe('HQ_AUTH_CONTENT_HASH_REDACTED', () => {
  it('is a stable sentinel string', () => {
    expect(HQ_AUTH_CONTENT_HASH_REDACTED).toBe('<redacted>');
  });
});
