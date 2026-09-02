/**
 * Focused unit tests for HQ token TTL + expiry:
 *
 *   - `mintHqToken({ ttlMs })` stamps `expiresAt = now + ttlMs`
 *   - `mintHqToken({ label })` (string overload) preserves pre-TTL behavior
 *   - `isTokenExpired` boundary semantics (before / at / after)
 *   - `isTokenExpired` fail-open on malformed timestamps
 *   - `tokenHasCapability` refuses expired tokens regardless of capability
 *   - `ensureHqFirstRunAuthFile` stamps `expiresAt` when `tokenTtlMs` is set
 *
 * @vitest-environment node
 */
import {
  ensureHqFirstRunAuthFile,
  isTokenExpired,
  mintHqToken,
  readHqAuthFile,
  tokenHasCapability,
} from '@wrongstack/core/hq';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const FIXED_NOW = Date.parse('2026-07-19T12:00:00.000Z');
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

let tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'hq-ttl-'));
  tempDirs.push(dir);
  return fn(dir);
}

// ── mintHqToken TTL stamping ──────────────────────────────────────────────

describe('mintHqToken — TTL stamping', () => {
  it('does not stamp expiresAt when no ttlMs is given (pre-TTL default)', () => {
    const t = mintHqToken({ label: 'no-ttl', now: FIXED_NOW });
    expect(t.expiresAt).toBeUndefined();
  });

  it('stamps expiresAt = now + ttlMs when ttlMs is given', () => {
    const t = mintHqToken({ label: '1h', ttlMs: HOUR_MS, now: FIXED_NOW });
    expect(t.expiresAt).toBe('2026-07-19T13:00:00.000Z');
  });

  it('stamps expiresAt with a multi-day window', () => {
    const t = mintHqToken({ ttlMs: 7 * DAY_MS, now: FIXED_NOW });
    expect(t.expiresAt).toBe('2026-07-26T12:00:00.000Z');
  });

  it('preserves createdAt = now even when ttlMs is set', () => {
    const t = mintHqToken({ ttlMs: HOUR_MS, now: FIXED_NOW });
    expect(t.createdAt).toBe('2026-07-19T12:00:00.000Z');
  });

  it('ignores non-positive ttlMs (treated as no expiry)', () => {
    expect(mintHqToken({ ttlMs: 0, now: FIXED_NOW }).expiresAt).toBeUndefined();
    expect(mintHqToken({ ttlMs: -1000, now: FIXED_NOW }).expiresAt).toBeUndefined();
  });

  it('ignores non-finite ttlMs (NaN / Infinity)', () => {
    expect(mintHqToken({ ttlMs: Number.NaN, now: FIXED_NOW }).expiresAt).toBeUndefined();
    expect(
      mintHqToken({ ttlMs: Number.POSITIVE_INFINITY, now: FIXED_NOW }).expiresAt,
    ).toBeUndefined();
  });

  it('preserves the bare-string overload (backward-compat)', () => {
    const t = mintHqToken('legacy label');
    expect(t.label).toBe('legacy label');
    expect(t.expiresAt).toBeUndefined();
  });

  it('supports label + ttlMs together', () => {
    const t = mintHqToken({ label: 'rotating', ttlMs: HOUR_MS, now: FIXED_NOW });
    expect(t.label).toBe('rotating');
    expect(t.expiresAt).toBe('2026-07-19T13:00:00.000Z');
  });
});

// ── isTokenExpired ─────────────────────────────────────────────────────────

describe('isTokenExpired — boundary semantics', () => {
  it('returns false when expiresAt is absent (never expires)', () => {
    expect(isTokenExpired({ expiresAt: undefined }, FIXED_NOW)).toBe(false);
    expect(isTokenExpired({}, FIXED_NOW)).toBe(false);
  });

  it('returns false when the clock is before expiresAt', () => {
    const t = { expiresAt: '2026-07-19T13:00:00.000Z' };
    expect(isTokenExpired(t, FIXED_NOW)).toBe(false); // exactly one hour before
  });

  it('returns true when the clock equals expiresAt (boundary is expired)', () => {
    const t = { expiresAt: '2026-07-19T12:00:00.000Z' };
    expect(isTokenExpired(t, FIXED_NOW)).toBe(true);
  });

  it('returns true when the clock is after expiresAt', () => {
    const t = { expiresAt: '2026-07-19T11:00:00.000Z' };
    expect(isTokenExpired(t, FIXED_NOW)).toBe(true);
  });

  it('returns false on undefined token (defensive)', () => {
    expect(isTokenExpired(undefined, FIXED_NOW)).toBe(false);
  });

  it('fail-opens on malformed expiresAt (does NOT lock out the operator)', () => {
    expect(isTokenExpired({ expiresAt: 'not-a-date' }, FIXED_NOW)).toBe(false);
    expect(isTokenExpired({ expiresAt: '' }, FIXED_NOW)).toBe(false);
  });

  it('defaults to Date.now() when no clock is supplied', () => {
    const future = { expiresAt: new Date(Date.now() + HOUR_MS).toISOString() };
    const past = { expiresAt: new Date(Date.now() - HOUR_MS).toISOString() };
    expect(isTokenExpired(future)).toBe(false);
    expect(isTokenExpired(past)).toBe(true);
  });
});

// ── tokenHasCapability with expiry ────────────────────────────────────────

describe('tokenHasCapability — expired tokens are refused', () => {
  it('returns false for an undefined token regardless of capability', () => {
    expect(tokenHasCapability(undefined, 'control.enqueue')).toBe(false);
  });

  it('returns true for an unrestricted, non-expired token', () => {
    const t = { id: 't1', token: 'abc', createdAt: 'x' };
    expect(tokenHasCapability(t, 'control.enqueue')).toBe(true);
  });

  it('returns true for a token whose expiresAt is still in the future', () => {
    // tokenHasCapability uses the real Date.now() (no clock injection);
    // a one-hour future window is comfortably ahead of the test run time.
    const t = {
      id: 't1',
      token: 'abc',
      createdAt: 'x',
      capabilities: ['control.enqueue'],
      expiresAt: new Date(Date.now() + HOUR_MS).toISOString(),
    };
    expect(tokenHasCapability(t, 'control.enqueue')).toBe(true);
  });

  it('returns false for an expired token even when capability is listed', () => {
    const t = {
      id: 't1',
      token: 'abc',
      createdAt: 'x',
      capabilities: ['control.enqueue'],
      expiresAt: new Date(FIXED_NOW - HOUR_MS).toISOString(),
    };
    expect(tokenHasCapability(t, 'control.enqueue')).toBe(false);
  });

  it('returns false for an expired unrestricted token (expiry wins over unrestricted)', () => {
    const t = {
      id: 't1',
      token: 'abc',
      createdAt: 'x',
      // no capabilities → unrestricted in the pre-TTL contract
      expiresAt: new Date(FIXED_NOW - HOUR_MS).toISOString(),
    };
    expect(tokenHasCapability(t, 'control.enqueue')).toBe(false);
  });
});

// ── ensureHqFirstRunAuthFile TTL propagation ──────────────────────────────

describe('ensureHqFirstRunAuthFile — tokenTtlMs propagation', () => {
  it('stamps expiresAt on both first-run tokens when tokenTtlMs is set', async () => {
    await withTempDir(async (dir) => {
      // Pin createdAt + expiresAt by intercepting the clock — the function
      // uses Date.now() internally so we assert the *delta* instead of the
      // exact timestamp.
      const before = Date.now();
      const result = await ensureHqFirstRunAuthFile(dir, { tokenTtlMs: DAY_MS });
      const after = Date.now();

      expect(result.browserToken?.expiresAt).toBeDefined();
      expect(result.clientToken?.expiresAt).toBeDefined();

      const browserExpiry = Date.parse(result.browserToken!.expiresAt!);
      const clientExpiry = Date.parse(result.clientToken!.expiresAt!);
      expect(browserExpiry).toBeGreaterThanOrEqual(before + DAY_MS);
      expect(browserExpiry).toBeLessThanOrEqual(after + DAY_MS);
      expect(clientExpiry).toBeGreaterThanOrEqual(before + DAY_MS);
      expect(clientExpiry).toBeLessThanOrEqual(after + DAY_MS);

      // The persisted file also carries the expiry.
      const file = await readHqAuthFile(dir);
      expect(file.browserTokens?.[0]?.expiresAt).toBeDefined();
      expect(file.clientTokens?.[0]?.expiresAt).toBeDefined();
    });
  });

  it('does NOT stamp expiresAt when tokenTtlMs is absent (pre-TTL default)', async () => {
    await withTempDir(async (dir) => {
      const result = await ensureHqFirstRunAuthFile(dir);
      expect(result.browserToken?.expiresAt).toBeUndefined();
      expect(result.clientToken?.expiresAt).toBeUndefined();

      const file = await readHqAuthFile(dir);
      expect(file.browserTokens?.[0]?.expiresAt).toBeUndefined();
      expect(file.clientTokens?.[0]?.expiresAt).toBeUndefined();
    });
  });

  it('preserves first-run capabilities alongside the TTL', async () => {
    await withTempDir(async (dir) => {
      const result = await ensureHqFirstRunAuthFile(dir, { tokenTtlMs: HOUR_MS });
      expect(result.browserToken?.capabilities).toEqual(['control.enqueue']);
      expect(result.clientToken?.capabilities).toEqual(['telemetry.publish']);
    });
  });

  it('leaves an existing auth.json untouched when tokenTtlMs is set', async () => {
    await withTempDir(async (dir) => {
      // Seed an auth.json with no expiry.
      const first = await ensureHqFirstRunAuthFile(dir);
      expect(first.created).toBe(true);
      const originalCreatedAt = first.browserToken!.createdAt;

      // Re-invoke with TTL — the existing file wins, no re-stamping.
      const second = await ensureHqFirstRunAuthFile(dir, { tokenTtlMs: HOUR_MS });
      expect(second.created).toBe(false);
      expect(second.browserToken).toBeUndefined();
      expect(second.clientToken).toBeUndefined();

      const file = await readHqAuthFile(dir);
      expect(file.browserTokens?.[0]?.createdAt).toBe(originalCreatedAt);
      expect(file.browserTokens?.[0]?.expiresAt).toBeUndefined();
    });
  });
});
