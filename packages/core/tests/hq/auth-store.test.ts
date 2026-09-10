import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  defaultHqDataDir,
  emptyHqAuthFile,
  ensureHqFirstRunAuthFile,
  HQ_AUTH_FILE_VERSION,
  type HqAuthFile,
  hqPasswordNeedsUpgrade,
  hashHqPassword,
  hqAuthFilePath,
  hqRuntimeFilePath,
  hqTokenKey,
  hqTokenVerifier,
  mintHqBrowserToken,
  mintHqCookieSecret,
  mintHqToken,
  mutateHqAuthFile,
  readHqAuthFile,
  readHqRuntimeFileSync,
  resolveHqDataDir,
  tokenHasCapability,
  verifyHqPassword,
  writeHqAuthFile,
  writeHqRuntimeFile,
} from '../../src/hq/auth-store.js';
import { wstackGlobalRoot } from '../../src/utils/wstack-paths.js';
import { randomBytes, scrypt } from 'node:crypto';

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-auth-'));
  try {
    return await fn(tmp);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

describe('HQ auth-store — defaultHqDataDir + resolveHqDataDir', () => {
  it('defaultHqDataDir points at <wstackGlobalRoot>/hq', () => {
    expect(defaultHqDataDir()).toBe(path.join(wstackGlobalRoot(), 'hq'));
  });

  it('resolveHqDataDir: no override + no env → default', () => {
    const env: NodeJS.ProcessEnv = {};
    expect(resolveHqDataDir(undefined, env)).toBe(defaultHqDataDir());
  });

  it('resolveHqDataDir: explicit override wins over env', () => {
    const env: NodeJS.ProcessEnv = { WRONGSTACK_HQ_DATA_DIR: '/from/env' };
    expect(resolveHqDataDir('/from/flag', env)).toBe(path.resolve('/from/flag'));
  });

  it('resolveHqDataDir: WRONGSTACK_HQ_DATA_DIR honored when no override', () => {
    const env: NodeJS.ProcessEnv = { WRONGSTACK_HQ_DATA_DIR: '/from/env' };
    expect(resolveHqDataDir(undefined, env)).toBe(path.resolve('/from/env'));
  });

  it('resolveHqDataDir: relative paths resolve against process.cwd()', () => {
    const env: NodeJS.ProcessEnv = {};
    const expected = path.resolve(process.cwd(), 'relative/hq');
    expect(resolveHqDataDir('relative/hq', env)).toBe(expected);
  });

  it('resolveHqDataDir: empty WRONGSTACK_HQ_DATA_DIR falls through to default', () => {
    const env: NodeJS.ProcessEnv = { WRONGSTACK_HQ_DATA_DIR: '   ' };
    expect(resolveHqDataDir(undefined, env)).toBe(defaultHqDataDir());
  });
});

describe('HQ auth-store — emptyHqAuthFile', () => {
  it('has the current schema version', () => {
    const f = emptyHqAuthFile();
    expect(f.version).toBe(HQ_AUTH_FILE_VERSION);
  });

  it('has an ISO updatedAt', () => {
    const f = emptyHqAuthFile();
    expect(() => new Date(f.updatedAt).toISOString()).not.toThrow();
    expect(new Date(f.updatedAt).toString()).not.toBe('Invalid Date');
  });

  it('does not carry redactionPolicy or browserTokens by default', () => {
    const f = emptyHqAuthFile();
    expect(f.redactionPolicy).toBeUndefined();
    expect(f.browserTokens).toBeUndefined();
  });
});

describe('HQ auth-store — hqAuthFilePath', () => {
  it('joins dataDir + auth.json', () => {
    expect(hqAuthFilePath('/tmp/hq')).toBe(path.join('/tmp/hq', 'auth.json'));
    expect(hqAuthFilePath('/tmp/hq/')).toBe(path.join('/tmp/hq/', 'auth.json'));
  });
});

describe('HQ auth-store — readHqAuthFile', () => {
  it('returns empty file when auth.json does not exist (ENOENT)', async () => {
    await withTempDir(async (dir) => {
      const f = await readHqAuthFile(dir);
      expect(f.version).toBe(HQ_AUTH_FILE_VERSION);
      expect(f.redactionPolicy).toBeUndefined();
    });
  });

  it('throws on corrupt JSON (fail closed)', async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(hqAuthFilePath(dir), '{ not valid json');
      await expect(readHqAuthFile(dir)).rejects.toThrow('not valid JSON');
    });
  });

  it('throws on wrong schema version (fail closed)', async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(hqAuthFilePath(dir), JSON.stringify({ version: 99, updatedAt: 'x' }));
      await expect(readHqAuthFile(dir)).rejects.toThrow('unsupported version');
    });
  });

  it('round-trips a well-formed file with redactionPolicy override', async () => {
    await withTempDir(async (dir) => {
      const original: HqAuthFile = {
        version: HQ_AUTH_FILE_VERSION,
        updatedAt: '2026-06-21T00:00:00.000Z',
        redactionPolicy: { rawContent: true, toolArgs: 'summary', paths: 'project-relative' },
        browserTokens: [{ id: 't1', token: 'abc', createdAt: '2026-06-21T00:00:00.000Z' }],
      };
      await writeHqAuthFile(dir, original);
      const readBack = await readHqAuthFile(dir);
      expect(readBack.version).toBe(HQ_AUTH_FILE_VERSION);
      expect(readBack.redactionPolicy).toEqual(original.redactionPolicy);
      // WS-044: the browser token round-trips as a verifier, not a secret.
      // Everything else about the record is preserved verbatim.
      expect(readBack.browserTokens).toEqual([
        {
          id: 't1',
          token: '',
          verifier: hqTokenVerifier('abc'),
          createdAt: '2026-06-21T00:00:00.000Z',
        },
      ]);
    });
  });
});

describe('HQ auth-store — writeHqAuthFile', () => {
  it('writes a file that can be parsed back', async () => {
    await withTempDir(async (dir) => {
      await writeHqAuthFile(dir, emptyHqAuthFile());
      const raw = await fs.readFile(hqAuthFilePath(dir), 'utf8');
      expect(() => JSON.parse(raw)).not.toThrow();
    });
  });

  /**
   * `auth.json` is written `0600`, but the directory holding it was left at
   * whatever `mkdir` produced — `0755` under a normal umask. The file mode
   * stops another local account reading the secrets directly; a world-readable
   * parent still lets it enumerate the directory, and any file written there
   * later by a path that does not set its own mode inherits the permissive
   * default.
   *
   * `restrictDirPermissions` was written for exactly this and had NO production
   * call site anywhere in the repo (audit 2026-08-20, re-reported 2026-09-10).
   * This test is what stops it going back to zero callers.
   */
  it.skipIf(process.platform === 'win32')(
    'hardens the data directory, not just the auth file',
    async () => {
      await withTempDir(async (dir) => {
        const nested = path.join(dir, 'hq-data');
        await fs.mkdir(nested, { recursive: true, mode: 0o755 });
        await fs.chmod(nested, 0o755); // defeat umask, so 0755 is the real start
        expect((await fs.stat(nested)).mode & 0o777).toBe(0o755);

        await writeHqAuthFile(nested, emptyHqAuthFile());

        expect((await fs.stat(nested)).mode & 0o777).toBe(0o700);
        // The file's own mode is unchanged by the directory hardening.
        expect((await fs.stat(hqAuthFilePath(nested))).mode & 0o777).toBe(0o600);
      });
    },
  );

  it('forces version=1 and refreshes updatedAt on write', async () => {
    await withTempDir(async (dir) => {
      const stale: HqAuthFile = {
        // caller passes a wrong version on purpose; write must clamp
        version: 99 as 1,
        updatedAt: '1999-01-01T00:00:00.000Z',
      };
      const before = Date.now();
      await writeHqAuthFile(dir, stale);
      const readBack = await readHqAuthFile(dir);
      expect(readBack.version).toBe(HQ_AUTH_FILE_VERSION);
      expect(new Date(readBack.updatedAt).getTime()).toBeGreaterThanOrEqual(before);
    });
  });

  it('creates the data directory if missing', async () => {
    await withTempDir(async (dir) => {
      const nested = path.join(dir, 'nested', 'deeper');
      await writeHqAuthFile(nested, emptyHqAuthFile());
      const stat = await fs.stat(hqAuthFilePath(nested));
      expect(stat.isFile()).toBe(true);
    });
  });

  // ── WS-044: browser secrets never persist ─────────────────────────────

  it('persists browser tokens as a verifier and blanks the secret', async () => {
    await withTempDir(async (dir) => {
      const secret = 'a'.repeat(64);
      await writeHqAuthFile(dir, {
        ...emptyHqAuthFile(),
        browserTokens: [{ id: 'b1', token: secret, createdAt: new Date().toISOString() }],
      });
      const raw = await fs.readFile(hqAuthFilePath(dir), 'utf8');
      // The whole point: a copy of this file is not a working credential.
      expect(raw).not.toContain(secret);
      expect(raw).toContain(hqTokenVerifier(secret));
    });
  });

  it('leaves client tokens in cleartext — a local agent reads them back', async () => {
    // Deliberate, and documented on `HqToken.verifier`: hashing these would
    // only move the secret to another file on the same disk. Their control is
    // the owner-only file mode (WS-045).
    await withTempDir(async (dir) => {
      const secret = 'c'.repeat(64);
      await writeHqAuthFile(dir, {
        ...emptyHqAuthFile(),
        clientTokens: [{ id: 'c1', token: secret, createdAt: new Date().toISOString() }],
      });
      const readBack = await readHqAuthFile(dir);
      expect(readBack.clientTokens?.[0]?.token).toBe(secret);
    });
  });

  it('is idempotent — re-writing an already hashed file does not double-hash', async () => {
    await withTempDir(async (dir) => {
      const secret = 'd'.repeat(64);
      await writeHqAuthFile(dir, {
        ...emptyHqAuthFile(),
        browserTokens: [{ id: 'b1', token: secret, createdAt: new Date().toISOString() }],
      });
      const once = await readHqAuthFile(dir);
      await writeHqAuthFile(dir, once);
      const twice = await readHqAuthFile(dir);
      expect(twice.browserTokens?.[0]?.verifier).toBe(hqTokenVerifier(secret));
    });
  });

  it('hqTokenKey resolves both a migrated and a legacy record to the same key', () => {
    const secret = 'e'.repeat(64);
    const legacy = { token: secret };
    const migrated = { token: '', verifier: hqTokenVerifier(secret) };
    expect(hqTokenKey(legacy)).toBe(hqTokenKey(migrated));
    expect(hqTokenKey(migrated)).toBe(hqTokenVerifier(secret));
  });

  it('hqTokenKey returns an empty key for a record with neither field', () => {
    // An empty key must never match a presented secret, whose verifier is
    // always 64 hex characters.
    expect(hqTokenKey({ token: '' })).toBe('');
  });

  it('sets mode 0o600 on a fresh file (best-effort on win32)', async () => {
    if (process.platform === 'win32') {
      // chmod is a no-op on Windows; skip the assertion rather than fail.
      return;
    }
    await withTempDir(async (dir) => {
      await writeHqAuthFile(dir, emptyHqAuthFile());
      const stat = await fs.stat(hqAuthFilePath(dir));
      expect(stat.mode & 0o777).toBe(0o600);
    });
  });
});

describe('HQ auth-store — ensureHqFirstRunAuthFile', () => {
  it('creates browser and client tokens when auth.json is missing', async () => {
    await withTempDir(async (dir) => {
      const result = await ensureHqFirstRunAuthFile(dir);
      expect(result.created).toBe(true);
      expect(result.browserToken?.token).toBeTruthy();
      expect(result.clientToken?.token).toBeTruthy();
      expect(result.browserToken?.capabilities).toEqual(['control.enqueue']);
      expect(result.clientToken?.capabilities).toEqual(['telemetry.publish']);
      expect(result.authFile.browserTokens).toHaveLength(1);
      expect(result.authFile.clientTokens).toHaveLength(1);
      expect(await fs.stat(hqAuthFilePath(dir))).toBeTruthy();
    });
  });

  it('preserves existing explicit open-mode auth.json', async () => {
    await withTempDir(async (dir) => {
      await writeHqAuthFile(dir, {
        version: HQ_AUTH_FILE_VERSION,
        updatedAt: '2026-06-21T00:00:00.000Z',
        browserTokens: [],
        clientTokens: [],
      });
      const result = await ensureHqFirstRunAuthFile(dir);
      expect(result.created).toBe(false);
      expect(result.authFile.browserTokens).toEqual([]);
      expect(result.authFile.clientTokens).toEqual([]);
    });
  });

  it('adds or rotates a password for an existing auth.json', async () => {
    await withTempDir(async (dir) => {
      await writeHqAuthFile(dir, {
        version: HQ_AUTH_FILE_VERSION,
        updatedAt: '2026-06-21T00:00:00.000Z',
        browserTokens: [],
        clientTokens: [],
      });

      const added = await ensureHqFirstRunAuthFile(dir, { password: 'first-password' });
      expect(added.created).toBe(false);
      expect(await verifyHqPassword('first-password', added.authFile.passwordHash ?? '')).toBe(
        true,
      );
      const firstSecret = added.authFile.cookieSecret;

      const unchanged = await ensureHqFirstRunAuthFile(dir, { password: 'first-password' });
      expect(unchanged.authFile.cookieSecret).toBe(firstSecret);

      const rotated = await ensureHqFirstRunAuthFile(dir, { password: 'second-password' });
      expect(await verifyHqPassword('second-password', rotated.authFile.passwordHash ?? '')).toBe(
        true,
      );
      expect(await verifyHqPassword('first-password', rotated.authFile.passwordHash ?? '')).toBe(
        false,
      );
      expect(rotated.authFile.cookieSecret).not.toBe(firstSecret);
    });
  });

  it('uses a service password only for bootstrap and preserves a Settings change', async () => {
    await withTempDir(async (dir) => {
      const first = await ensureHqFirstRunAuthFile(dir, {
        password: 'initial-service-password',
        bootstrapPasswordOnly: true,
      });
      expect(first.created).toBe(true);
      expect(
        await verifyHqPassword('initial-service-password', first.authFile.passwordHash ?? ''),
      ).toBe(true);

      await ensureHqFirstRunAuthFile(dir, { password: 'settings-managed-password' });
      const restarted = await ensureHqFirstRunAuthFile(dir, {
        password: 'initial-service-password',
        bootstrapPasswordOnly: true,
      });

      expect(
        await verifyHqPassword('settings-managed-password', restarted.authFile.passwordHash ?? ''),
      ).toBe(true);
      expect(
        await verifyHqPassword('initial-service-password', restarted.authFile.passwordHash ?? ''),
      ).toBe(false);
    });
  });
});

describe('HQ auth-store — mutateHqAuthFile', () => {
  it('applies the mutator to an empty starting file', async () => {
    await withTempDir(async (dir) => {
      const next = await mutateHqAuthFile(dir, (cur) => ({
        ...cur,
        redactionPolicy: { rawContent: false },
      }));
      expect(next.redactionPolicy).toEqual({ rawContent: false });
      const reread = await readHqAuthFile(dir);
      expect(reread.redactionPolicy).toEqual({ rawContent: false });
    });
  });

  it('preserves existing fields not touched by the mutator', async () => {
    await withTempDir(async (dir) => {
      await writeHqAuthFile(dir, {
        version: HQ_AUTH_FILE_VERSION,
        updatedAt: '2026-06-21T00:00:00.000Z',
        redactionPolicy: { rawContent: false },
        browserTokens: [{ id: 't1', token: 'abc', createdAt: '2026-06-21T00:00:00.000Z' }],
      });
      const next = await mutateHqAuthFile(dir, (cur) => ({
        ...cur,
        redactionPolicy: { rawContent: true, toolArgs: 'none' },
      }));
      expect(next.browserTokens).toHaveLength(1);
      expect(next.redactionPolicy).toEqual({ rawContent: true, toolArgs: 'none' });
    });
  });
});

describe('HQ auth-store — mintHqBrowserToken', () => {
  it('produces a token with id + token + createdAt', () => {
    const t = mintHqBrowserToken();
    expect(typeof t.id).toBe('string');
    expect(t.id.length).toBeGreaterThan(0);
    expect(typeof t.token).toBe('string');
    expect(t.token.length).toBeGreaterThanOrEqual(32);
    expect(() => new Date(t.createdAt).toISOString()).not.toThrow();
  });

  it('carries the optional label', () => {
    const t = mintHqBrowserToken('my laptop');
    expect(t.label).toBe('my laptop');
  });

  it('mints unique tokens', () => {
    const a = mintHqBrowserToken();
    const b = mintHqBrowserToken();
    expect(a.id).not.toBe(b.id);
    expect(a.token).not.toBe(b.token);
  });
});

describe('HQ auth-store — tokenHasCapability', () => {
  it('returns false for undefined token', () => {
    expect(tokenHasCapability(undefined, 'anything')).toBe(false);
  });

  it('returns true when token has no capabilities field (unrestricted)', () => {
    expect(tokenHasCapability({ id: 't1', token: 'abc', createdAt: 'x' }, 'anything')).toBe(true);
  });

  it('returns true when capabilities include the requested capability', () => {
    const token = { id: 't1', token: 'abc', createdAt: 'x', capabilities: ['read', 'write'] };
    expect(tokenHasCapability(token, 'read')).toBe(true);
    expect(tokenHasCapability(token, 'write')).toBe(true);
  });

  it('returns false when capabilities do not include the requested capability', () => {
    const token = { id: 't1', token: 'abc', createdAt: 'x', capabilities: ['read'] };
    expect(tokenHasCapability(token, 'delete')).toBe(false);
  });
});

describe('HQ auth-store — hqRuntimeFilePath + writeHqRuntimeFile + readHqRuntimeFileSync', () => {
  it('hqRuntimeFilePath joins dataDir + runtime.json', () => {
    expect(hqRuntimeFilePath('/tmp/hq')).toBe(path.join('/tmp/hq', 'runtime.json'));
  });

  it('writeHqRuntimeFile writes a parseable runtime file', async () => {
    await withTempDir(async (dir) => {
      const input = { url: 'http://localhost:7788', pid: process.pid };
      await writeHqRuntimeFile(dir, input);
      const raw = await fs.readFile(hqRuntimeFilePath(dir), 'utf8');
      const parsed = JSON.parse(raw);
      expect(parsed.url).toBe('http://localhost:7788');
      expect(parsed.pid).toBe(process.pid);
      expect(typeof parsed.updatedAt).toBe('string');
      expect(parsed.updatedAt.length).toBeGreaterThan(0);

      // read back via sync reader
      const readBack = readHqRuntimeFileSync(dir);
      expect(readBack?.url).toBe('http://localhost:7788');
    });
  });

  it('readHqRuntimeFileSync returns undefined for non-existent file', () => {
    const tmp = path.join(os.tmpdir(), `hq-auth-nonexistent-${Date.now()}`);
    expect(readHqRuntimeFileSync(tmp)).toBeUndefined();
  });

  it('readHqRuntimeFileSync returns undefined for corrupt JSON', async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(hqRuntimeFilePath(dir), '{ not json');
      expect(readHqRuntimeFileSync(dir)).toBeUndefined();
    });
  });

  it('readHqRuntimeFileSync returns undefined for empty url', async () => {
    await withTempDir(async (dir) => {
      await writeHqRuntimeFile(dir, { url: '  ', pid: process.pid });
      expect(readHqRuntimeFileSync(dir)).toBeUndefined();
    });
  });

  it('readHqRuntimeFileSync returns undefined when pid is not alive', async () => {
    await withTempDir(async (dir) => {
      await writeHqRuntimeFile(dir, { url: 'http://localhost:7788', pid: 999999999 });
      expect(readHqRuntimeFileSync(dir)).toBeUndefined();
    });
  });

  it('readHqRuntimeFileSync treats EPERM as a live cross-user process', async () => {
    await withTempDir(async (dir) => {
      const pid = 999_998;
      await writeHqRuntimeFile(dir, { url: 'http://localhost:7788', pid });
      const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
        throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      });
      try {
        expect(readHqRuntimeFileSync(dir)?.pid).toBe(pid);
      } finally {
        kill.mockRestore();
      }
    });
  });
});

describe('HQ auth-store — mintHqToken (underlying)', () => {
  it('produces a token with id + token + createdAt when no label', () => {
    const t = mintHqToken();
    expect(typeof t.id).toBe('string');
    expect(t.id.length).toBeGreaterThan(0);
    expect(typeof t.token).toBe('string');
    expect(t.token.length).toBeGreaterThanOrEqual(32);
    expect(() => new Date(t.createdAt).toISOString()).not.toThrow();
    expect(t.label).toBeUndefined();
  });

  it('includes label when provided', () => {
    const t = mintHqToken('test token');
    expect(t.label).toBe('test token');
  });
});

describe('HQ auth-store — readHqAuthFile error path (non-ENOENT access error)', () => {
  it('returns empty file on non-ENOENT read error', async () => {
    // Point to a path that looks like a file but is actually a directory
    const { mkdtemp, rm } = await import('node:fs/promises');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'hq-auth-'));
    const subdir = path.join(dir, 'subdir');
    await fs.mkdir(subdir);
    try {
      const f = await readHqAuthFile(subdir);
      expect(f.version).toBe(HQ_AUTH_FILE_VERSION);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('HQ auth-store — ensureHqFirstRunAuthFile error path', () => {
  it('handles access failure on existing auth.json', async () => {
    await withTempDir(async (dir) => {
      const file = hqAuthFilePath(dir);
      // Create the file then make it unreadable (Unix only)
      await writeHqAuthFile(dir, { version: 1, updatedAt: 'x' });
      try {
        await fs.chmod(file, 0o000);
        const warn = vi.fn();
        const result = await ensureHqFirstRunAuthFile(dir, { warn });
        expect(result.created).toBe(false);
      } catch {
        // On Windows chmod may silently succeed; skip
      } finally {
        await fs.chmod(file, 0o600).catch(() => {});
      }
    });
  });
});

describe('HQ auth-store — password login', () => {
  it('hashes and verifies a password', async () => {
    const hash = await hashHqPassword('hq-secret');
    expect(hash).toMatch(/^scrypt\$/);
    expect(await verifyHqPassword('hq-secret', hash)).toBe(true);
    expect(await verifyHqPassword('wrong', hash)).toBe(false);
  });

  it('rejects malformed or empty hashes', async () => {
    expect(await verifyHqPassword('x', '')).toBe(false);
    expect(await verifyHqPassword('x', 'plain$wrong')).toBe(false);
    expect(await verifyHqPassword('x', 'scrypt$only')).toBe(false);
  });

  it('produces distinct hashes for the same password', async () => {
    const a = await hashHqPassword('same');
    const b = await hashHqPassword('same');
    expect(a).not.toBe(b);
  });

  it('mints a cookie secret', () => {
    const s = mintHqCookieSecret();
    expect(typeof s).toBe('string');
    expect(s.length).toBeGreaterThanOrEqual(32);
  });

  it('first-run stores a password hash and cookie secret', async () => {
    await withTempDir(async (dir) => {
      const result = await ensureHqFirstRunAuthFile(dir, { password: 'hq-password' });
      expect(result.created).toBe(true);
      expect(result.authFile.passwordHash).toMatch(/^scrypt\$/);
      expect(typeof result.authFile.cookieSecret).toBe('string');
      expect(await verifyHqPassword('hq-password', result.authFile.passwordHash ?? '')).toBe(true);
    });
  });
});

describe('HQ password KDF versioning', () => {
  /**
   * The stored payload used to be `scrypt$<salt>$<hash>` — no parameters — so
   * verification always re-derived with whatever the module constant happened
   * to be. That made the cost impossible to raise: changing the constant would
   * have failed every existing password, which is a lockout, not a migration.
   * The payload now carries its own parameters, and the legacy three-segment
   * shape is still verified at the cost it was written with.
   */
  const legacyHash = (password: string): Promise<string> =>
    new Promise((resolve, reject) => {
      const salt = randomBytes(16);
      scrypt(password, salt, 32, { N: 16384, r: 8, p: 1 }, (err, key) => {
        if (err) reject(err);
        else resolve(['scrypt', salt.toString('base64url'), key.toString('base64url')].join('$'));
      });
    });

  const PASSWORD = 'correct horse battery staple';
  const WRONG = 'correct horse battery stapl3';

  it('writes a parameterised payload for new hashes', async () => {
    const hash = await hashHqPassword(PASSWORD);
    const parts = hash.split('$');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('scrypt');
    expect(parts[1]).toMatch(/^N=\d+,r=\d+,p=\d+$/);
  });

  it('still verifies a legacy parameter-less hash', async () => {
    // The migration property. If this breaks, every existing deployment is
    // locked out of its own HQ.
    const legacy = await legacyHash(PASSWORD);
    expect(legacy.split('$')).toHaveLength(3);
    expect(await verifyHqPassword(PASSWORD, legacy)).toBe(true);
    expect(await verifyHqPassword(WRONG, legacy)).toBe(false);
  });

  it('round-trips a current hash', async () => {
    const hash = await hashHqPassword(PASSWORD);
    expect(await verifyHqPassword(PASSWORD, hash)).toBe(true);
    expect(await verifyHqPassword(WRONG, hash)).toBe(false);
  });

  it('flags a legacy hash for upgrade and a current one as fine', async () => {
    expect(hqPasswordNeedsUpgrade(await legacyHash(PASSWORD))).toBe(true);
    expect(hqPasswordNeedsUpgrade(await hashHqPassword(PASSWORD))).toBe(false);
  });

  it('refuses a stored payload that asks for an absurd allocation', async () => {
    // `auth.json` is a file on disk, not a trusted source of a memory size.
    // Without the bound, a hand-edited `N` would make every login attempt try
    // to allocate it — a denial of service reachable by anyone who can write
    // that file.
    expect(await verifyHqPassword(PASSWORD, 'scrypt$N=1073741824,r=8,p=1$AAAA$AAAA')).toBe(false);
    // Non-power-of-two N is invalid for scrypt and must not reach it.
    expect(await verifyHqPassword(PASSWORD, 'scrypt$N=65535,r=8,p=1$AAAA$AAAA')).toBe(false);
  });

  it('rejects malformed payloads instead of throwing', async () => {
    for (const bad of ['nonsense', 'scrypt$only-two', 'scrypt$a$b$c$d', 'bcrypt$N=16,r=8,p=1$a$b']) {
      expect(await verifyHqPassword(PASSWORD, bad)).toBe(false);
    }
  });
});
