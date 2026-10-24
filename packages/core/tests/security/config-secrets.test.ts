import type { SecretVault } from '@wrongstack/contracts/types/secret-vault';
import { describe, expect, it, vi } from 'vitest';
import { decryptConfigSecretsForRewrite } from '../../src/security/config-secrets.js';
import {
  decryptConfigSecrets,
  encryptConfigSecrets,
  isSecretField,
} from '../../src/security/secret-vault.js';

const makeVault = (): SecretVault => ({
  encrypt: (s) => `enc:${s}`,
  decrypt: (s) => (s.startsWith('enc:') ? s.slice(4) : s),
  isEncrypted: (s) => s.startsWith('enc:'),
});

describe('isSecretField', () => {
  it.each([
    'apiKey',
    'api_key',
    'API_KEY',
    'authToken',
    'auth_token',
    'refreshToken',
    'refresh_token',
    'sessionKey',
    'session_key',
    'accessToken',
    'access_token',
    'access-token',
    'privateKey',
    'private_key',
    'private-key',
    'password',
    'passwd',
    'pwd',
    'bearer',
    'clientSecret',
    'client_secret',
    // OmniRoute's management access token (ProviderConfig.managementToken).
    'managementToken',
  ])('flags %s as secret', (name) => {
    expect(isSecretField(name)).toBe(true);
  });

  it.each(['publicKey', 'public_key', 'PUBLICKEY'])('exempts %s', (name) => {
    expect(isSecretField(name)).toBe(false);
  });

  it.each(['username', 'email', 'host', 'port', 'name', 'url'])('does not flag %s', (name) => {
    expect(isSecretField(name)).toBe(false);
  });
});

describe('encryptConfigSecrets', () => {
  it('encrypts secret-named string fields only', () => {
    const vault = makeVault();
    const out = encryptConfigSecrets({ apiKey: 'sk-abc', endpoint: 'https://x', port: 443 }, vault);
    expect(out).toEqual({ apiKey: 'enc:sk-abc', endpoint: 'https://x', port: 443 });
  });

  it('walks nested objects', () => {
    const vault = makeVault();
    const out = encryptConfigSecrets({ provider: { name: 'anthropic', apiKey: 'sk-abc' } }, vault);
    expect(out).toEqual({ provider: { name: 'anthropic', apiKey: 'enc:sk-abc' } });
  });

  it('walks arrays', () => {
    const vault = makeVault();
    const out = encryptConfigSecrets({ providers: [{ apiKey: 'one' }, { apiKey: 'two' }] }, vault);
    expect(out).toEqual({ providers: [{ apiKey: 'enc:one' }, { apiKey: 'enc:two' }] });
  });

  it('passes through null and undefined', () => {
    const vault = makeVault();
    expect(encryptConfigSecrets(null, vault)).toBe(null);
    expect(encryptConfigSecrets(undefined, vault)).toBe(undefined);
  });

  it('does not encrypt non-string values even at secret-named keys', () => {
    const vault = makeVault();
    const out = encryptConfigSecrets({ apiKey: 42 as never as string }, vault);
    expect(out).toEqual({ apiKey: 42 });
  });

  it('does not mutate input', () => {
    const vault = makeVault();
    const input = { apiKey: 'sk-abc' };
    const out = encryptConfigSecrets(input, vault);
    expect(input).toEqual({ apiKey: 'sk-abc' });
    expect(out).not.toBe(input);
  });
});

describe('decryptConfigSecrets', () => {
  it('decrypts secret-named fields', () => {
    const vault = makeVault();
    const out = decryptConfigSecrets({ apiKey: 'enc:sk-abc' }, vault);
    expect(out).toEqual({ apiKey: 'sk-abc' });
  });

  it('zeroes a field and warns on decrypt failure', () => {
    const vault: SecretVault = {
      encrypt: (s) => s,
      decrypt: () => {
        throw new Error('corrupt');
      },
      isEncrypted: () => true,
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = decryptConfigSecrets({ apiKey: 'enc:bad' }, vault);
    expect(out).toEqual({ apiKey: '' });
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls[0]![0]).toMatch(/apiKey/);
    warn.mockRestore();
  });

  it('continues walking after a decrypt failure', () => {
    const vault: SecretVault = {
      encrypt: (s) => s,
      decrypt: (s) => {
        if (s === 'bad') throw new Error('corrupt');
        return s.replace(/^enc:/, '');
      },
      isEncrypted: () => true,
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = decryptConfigSecrets(
      { providers: [{ apiKey: 'bad' }, { apiKey: 'enc:good' }] },
      vault,
    );
    expect(out).toEqual({ providers: [{ apiKey: '' }, { apiKey: 'good' }] });
    warn.mockRestore();
  });

  it('encrypt then decrypt is a roundtrip', () => {
    const vault = makeVault();
    const original = { apiKey: 'secret-1', nested: { authToken: 'secret-2', port: 80 } };
    const encrypted = encryptConfigSecrets(original, vault);
    const decrypted = decryptConfigSecrets(encrypted, vault);
    expect(decrypted).toEqual(original);
  });
});

describe('typesafe account credential', () => {
  it('encrypts typesafe.apiKey at rest and leaves the rest of the block plain', () => {
    // The encryption is driven ENTIRELY by the field NAME, and `typesafe` is a
    // nested block the walker has to recurse into. Renaming this field to
    // something `SECRET_KEY_PATTERN` does not match — `key`, `credential`,
    // `token_id` — would silently start writing a live API key to disk in
    // plaintext, with nothing else in the system objecting. This test is the
    // only thing standing between that rename and a leaked key.
    const vault = makeVault();
    const config = {
      typesafe: {
        apiKey: 'sk-live-typesafe',
        endpoint: 'https://api.typesafe.ai/v1/systemone',
        model: 'jev-latest',
        requestTimeoutMs: 4000,
      },
    };

    const onDisk = encryptConfigSecrets(config, vault);

    expect(onDisk.typesafe.apiKey).toBe('enc:sk-live-typesafe');
    // Non-secret siblings must stay readable: an operator has to be able to see
    // which host their prompts are going to.
    expect(onDisk.typesafe.endpoint).toBe('https://api.typesafe.ai/v1/systemone');
    expect(onDisk.typesafe.model).toBe('jev-latest');
    expect(onDisk.typesafe.requestTimeoutMs).toBe(4000);

    // And it round-trips, so the resolver sees a usable key.
    expect(decryptConfigSecrets(onDisk, vault).typesafe.apiKey).toBe('sk-live-typesafe');
  });
});

describe('decryptConfigSecretsForRewrite', () => {
  // A field sealed under another / rotated key: decrypt throws, and
  // encrypt passes an already-encrypted value through unchanged.
  const failing: SecretVault = {
    encrypt: (s) => (s.startsWith('enc:') ? s : `enc:${s}`),
    decrypt: (s) => {
      if (s === 'enc:foreign') throw new Error('bad auth tag');
      return s.startsWith('enc:') ? s.slice(4) : s;
    },
    isEncrypted: (s) => s.startsWith('enc:'),
    keyVersion: 1,
  };
  const warn = vi.fn();

  it('runtime decrypt still blanks what it cannot read', () => {
    expect(decryptConfigSecrets({ apiKey: 'enc:foreign' }, failing, { warn }).apiKey).toBe('');
  });

  it('keeps the ciphertext so a read-modify-write round-trips it byte-for-byte', () => {
    const cfg = { apiKey: 'enc:foreign', providers: { a: { apiKey: 'enc:ok' } } };
    const decrypted = decryptConfigSecretsForRewrite(cfg, failing, { warn });
    expect(decrypted.apiKey).toBe('enc:foreign');
    expect(decrypted.providers.a.apiKey).toBe('ok');
    expect(encryptConfigSecrets(decrypted, failing)).toEqual(cfg);
  });
});
