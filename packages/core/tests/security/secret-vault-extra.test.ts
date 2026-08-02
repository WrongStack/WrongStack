import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DefaultSecretVault, decryptConfigSecrets, encryptConfigSecrets, migratePlaintextSecrets } from '../../src/security/secret-vault.js';

let tmp: string;
let keyFile: string;
const vault = () => new DefaultSecretVault({ keyFile });

function withPlatform(value: string, fn: () => Promise<void> | void) {
  const orig = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value, configurable: true });
  return (async () => {
    try {
      await fn();
    } finally {
      if (orig) Object.defineProperty(process, 'platform', orig);
    }
  })();
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'secret-vault-extra-'));
  keyFile = path.join(tmp, 'key', '.key');
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('DefaultSecretVault key reuse', () => {
  it('a second vault reads the existing key file instead of regenerating', () => {
    const v1 = vault();
    const enc = v1.encrypt('secret-value'); // creates the key file
    const v2 = vault(); // fresh instance, same keyFile
    expect(v2.decrypt(enc)).toBe('secret-value'); // proves it loaded the same key
  });
});

describe('encryptConfigSecrets array handling', () => {
  it('walks arrays while encrypting secret fields', () => {
    const v = vault();
    const out = encryptConfigSecrets({ apiKey: 'k', list: ['a', 'b'], nested: { tokens: ['x'] } }, v) as { apiKey: string; list: string[] };
    expect(v.isEncrypted(out.apiKey)).toBe(true);
    expect(out.list).toEqual(['a', 'b']); // non-secret array values pass through
  });
});

describe('migratePlaintextSecrets edges', () => {
  it('returns 0 for a malformed JSON config', async () => {
    const cfgPath = path.join(tmp, 'bad.json');
    await fs.writeFile(cfgPath, 'not valid json {');
    expect(await migratePlaintextSecrets(cfgPath, vault())).toMatchObject({ migrated: 0 });
  });

  it('migrates plaintext secrets, recursing arrays and nulls, with a logger', async () => {
    const cfgPath = path.join(tmp, 'cfg.json');
    await fs.writeFile(cfgPath, JSON.stringify({ apiKey: 'plain-secret', servers: [{ token: 't1' }, null, 'plain-array-string'], note: null }));
    const warn = vi.fn();
    const res = await migratePlaintextSecrets(cfgPath, vault(), { warn });
    expect(res.migrated).toBeGreaterThan(0);
    const written = JSON.parse(await fs.readFile(cfgPath, 'utf8'));
    expect(new DefaultSecretVault({ keyFile }).isEncrypted(written.apiKey)).toBe(true);
  });

  it('warns when the Windows user cannot be determined (win32)', async () => {
    await withPlatform('win32', async () => {
      const savedUser = process.env.USERNAME;
      const savedU = process.env.USER;
      const savedDomain = process.env.USERDOMAIN;
      delete process.env.USERNAME;
      delete process.env.USER;
      delete process.env.USERDOMAIN;
      const warn = vi.fn();
      try {
        const cfgPath = path.join(tmp, 'win.json');
        await fs.writeFile(cfgPath, JSON.stringify({ apiKey: 'plain' }));
        await migratePlaintextSecrets(cfgPath, vault(), { warn });
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('Windows user'));
      } finally {
        if (savedUser !== undefined) process.env.USERNAME = savedUser;
        if (savedU !== undefined) process.env.USER = savedU;
        if (savedDomain !== undefined) process.env.USERDOMAIN = savedDomain;
      }
    });
  });

  it('uses a DOMAIN\\\\user account name when USERDOMAIN is set (win32)', async () => {
    await withPlatform('win32', async () => {
      const saved = { user: process.env.USERNAME, domain: process.env.USERDOMAIN };
      process.env.USERNAME = 'alice';
      process.env.USERDOMAIN = 'CORP';
      try {
        const cfgPath = path.join(tmp, 'dom.json');
        await fs.writeFile(cfgPath, JSON.stringify({ apiKey: 'plain' }));
        // icacls will run with CORP\alice; we only assert it doesn't throw.
        await expect(migratePlaintextSecrets(cfgPath, vault())).resolves.toBeDefined();
      } finally {
        if (saved.user !== undefined) process.env.USERNAME = saved.user; else delete process.env.USERNAME;
        if (saved.domain !== undefined) process.env.USERDOMAIN = saved.domain; else delete process.env.USERDOMAIN;
      }
    });
  });

  it('uses a bare username when USERDOMAIN is unset (win32)', async () => {
    await withPlatform('win32', async () => {
      const saved = { user: process.env.USERNAME, domain: process.env.USERDOMAIN };
      process.env.USERNAME = 'solo';
      delete process.env.USERDOMAIN;
      try {
        const cfgPath = path.join(tmp, 'bare.json');
        await fs.writeFile(cfgPath, JSON.stringify({ apiKey: 'plain' }));
        // icacls runs with the bare "solo" account name; assert it completes.
        await expect(migratePlaintextSecrets(cfgPath, vault())).resolves.toBeDefined();
      } finally {
        if (saved.user !== undefined) process.env.USERNAME = saved.user; else delete process.env.USERNAME;
        if (saved.domain !== undefined) process.env.USERDOMAIN = saved.domain; else delete process.env.USERDOMAIN;
      }
    });
  });
});

describe('decryptConfigSecrets', () => {
  it('zeroes a malformed encrypted field, warns, and walks arrays with null items', () => {
    const warn = vi.fn();
    const out = decryptConfigSecrets(
      { apiKey: 'enc:v1:bad', list: ['plain', null, 'two'], note: null },
      vault(),
      { warn },
    ) as { apiKey: string; list: Array<string | null>; note: null };
    expect(out.apiKey).toBe(''); // decrypt threw → field zeroed
    expect(out.list).toEqual(['plain', null, 'two']); // null array item passes through walk
    expect(out.note).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('falls back to console.warn when no warn callback is supplied', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // No opts → default warn arrow; malformed field forces it to fire.
    const out = decryptConfigSecrets({ apiKey: 'enc:v1:bad' }, vault()) as { apiKey: string };
    expect(out.apiKey).toBe('');
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('decrypts a round-tripped value, leaving non-secret fields untouched', () => {
    const v = vault();
    const enc = v.encrypt('hello');
    const out = decryptConfigSecrets({ apiKey: enc, plain: 'as-is' }, v) as { apiKey: string; plain: string };
    expect(out.apiKey).toBe('hello');
    expect(out.plain).toBe('as-is');
  });
});

describe('POSIX-platform branches (mocked)', () => {
  it('checks key-file permissions and chmods on a non-win32 platform', async () => {
    // Seed a valid key, then loosen its mode so checkKeyFilePermissions MUST
    // warn on every host. (On a real POSIX runner the vault creates the key
    // with a correct 0600, so without this the warning never fires; on a
    // Windows host stat reports 0666-ish either way.)
    vault().encrypt('seed');
    await fs.chmod(keyFile, 0o644);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await withPlatform('linux', async () => {
      // loadOrCreateKey → checkKeyFilePermissions runs statSync and warns
      // because the key file's mode is not 0o600.
      vault().encrypt('x');
      // migrate → restrictFilePermissions takes the POSIX chmod branch
      const cfgPath = path.join(tmp, 'posix.json');
      await fs.writeFile(cfgPath, JSON.stringify({ apiKey: 'plain' }));
      await migratePlaintextSecrets(cfgPath, vault());
    });
    expect(warn).toHaveBeenCalled(); // permission warning fired under the linux mock
  });
});
