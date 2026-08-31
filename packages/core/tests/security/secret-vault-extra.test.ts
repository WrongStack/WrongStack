import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as filePermissions from '../../src/security/file-permissions.js';
import {
  DefaultSecretVault,
  decryptConfigSecrets,
  encryptConfigSecrets,
  migratePlaintextSecrets,
} from '../../src/security/secret-vault.js';

// The EEXIST race test needs to control sync readFileSync/writeFileSync.
// Default implementations are the real functions, so every other test in
// this file behaves exactly as before.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
    writeFileSync: vi.fn(actual.writeFileSync),
  };
});

let tmp: string;
let keyFile: string;
// Every vault created via the helper is tracked so afterEach can drain its
// pending key-file hardening promises (see the afterEach rationale).
const activeVaults: DefaultSecretVault[] = [];
const vault = () => {
  const v = new DefaultSecretVault({ keyFile });
  activeVaults.push(v);
  return v;
};

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
  // Drain pending key-file hardening promises BEFORE removing the tmp dir.
  // `scheduleKeyHardening()` shells out to `icacls` on Windows; tests that
  // only call encrypt/decrypt never flush those promises. If the hardening
  // is still in flight when fs.rm deletes the key file, it fails and its
  // console.warn fallback fires during environment teardown — vitest then
  // reports an unhandled "Closing rpc while onUserConsoleLog was pending"
  // EnvironmentTeardownError. Flushing here keeps every async warning inside
  // the hook, while the environment is still open.
  await Promise.allSettled(
    activeVaults.splice(0, activeVaults.length).map((v) => v.flushHardening()),
  );
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

  it('re-reads the winner key when a concurrent create wins the race (EEXIST)', () => {
    // Seed a valid key file — this is what the racing "winner" wrote.
    const winner = vault();
    const winnerEnc = winner.encrypt('winner-secret');
    const winnerBytes = fsSync.readFileSync(keyFile);

    // Simulate the race in loadOrCreateKey: our first read sees ENOENT (the
    // file is not there yet), our exclusive 'wx' write then loses to another
    // process (EEXIST), and the re-read must adopt the winner's key instead of
    // generating a fresh one (which would orphan every value encrypted so far).
    const readMock = vi.mocked(fsSync.readFileSync);
    readMock.mockClear(); // drop the seed vault's real reads from the count
    const writeMock = vi.mocked(fsSync.writeFileSync);
    writeMock.mockClear(); // drop the seed vault's real write from the count
    readMock.mockImplementationOnce(() => {
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });
    readMock.mockImplementationOnce(() => winnerBytes);
    writeMock.mockImplementationOnce(() => {
      const err = new Error('EEXIST') as NodeJS.ErrnoException;
      err.code = 'EEXIST';
      throw err;
    });

    try {
      const v = vault();
      v.encrypt('race-value');
      // The re-read must have surfaced the winner's key: a value the winner
      // encrypted before the race still decrypts, which a fresh key would
      // never allow (auth-tag mismatch).
      expect(v.decrypt(winnerEnc)).toBe('winner-secret');
      // Pin the mock call sequence: exactly read(ENOENT) → write(EEXIST) →
      // read(winner). If a future refactor inserts an extra sync fs call in
      // loadOrCreateKey, a once-mock would be consumed by the wrong call and
      // the EEXIST branch would silently stop being exercised.
      expect(readMock).toHaveBeenCalledTimes(2);
      expect(writeMock).toHaveBeenCalledTimes(1);
    } finally {
      readMock.mockRestore();
      writeMock.mockRestore();
    }
  });
});

describe('encryptConfigSecrets array handling', () => {
  it('walks arrays while encrypting secret fields', () => {
    const v = vault();
    const out = encryptConfigSecrets(
      { apiKey: 'k', list: ['a', 'b'], nested: { tokens: ['x'] } },
      v,
    ) as { apiKey: string; list: string[] };
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
    await fs.writeFile(
      cfgPath,
      JSON.stringify({
        apiKey: 'plain-secret',
        servers: [{ token: 't1' }, null, 'plain-array-string'],
        note: null,
      }),
    );
    const warn = vi.fn();
    const res = await migratePlaintextSecrets(cfgPath, vault(), { warn });
    expect(res.migrated).toBeGreaterThan(0);
    const written = JSON.parse(await fs.readFile(cfgPath, 'utf8'));
    expect(vault().isEncrypted(written.apiKey)).toBe(true);
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
      // The key-file hardening scheduled under the mocked platform warns via
      // the console.warn fallback; spy it out so the asserted logger warning
      // is the only one leaving this test.
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const cfgPath = path.join(tmp, 'win.json');
        await fs.writeFile(cfgPath, JSON.stringify({ apiKey: 'plain' }));
        await migratePlaintextSecrets(cfgPath, vault(), { warn });
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('Windows user'));
      } finally {
        warnSpy.mockRestore();
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
      // CORP\alice does not exist on this machine, so both the key-file and
      // the config hardening deterministically fail icacls here; spy out the
      // console.warn fallback so the negative path stays silent.
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const cfgPath = path.join(tmp, 'dom.json');
        await fs.writeFile(cfgPath, JSON.stringify({ apiKey: 'plain' }));
        // icacls will run with CORP\alice; we only assert it doesn't throw.
        await expect(migratePlaintextSecrets(cfgPath, vault())).resolves.toBeDefined();
      } finally {
        warnSpy.mockRestore();
        if (saved.user !== undefined) process.env.USERNAME = saved.user;
        else delete process.env.USERNAME;
        if (saved.domain !== undefined) process.env.USERDOMAIN = saved.domain;
        else delete process.env.USERDOMAIN;
      }
    });
  });

  it('uses a bare username when USERDOMAIN is unset (win32)', async () => {
    await withPlatform('win32', async () => {
      const saved = { user: process.env.USERNAME, domain: process.env.USERDOMAIN };
      process.env.USERNAME = 'solo';
      delete process.env.USERDOMAIN;
      // The bare "solo" account does not exist on this machine either, so the
      // hardening fails icacls by design; keep its console.warn fallback out
      // of the test output.
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const cfgPath = path.join(tmp, 'bare.json');
        await fs.writeFile(cfgPath, JSON.stringify({ apiKey: 'plain' }));
        // icacls runs with the bare "solo" account name; assert it completes.
        await expect(migratePlaintextSecrets(cfgPath, vault())).resolves.toBeDefined();
      } finally {
        warnSpy.mockRestore();
        if (saved.user !== undefined) process.env.USERNAME = saved.user;
        else delete process.env.USERNAME;
        if (saved.domain !== undefined) process.env.USERDOMAIN = saved.domain;
        else delete process.env.USERDOMAIN;
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
    const out = decryptConfigSecrets({ apiKey: enc, plain: 'as-is' }, v) as {
      apiKey: string;
      plain: string;
    };
    expect(out.apiKey).toBe('hello');
    expect(out.plain).toBe('as-is');
  });
});

describe('POSIX-platform branches (mocked)', () => {
  it('calls restrictFilePermissions for key-file and config hardening on a non-win32 platform', async () => {
    // Seed a valid key, then loosen its mode so checkKeyFilePermissions MUST
    // warn on every host. (On a real POSIX runner the vault creates the key
    // with a correct 0600, so without this the warning never fires; on a
    // Windows host stat reports 0666-ish either way.)
    vault().encrypt('seed');
    await fs.chmod(keyFile, 0o644);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const restrictSpy = vi.spyOn(filePermissions, 'restrictFilePermissions');
    let releaseRepair!: () => void;
    const pendingRepair = new Promise<void>((resolve) => {
      releaseRepair = resolve;
    });
    restrictSpy.mockImplementationOnce(() => pendingRepair);
    await withPlatform('linux', async () => {
      // loadOrCreateKey → checkKeyFilePermissions runs statSync and warns
      // because the key file's mode is not 0o600.
      const repairingVault = vault();
      repairingVault.encrypt('x');
      let flushed = false;
      const flush = repairingVault.flushHardening!().then(() => {
        flushed = true;
      });
      await Promise.resolve();
      expect(flushed).toBe(false);
      releaseRepair();
      await flush;
      // migrate → restrictFilePermissions takes the POSIX chmod branch
      const cfgPath = path.join(tmp, 'posix.json');
      await fs.writeFile(cfgPath, JSON.stringify({ apiKey: 'plain' }));
      await migratePlaintextSecrets(cfgPath, vault());
    });
    // WS-088 regression guard: the key-file hardening call must actually
    // happen. Pin the argument so the pre-existing config-file hardening in
    // migratePlaintextSecrets can't satisfy the assertion alone.
    expect(restrictSpy).toHaveBeenCalledWith(keyFile, expect.anything());
    expect(warn).toHaveBeenCalled(); // permission warning fired under the linux mock
  });
});
