import { logHqAuthAudit, hqAuthAuditPath, type HqAuthAuditEntry } from '@wrongstack/core/hq';
import { readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let tmpHome: string;
let dataDir: string;

beforeEach(async () => {
  const { mkdtemp } = await import('node:fs/promises');
  tmpHome = await mkdtemp(path.join(os.tmpdir(), 'hq-auth-audit-'));
  dataDir = path.join(tmpHome, 'hq');
});

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await rm(tmpHome, { recursive: true, force: true });
});

function readAuditLines(): HqAuthAuditEntry[] {
  try {
    const raw = readFileSync(hqAuthAuditPath(dataDir), 'utf8');
    return raw
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as HqAuthAuditEntry);
  } catch {
    return [];
  }
}

describe('HQ auth-audit — JSONL append-only log', () => {
  it('appends a single entry as one JSONL line', () => {
    const fixedNow = 1_700_000_000_000;
    logHqAuthAudit(
      dataDir,
      {
        kind: 'create',
        scope: 'browser',
        tokenId: 'tok-1',
        actor: 'alice@host',
      },
      { now: () => fixedNow },
    );

    const lines = readAuditLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      at: fixedNow,
      kind: 'create',
      scope: 'browser',
      tokenId: 'tok-1',
      actor: 'alice@host',
    });
  });

  it('appends multiple entries on separate lines (no overwrite)', () => {
    logHqAuthAudit(dataDir, { kind: 'create', scope: 'browser', tokenId: 'a' });
    logHqAuthAudit(dataDir, { kind: 'create', scope: 'client', tokenId: 'b' });
    logHqAuthAudit(dataDir, { kind: 'revoke', scope: 'browser', tokenId: 'a' });

    const lines = readAuditLines();
    expect(lines.map((l) => l.tokenId)).toEqual(['a', 'b', 'a']);
    expect(lines.map((l) => l.kind)).toEqual(['create', 'create', 'revoke']);
  });

  it('creates the data dir if missing', () => {
    // dataDir points at <tmpHome>/hq which doesn't exist yet.
    logHqAuthAudit(dataDir, { kind: 'create', scope: 'browser', tokenId: 'x' });
    expect(readAuditLines()).toHaveLength(1);
  });

  it('records optional fields when provided', () => {
    const expiresAt = new Date(1_700_000_000_000 + 3_600_000).toISOString();
    logHqAuthAudit(dataDir, {
      kind: 'create',
      scope: 'client',
      tokenId: 't-opt',
      label: 'ci-bot',
      capabilities: ['telemetry.publish', 'control.execute'],
      expiresAt,
      actor: 'ci@runner',
    });

    const lines = readAuditLines();
    expect(lines[0]).toMatchObject({
      label: 'ci-bot',
      capabilities: ['telemetry.publish', 'control.execute'],
      expiresAt,
      actor: 'ci@runner',
    });
  });

  it('records prunedCount for expired-prune events', () => {
    logHqAuthAudit(dataDir, {
      kind: 'expired-prune',
      scope: 'browser',
      tokenId: '(aggregate)',
      prunedCount: 3,
    });

    expect(readAuditLines()[0]?.prunedCount).toBe(3);
  });

  it('swallows errors via onError callback (best-effort contract)', () => {
    // Point dataDir at a path that cannot be created (a file blocks mkdir).
    // On most platforms mkdirSync(recursive) on a path whose parent is a file
    // throws EEXIST/ENOTDIR — the audit must not crash the caller.
    const blockedDir = path.join(tmpHome, 'blocking-file', 'audit');
    // Create the blocking file first.
    const { writeFileSync } = require('node:fs');
    writeFileSync(path.join(tmpHome, 'blocking-file'), 'blocker');

    let captured: Error | undefined;
    expect(() => {
      logHqAuthAudit(
        blockedDir,
        { kind: 'create', scope: 'browser', tokenId: 'x' },
        {
          onError: (err) => {
            captured = err;
          },
        },
      );
    }).not.toThrow();
    // The callback is invoked with the underlying error.
    expect(captured).toBeInstanceOf(Error);
  });

  it('uses Date.now() when no `now` override is supplied', () => {
    const before = Date.now();
    logHqAuthAudit(dataDir, { kind: 'create', scope: 'browser', tokenId: 't-now' });
    const after = Date.now();
    const entry = readAuditLines()[0]!;
    expect(entry.at).toBeGreaterThanOrEqual(before);
    expect(entry.at).toBeLessThanOrEqual(after);
  });

  it('never records the raw token string — only the id', () => {
    const tokenString = 'super-secret-token-value-12345';
    logHqAuthAudit(dataDir, {
      kind: 'create',
      scope: 'browser',
      tokenId: 'uuid-only',
    });

    const raw = readFileSync(hqAuthAuditPath(dataDir), 'utf8');
    expect(raw).not.toContain(tokenString);
    expect(raw).toContain('uuid-only');
  });
});
