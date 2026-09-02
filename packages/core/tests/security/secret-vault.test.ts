import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DefaultSecretVault,
  decryptConfigSecrets,
  encryptConfigSecrets,
  rewriteConfigEncrypted,
  rotateConfigKeys,
} from '../../src/security/secret-vault.js';

// Every vault and temp dir created here is tracked so afterEach can drain
// pending key-file hardening promises BEFORE the temp dirs are removed.
// `scheduleKeyHardening()` shells out to `icacls` on Windows; if a hardening
// is still in flight when fs.rm deletes the key file, it fails and its
// console.warn fallback fires during environment teardown — vitest then
// reports an unhandled "Closing rpc while onUserConsoleLog was pending"
// EnvironmentTeardownError. Flushing inside the hook keeps every async
// warning inside the window where the environment is still open.
const activeVaults: DefaultSecretVault[] = [];
const tmpDirs: string[] = [];

function trackVault(vault: DefaultSecretVault): DefaultSecretVault {
  activeVaults.push(vault);
  return vault;
}

async function makeVault() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-vault-'));
  tmpDirs.push(dir);
  const keyFile = path.join(dir, '.key');
  return { dir, keyFile, vault: trackVault(new DefaultSecretVault({ keyFile })) };
}

afterEach(async () => {
  await Promise.allSettled(
    activeVaults.splice(0, activeVaults.length).map((v) => v.flushHardening()),
  );
  for (const dir of tmpDirs.splice(0, tmpDirs.length)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe('DefaultSecretVault', () => {
  it('encrypt/decrypt round-trip with auto-generated key', async () => {
    const { vault } = await makeVault();
    const enc = vault.encrypt('sk-test-1234');
    expect(enc.startsWith('enc:v1:')).toBe(true);
    expect(enc).not.toContain('sk-test-1234');
    expect(vault.decrypt(enc)).toBe('sk-test-1234');
  });

  it('passes plaintext through unchanged on decrypt', async () => {
    const { vault } = await makeVault();
    expect(vault.decrypt('plain-key')).toBe('plain-key');
    expect(vault.isEncrypted('plain-key')).toBe(false);
  });

  it('does not re-encrypt an already-encrypted value', async () => {
    const { vault } = await makeVault();
    const enc = vault.encrypt('secret');
    const enc2 = vault.encrypt(enc);
    expect(enc2).toBe(enc);
  });

  it('different IVs produce different ciphertexts for the same plaintext', async () => {
    const { vault } = await makeVault();
    const a = vault.encrypt('same');
    const b = vault.encrypt('same');
    expect(a).not.toBe(b);
    expect(vault.decrypt(a)).toBe('same');
    expect(vault.decrypt(b)).toBe('same');
  });

  it('rejects malformed encrypted values', async () => {
    const { vault } = await makeVault();
    expect(() => vault.decrypt('enc:v1:bad')).toThrow(/malformed/);
  });

  it('creates key file with restrictive mode (best-effort)', async () => {
    const { keyFile, vault } = await makeVault();
    vault.encrypt('x');
    const stat = fsSync.statSync(keyFile);
    expect(stat.size).toBe(32);
    if (process.platform !== 'win32') {
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });

  it('decryptConfigSecrets walks nested apiKey fields', async () => {
    const { vault } = await makeVault();
    const cfg = {
      apiKey: vault.encrypt('top'),
      providers: {
        a: { apiKey: vault.encrypt('aaa') },
        b: { apiKey: 'plain', baseUrl: 'http://x' },
      },
      mcpServers: { s: { authToken: vault.encrypt('mcp') } },
    };
    const dec = decryptConfigSecrets(cfg, vault) as typeof cfg;
    expect(dec.apiKey).toBe('top');
    expect(dec.providers.a.apiKey).toBe('aaa');
    expect(dec.providers.b.apiKey).toBe('plain');
    expect(dec.providers.b.baseUrl).toBe('http://x');
    expect(dec.mcpServers.s.authToken).toBe('mcp');
  });

  it('throws when key file has wrong size instead of silently overwriting', async () => {
    const { keyFile, vault: _vault } = await makeVault();
    // Write a key that is the wrong size (16 bytes instead of 32).
    fsSync.writeFileSync(keyFile, Buffer.alloc(16));
    const vault = trackVault(new DefaultSecretVault({ keyFile }));
    expect(() => vault.encrypt('anything')).toThrow(/is 16 bytes/);
    expect(() => vault.encrypt('anything')).toThrow(/expected 32/);
  });

  it('encryptConfigSecrets covers refreshToken / sessionKey / password / private_key (suffix matching)', async () => {
    const { vault } = await makeVault();
    const enc = encryptConfigSecrets(
      {
        refreshToken: 'r-1',
        sessionKey: 's-1',
        password: 'p-1',
        client_secret: 'cs-1',
        private_key: 'pk-1',
        Bearer: 'B-1',
        publicKey: 'pub-not-secret',
        baseUrl: 'http://x',
      },
      vault,
    ) as Record<string, string>;
    expect(enc.refreshToken?.startsWith('enc:v1:')).toBe(true);
    expect(enc.sessionKey?.startsWith('enc:v1:')).toBe(true);
    expect(enc.password?.startsWith('enc:v1:')).toBe(true);
    expect(enc.client_secret?.startsWith('enc:v1:')).toBe(true);
    expect(enc.private_key?.startsWith('enc:v1:')).toBe(true);
    expect(enc.Bearer?.startsWith('enc:v1:')).toBe(true);
    // publicKey is on the override list — must NOT be encrypted.
    expect(enc.publicKey).toBe('pub-not-secret');
    expect(enc.baseUrl).toBe('http://x');
  });

  it('encryptConfigSecrets idempotent on already-encrypted values', async () => {
    const { vault } = await makeVault();
    const enc1 = encryptConfigSecrets({ providers: { a: { apiKey: 'plain' } } }, vault) as {
      providers: { a: { apiKey: string } };
    };
    expect(enc1.providers.a.apiKey.startsWith('enc:v1:')).toBe(true);
    const enc2 = encryptConfigSecrets(enc1, vault) as typeof enc1;
    expect(enc2.providers.a.apiKey).toBe(enc1.providers.a.apiKey);
  });

  it('migratePlaintextSecrets encrypts plaintext apiKey fields in place', async () => {
    const { dir, vault } = await makeVault();
    const cfgPath = path.join(dir, 'config.json');
    await fs.writeFile(
      cfgPath,
      JSON.stringify(
        {
          version: 1,
          provider: 'a',
          model: 'm',
          apiKey: 'top-level-plain',
          providers: {
            a: { type: 'a', apiKey: 'nested-plain' },
            b: { type: 'b', apiKey: vault.encrypt('already-encrypted') },
          },
          mcpServers: { s: { authToken: 'mcp-plain' } },
        },
        null,
        2,
      ),
    );
    const { migrated } = await (
      await import('../../src/security/secret-vault.js')
    ).migratePlaintextSecrets(cfgPath, vault);
    expect(migrated).toBe(3); // top-level apiKey + providers.a.apiKey + mcpServers.s.authToken
    const after = JSON.parse(await fs.readFile(cfgPath, 'utf8')) as {
      apiKey: string;
      providers: { a: { apiKey: string }; b: { apiKey: string } };
      mcpServers: { s: { authToken: string } };
    };
    expect(after.apiKey.startsWith('enc:v1:')).toBe(true);
    expect(after.providers.a.apiKey.startsWith('enc:v1:')).toBe(true);
    expect(after.providers.b.apiKey.startsWith('enc:v1:')).toBe(true);
    expect(after.mcpServers.s.authToken.startsWith('enc:v1:')).toBe(true);
    expect(vault.decrypt(after.apiKey)).toBe('top-level-plain');
    expect(vault.decrypt(after.providers.a.apiKey)).toBe('nested-plain');
    expect(vault.decrypt(after.mcpServers.s.authToken)).toBe('mcp-plain');
  });

  it('migratePlaintextSecrets is a no-op when nothing is plaintext', async () => {
    const { dir, vault } = await makeVault();
    const cfgPath = path.join(dir, 'config.json');
    await fs.writeFile(
      cfgPath,
      JSON.stringify({
        version: 1,
        providers: { a: { type: 'a', apiKey: vault.encrypt('already') } },
      }),
    );
    const before = await fs.readFile(cfgPath, 'utf8');
    const { migrated } = await (
      await import('../../src/security/secret-vault.js')
    ).migratePlaintextSecrets(cfgPath, vault);
    expect(migrated).toBe(0);
    const after = await fs.readFile(cfgPath, 'utf8');
    expect(after).toBe(before);
  });

  it('migratePlaintextSecrets ignores missing files', async () => {
    const { dir, vault } = await makeVault();
    const result = await (
      await import('../../src/security/secret-vault.js')
    ).migratePlaintextSecrets(path.join(dir, 'nope.json'), vault);
    expect(result.migrated).toBe(0);
  });

  it('rewriteConfigEncrypted merges + encrypts + writes 0600 file', async () => {
    const { dir, vault } = await makeVault();
    const cfgPath = path.join(dir, 'config.json');
    await fs.writeFile(cfgPath, JSON.stringify({ version: 1, provider: 'a', model: 'm' }, null, 2));
    await rewriteConfigEncrypted(cfgPath, vault, {
      providers: { foo: { type: 'foo', apiKey: 'newkey', family: 'openai' } },
    });
    const raw = JSON.parse(await fs.readFile(cfgPath, 'utf8')) as {
      providers: { foo: { apiKey: string } };
      version: number;
    };
    expect(raw.version).toBe(1);
    expect(raw.providers.foo.apiKey.startsWith('enc:v1:')).toBe(true);
    expect(vault.decrypt(raw.providers.foo.apiKey)).toBe('newkey');
  });
});

describe('Key rotation', () => {
  it('starts at keyVersion 1 for new vaults', async () => {
    const { vault } = await makeVault();
    expect(vault.keyVersion).toBe(1);
  });

  it('encrypt emits enc:v1: prefix before rotation', async () => {
    const { vault } = await makeVault();
    const enc = vault.encrypt('secret');
    expect(enc.startsWith('enc:v1:')).toBe(true);
  });

  it('rotateKey increments version and writes versioned key file', async () => {
    const { keyFile, vault } = await makeVault();
    // Encrypt something with v1 key
    const v1Enc = vault.encrypt('secret-v1');
    expect(v1Enc.startsWith('enc:v1:')).toBe(true);
    expect(vault.keyVersion).toBe(1);

    // Rotate the key
    const result = vault.rotateKey();
    expect(result.oldVersion).toBe(1);
    expect(result.newVersion).toBe(2);
    expect(vault.keyVersion).toBe(2);

    // Key file should now be 37 bytes (4 magic + 1 version + 32 key)
    const stat = fsSync.statSync(keyFile);
    expect(stat.size).toBe(37);

    // New encryptions should use v2 prefix
    const v2Enc = vault.encrypt('secret-v2');
    expect(v2Enc.startsWith('enc:v2:')).toBe(true);

    // v1-encrypted values CANNOT be decrypted after rotation
    // because the key material changed (this is the whole point of rotation)
    expect(() => vault.decrypt(v1Enc)).toThrow();
    // But v2-encrypted values work fine
    expect(vault.decrypt(v2Enc)).toBe('secret-v2');
  });

  it('rotateKey generates a new key that differs from the old one', async () => {
    const { keyFile, vault } = await makeVault();
    const v1Enc = vault.encrypt('test');

    // Read the old key
    const oldKey = fsSync.readFileSync(keyFile);

    // Rotate
    vault.rotateKey();

    // Read the new key
    const newKey = fsSync.readFileSync(keyFile);

    // Keys should differ (after stripping the 5-byte header from new key)
    expect(newKey.length).toBe(37);
    expect(oldKey.length).toBe(32);
    // The actual key material (last 32 bytes of new key) should differ from old key
    const newKeyMaterial = newKey.subarray(5);
    expect(newKeyMaterial.equals(oldKey)).toBe(false);

    // Old encrypted value should fail to decrypt with new key
    // (because the key material changed, not just the prefix)
    expect(() => vault.decrypt(v1Enc)).toThrow();
  });

  it('multiple rotations increment version correctly', async () => {
    const { vault } = await makeVault();
    expect(vault.keyVersion).toBe(1);

    vault.rotateKey();
    expect(vault.keyVersion).toBe(2);

    vault.rotateKey();
    expect(vault.keyVersion).toBe(3);

    vault.rotateKey();
    expect(vault.keyVersion).toBe(4);

    const enc = vault.encrypt('test');
    expect(enc.startsWith('enc:v4:')).toBe(true);
  });

  it('isEncrypted recognizes all version prefixes', async () => {
    const { vault } = await makeVault();
    expect(vault.isEncrypted('enc:v1:abc:def:ghi')).toBe(true);
    expect(vault.isEncrypted('enc:v2:abc:def:ghi')).toBe(true);
    expect(vault.isEncrypted('enc:v99:abc:def:ghi')).toBe(true);
    expect(vault.isEncrypted('enc:v0:abc:def:ghi')).toBe(true);
    expect(vault.isEncrypted('plaintext')).toBe(false);
    expect(vault.isEncrypted('enc:invalid')).toBe(false);
    expect(vault.isEncrypted('')).toBe(false);
  });

  it('new vault instance reads versioned key file correctly', async () => {
    const { keyFile, vault: vault1 } = await makeVault();
    vault1.rotateKey(); // Now at v2
    const enc = vault1.encrypt('secret');
    expect(enc.startsWith('enc:v2:')).toBe(true);

    // Create a new vault instance pointing to the same key file
    const vault2 = trackVault(new DefaultSecretVault({ keyFile }));
    expect(vault2.keyVersion).toBe(2);
    expect(vault2.decrypt(enc)).toBe('secret');
  });

  it('legacy 32-byte key file is still readable', async () => {
    const { keyFile } = await makeVault();
    // Write a legacy 32-byte key file
    const legacyKey = Buffer.alloc(32, 0xab);
    fsSync.writeFileSync(keyFile, legacyKey);

    const vault = trackVault(new DefaultSecretVault({ keyFile }));
    expect(vault.keyVersion).toBe(1);

    // Should be able to encrypt/decrypt
    const enc = vault.encrypt('test');
    expect(enc.startsWith('enc:v1:')).toBe(true);
    expect(vault.decrypt(enc)).toBe('test');
  });

  it('rotateConfigKeys re-encrypts all secrets with new key', async () => {
    const { dir, vault } = await makeVault();
    const cfgPath = path.join(dir, 'config.json');

    // Write a config with v1-encrypted secrets
    const secret1 = 'api-key-1';
    const secret2 = 'api-key-2';
    const enc1 = vault.encrypt(secret1);
    const enc2 = vault.encrypt(secret2);
    expect(enc1.startsWith('enc:v1:')).toBe(true);

    await fs.writeFile(
      cfgPath,
      JSON.stringify({
        version: 1,
        providers: {
          anthropic: { apiKey: enc1 },
          openai: { apiKey: enc2 },
        },
      }),
    );

    // Rotate
    const result = await rotateConfigKeys(cfgPath, vault);
    expect(result.oldVersion).toBe(1);
    expect(result.newVersion).toBe(2);
    expect(result.rotated).toBe(2);

    // Read back the config
    const after = JSON.parse(await fs.readFile(cfgPath, 'utf8')) as {
      providers: { anthropic: { apiKey: string }; openai: { apiKey: string } };
    };

    // All secrets should now be v2-encrypted
    expect(after.providers.anthropic.apiKey.startsWith('enc:v2:')).toBe(true);
    expect(after.providers.openai.apiKey.startsWith('enc:v2:')).toBe(true);

    // Should decrypt correctly with the new key
    expect(vault.decrypt(after.providers.anthropic.apiKey)).toBe(secret1);
    expect(vault.decrypt(after.providers.openai.apiKey)).toBe(secret2);
  });

  it('rotateConfigKeys handles missing config file gracefully', async () => {
    const { dir, vault } = await makeVault();
    const cfgPath = path.join(dir, 'nonexistent.json');

    const result = await rotateConfigKeys(cfgPath, vault);
    expect(result.rotated).toBe(0);
    expect(result.oldVersion).toBe(1);
    expect(result.newVersion).toBe(2);
    expect(vault.keyVersion).toBe(2);
  });

  it('rotateConfigKeys handles config with no encrypted fields', async () => {
    const { dir, vault } = await makeVault();
    const cfgPath = path.join(dir, 'config.json');

    await fs.writeFile(
      cfgPath,
      JSON.stringify({
        version: 1,
        providers: {
          anthropic: { type: 'anthropic', baseUrl: 'https://api.example.com' },
        },
      }),
    );

    const result = await rotateConfigKeys(cfgPath, vault);
    expect(result.rotated).toBe(0);
    expect(result.oldVersion).toBe(1);
    expect(result.newVersion).toBe(2);
  });

  it('rotateConfigKeys handles malformed JSON gracefully', async () => {
    const { dir, vault } = await makeVault();
    const cfgPath = path.join(dir, 'config.json');

    await fs.writeFile(cfgPath, 'not valid json {{{');

    const result = await rotateConfigKeys(cfgPath, vault);
    expect(result.rotated).toBe(0);
    // Key should NOT be rotated if config is malformed
    expect(vault.keyVersion).toBe(1);
  });

  it('rotateConfigKeys aborts and preserves the key when a field cannot be decrypted', async () => {
    const { dir, vault } = await makeVault();
    const cfgPath = path.join(dir, 'config.json');

    // One valid v1 secret and one well-formed-but-corrupt v1 ciphertext
    // (passes isEncrypted, fails GCM auth on decrypt).
    const good = vault.encrypt('api-key-good');
    expect(good.startsWith('enc:v1:')).toBe(true);
    // Tamper the final ciphertext hex char so the auth tag check fails on
    // decrypt, while keeping the enc:v1: prefix so isEncrypted() stays true.
    // Flip relative to the original char to guarantee an actual change.
    const last = good.slice(-1);
    const corrupt = `${good.slice(0, -1)}${last === '0' ? '1' : '0'}`;
    expect(corrupt).not.toBe(good);
    expect(vault.isEncrypted(corrupt)).toBe(true);

    await fs.writeFile(
      cfgPath,
      JSON.stringify({
        version: 1,
        providers: {
          anthropic: { apiKey: good },
          openai: { apiKey: corrupt },
        },
      }),
    );

    // Rotation must throw, naming the offending field path...
    await expect(rotateConfigKeys(cfgPath, vault)).rejects.toThrow(/providers\.openai\.apiKey/);

    // ...and must NOT have rotated the key (old key still intact, so the
    // valid field remains recoverable).
    expect(vault.keyVersion).toBe(1);

    // The config file is left untouched: both values are still the original
    // v1 ciphertext, and the good one still decrypts with the unrotated key.
    const after = JSON.parse(await fs.readFile(cfgPath, 'utf8')) as {
      providers: { anthropic: { apiKey: string }; openai: { apiKey: string } };
    };
    expect(after.providers.anthropic.apiKey).toBe(good);
    expect(after.providers.openai.apiKey).toBe(corrupt);
    expect(vault.decrypt(after.providers.anthropic.apiKey)).toBe('api-key-good');
  });
});
