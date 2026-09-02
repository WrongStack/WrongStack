/**
 * Focused unit tests for HQ first-run audit logging.
 *
 * `ensureHqFirstRunAuthFile` mints two tokens on the bootstrap path (one
 * browser, one client) and emits one `kind: 'first-run'` audit entry per
 * token into `<dataDir>/auth-audit.jsonl`. These tests pin that contract:
 *
 *   - both entries land, one per scope, with the minted tokenId/label
 *   - capabilities + expiresAt are recorded when present
 *   - the optional `actor` option threads through to both entries
 *   - re-invoking on an existing auth.json does NOT log again
 *   - the raw token string never appears in the audit log
 *
 * @vitest-environment node
 */
import {
  ensureHqFirstRunAuthFile,
  hqAuthAuditPath,
  hqAuthContentHash,
  readHqAuthFile,
  type HqAuthAuditEntry,
} from '@wrongstack/core/hq';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const HOUR_MS = 60 * 60 * 1000;

let tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'hq-first-run-audit-'));
  tempDirs.push(dir);
  return fn(dir);
}

async function readAuditEntries(dir: string): Promise<HqAuthAuditEntry[]> {
  try {
    const raw = await readFile(hqAuthAuditPath(dir), 'utf8');
    return raw
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as HqAuthAuditEntry);
  } catch {
    return [];
  }
}

describe('ensureHqFirstRunAuthFile — first-run audit logging', () => {
  it('emits two first-run entries (one per scope) on the bootstrap path', async () => {
    await withTempDir(async (dir) => {
      const result = await ensureHqFirstRunAuthFile(dir);
      expect(result.created).toBe(true);
      expect(result.browserToken).toBeDefined();
      expect(result.clientToken).toBeDefined();

      const entries = await readAuditEntries(dir);
      const firstRun = entries.filter((e) => e.kind === 'first-run');
      expect(firstRun).toHaveLength(2);

      const scopes = firstRun.map((e) => e.scope).sort();
      expect(scopes).toEqual(['browser', 'client']);
    });
  });

  it('records the minted tokenId and label for each scope', async () => {
    await withTempDir(async (dir) => {
      const result = await ensureHqFirstRunAuthFile(dir);
      const entries = await readAuditEntries(dir);
      const firstRun = entries.filter((e) => e.kind === 'first-run');

      const browser = firstRun.find((e) => e.scope === 'browser');
      const client = firstRun.find((e) => e.scope === 'client');
      expect(browser?.tokenId).toBe(result.browserToken!.id);
      expect(client?.tokenId).toBe(result.clientToken!.id);

      // First-run labels are minted as 'first-run browser' / 'first-run client'.
      expect(browser?.label).toBe('first-run browser');
      expect(client?.label).toBe('first-run client');
    });
  });

  it('records capabilities + expiresAt when the token carries them', async () => {
    await withTempDir(async (dir) => {
      const result = await ensureHqFirstRunAuthFile(dir, { tokenTtlMs: HOUR_MS });
      expect(result.browserToken?.expiresAt).toBeDefined();
      expect(result.clientToken?.expiresAt).toBeDefined();

      const entries = await readAuditEntries(dir);
      const browser = entries.find((e) => e.kind === 'first-run' && e.scope === 'browser');
      const client = entries.find((e) => e.kind === 'first-run' && e.scope === 'client');

      expect(browser?.capabilities).toEqual(['control.enqueue']);
      expect(browser?.expiresAt).toBe(result.browserToken!.expiresAt);
      expect(client?.capabilities).toEqual(['telemetry.publish']);
      expect(client?.expiresAt).toBe(result.clientToken!.expiresAt);
    });
  });

  it('threads the optional actor option into both entries', async () => {
    await withTempDir(async (dir) => {
      await ensureHqFirstRunAuthFile(dir, { actor: 'alice@host' });

      const entries = await readAuditEntries(dir);
      const firstRun = entries.filter((e) => e.kind === 'first-run');
      expect(firstRun).toHaveLength(2);
      for (const entry of firstRun) {
        expect(entry.actor).toBe('alice@host');
      }
    });
  });

  it('omits the actor field when the option is not supplied', async () => {
    await withTempDir(async (dir) => {
      await ensureHqFirstRunAuthFile(dir);

      const entries = await readAuditEntries(dir);
      const firstRun = entries.filter((e) => e.kind === 'first-run');
      expect(firstRun).toHaveLength(2);
      for (const entry of firstRun) {
        expect(entry.actor).toBeUndefined();
      }
    });
  });

  it('does NOT log first-run entries when auth.json already exists', async () => {
    await withTempDir(async (dir) => {
      // First call bootstraps + logs both entries.
      const first = await ensureHqFirstRunAuthFile(dir);
      expect(first.created).toBe(true);
      const afterFirst = await readAuditEntries(dir);
      expect(afterFirst.filter((e) => e.kind === 'first-run')).toHaveLength(2);

      // Second call sees the existing file and returns created:false —
      // no new audit entries.
      const second = await ensureHqFirstRunAuthFile(dir);
      expect(second.created).toBe(false);
      const afterSecond = await readAuditEntries(dir);
      expect(afterSecond.filter((e) => e.kind === 'first-run')).toHaveLength(2);
    });
  });

  it('never records the raw token string — only the tokenId', async () => {
    await withTempDir(async (dir) => {
      const result = await ensureHqFirstRunAuthFile(dir);
      const raw = await readFile(hqAuthAuditPath(dir), 'utf8');

      // The raw token strings must never appear in the audit log.
      expect(raw).not.toContain(result.browserToken!.token);
      expect(raw).not.toContain(result.clientToken!.token);

      // The token ids (UUIDs) must appear — they are safe to log.
      expect(raw).toContain(result.browserToken!.id);
      expect(raw).toContain(result.clientToken!.id);
    });
  });

  it('stamps a contentHash on both first-run entries (ties to on-disk state)', async () => {
    await withTempDir(async (dir) => {
      const result = await ensureHqFirstRunAuthFile(dir);
      const entries = await readAuditEntries(dir);
      const firstRun = entries.filter((e) => e.kind === 'first-run');
      expect(firstRun).toHaveLength(2);

      // Every first-run entry carries a SHA-256 hex hash that identifies
      // the structural state of the auth file at emit time. The hash
      // must be a 64-char hex string (no secrets — projection redacts
      // tokens, passwordHash, cookieSecret before hashing).
      for (const entry of firstRun) {
        expect(entry.contentHash).toMatch(/^[0-9a-f]{64}$/);
      }

      // Both entries (browser + client) are stamped from the same auth
      // file, so the hashes must match — an operator reviewing the log
      // sees one hash per bootstrap, not one per token.
      const hashes = new Set(firstRun.map((e) => e.contentHash));
      expect(hashes.size).toBe(1);

      // The hash must NOT leak secrets: re-deriving it from the persisted
      // file (via the same redacted projection) must reproduce the same
      // hash, confirming the audit entry is consistent with the on-disk
      // state the operator can independently inspect.
      const file = await readHqAuthFile(dir);
      const derived = hqAuthContentHash(file);
      expect(derived).toBe(firstRun[0]!.contentHash);

      // And the raw token strings must not appear in the hash payload —
      // the hash is over a redacted projection, so the raw tokens never
      // enter the digest.
      const raw = await readFile(hqAuthAuditPath(dir), 'utf8');
      expect(raw).not.toContain(result.browserToken!.token);
      expect(raw).not.toContain(result.clientToken!.token);
    });
  });

  it('contentHash stays stable when secrets rotate but the structure does not', async () => {
    await withTempDir(async (dir) => {
      // First bootstrap — establishes the baseline hash.
      const first = await ensureHqFirstRunAuthFile(dir);
      const firstEntries = (await readAuditEntries(dir)).filter((e) => e.kind === 'first-run');
      const firstHash = firstEntries[0]!.contentHash;

      // Re-derive the hash from the on-disk file after the bootstrap.
      // Reissuing just the browser token's secret (token string) without
      // changing its id/label/expiry must produce the SAME hash — the
      // projection redacts the token field, so a rotated secret does not
      // flip the hash. (We can't easily mint a new token in-place here
      // without going through the full mutate path, so we verify the
      // invariant at the helper level instead.)
      const file = await readHqAuthFile(dir);
      const rotatedSecretFile: typeof file = {
        ...file,
        browserTokens: file.browserTokens!.map((t) =>
          t.id === first.browserToken!.id ? { ...t, token: 'rotated-secret-string' } : t,
        ),
      };
      expect(hqAuthContentHash(rotatedSecretFile)).toBe(firstHash);

      // But changing structural state (adding a label to the token) must
      // flip the hash — otherwise the hash would be useless for forensic
      // tie-back.
      const relabeledFile: typeof file = {
        ...file,
        browserTokens: file.browserTokens!.map((t) =>
          t.id === first.browserToken!.id ? { ...t, label: 'relabeled' } : t,
        ),
      };
      expect(hqAuthContentHash(relabeledFile)).not.toBe(firstHash);
    });
  });
});
