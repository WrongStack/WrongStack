import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DefaultSecretVault } from '../../src/security/secret-vault.js';

// WS-03: opt-in passphrase-wrapped (KEK) key file. The wrapped format only
// activates when WRONGSTACK_VAULT_PASSPHRASE is set; otherwise behavior is the
// legacy/versioned format covered by secret-vault.test.ts.

const ENV = 'WRONGSTACK_VAULT_PASSPHRASE';
const WRAPPED_MAGIC = Buffer.from('WSKW', 'ascii');

let saved: string | undefined;
const dirs: string[] = [];
// Every vault is tracked so afterEach can drain pending key-file hardening
// promises (icacls on Windows) BEFORE the temp dirs are removed — a
// still-running hardening whose key file was already deleted fails and its
// console.warn fires during environment teardown, which vitest reports as an
// unhandled "Closing rpc while onUserConsoleLog was pending" error.
const activeVaults: DefaultSecretVault[] = [];
function trackVault(vault: DefaultSecretVault): DefaultSecretVault {
  activeVaults.push(vault);
  return vault;
}

async function mkKeyFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-vault-pp-'));
  dirs.push(dir);
  return path.join(dir, '.key');
}

function isWrappedOnDisk(keyFile: string): boolean {
  const buf = fsSync.readFileSync(keyFile);
  return buf.length === 81 && buf.subarray(0, 4).equals(WRAPPED_MAGIC);
}

beforeEach(() => {
  saved = process.env[ENV];
  delete process.env[ENV];
});
afterEach(async () => {
  // Drain pending key-file hardening BEFORE the temp dirs are removed (see
  // the activeVaults note above).
  await Promise.allSettled(
    activeVaults.splice(0, activeVaults.length).map((v) => v.flushHardening()),
  );
  if (saved === undefined) delete process.env[ENV];
  else process.env[ENV] = saved;
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

describe('DefaultSecretVault — passphrase KEK (WS-03)', () => {
  it('writes a wrapped key file when a passphrase is set, and round-trips', async () => {
    process.env[ENV] = 'correct horse battery staple';
    const keyFile = await mkKeyFile();
    const vault = trackVault(new DefaultSecretVault({ keyFile }));
    const enc = vault.encrypt('sk-secret');
    expect(vault.decrypt(enc)).toBe('sk-secret');
    // On disk the data key is wrapped, not raw.
    expect(isWrappedOnDisk(keyFile)).toBe(true);
    const raw = fsSync.readFileSync(keyFile);
    expect(raw.includes(Buffer.from('sk-secret'))).toBe(false);
  });

  it('a second process/instance with the same passphrase decrypts prior ciphertext', async () => {
    process.env[ENV] = 'pw-123';
    const keyFile = await mkKeyFile();
    const enc = trackVault(new DefaultSecretVault({ keyFile })).encrypt('value-A');
    // Fresh instance, same key file + passphrase → must unwrap and decrypt.
    const reopened = trackVault(new DefaultSecretVault({ keyFile }));
    expect(reopened.decrypt(enc)).toBe('value-A');
  });

  it('refuses to load a wrapped key file when the passphrase is absent', async () => {
    process.env[ENV] = 'pw-xyz';
    const keyFile = await mkKeyFile();
    const enc = trackVault(new DefaultSecretVault({ keyFile })).encrypt('v');
    expect(isWrappedOnDisk(keyFile)).toBe(true);
    // Passphrase removed → a fresh vault cannot unlock the key.
    delete process.env[ENV];
    const locked = trackVault(new DefaultSecretVault({ keyFile }));
    expect(() => locked.decrypt(enc)).toThrow(/passphrase-protected|WRONGSTACK_VAULT_PASSPHRASE/);
  });

  it('rejects a wrong passphrase (GCM auth failure)', async () => {
    process.env[ENV] = 'right-pass';
    const keyFile = await mkKeyFile();
    const enc = trackVault(new DefaultSecretVault({ keyFile })).encrypt('v');
    process.env[ENV] = 'wrong-pass';
    const wrong = trackVault(new DefaultSecretVault({ keyFile }));
    expect(() => wrong.decrypt(enc)).toThrow(/wrong|unwrap|passphrase/i);
  });

  it('auto-migrates an existing unwrapped key to wrapped, preserving the data key', async () => {
    // 1. Create an unwrapped (legacy) key file with NO passphrase.
    const keyFile = await mkKeyFile();
    const enc = trackVault(new DefaultSecretVault({ keyFile })).encrypt('legacy-secret');
    expect(isWrappedOnDisk(keyFile)).toBe(false);
    // 2. Now set a passphrase and load again → file upgrades to wrapped, and
    //    the SAME data key is preserved (prior ciphertext still decrypts).
    process.env[ENV] = 'new-passphrase';
    const upgraded = trackVault(new DefaultSecretVault({ keyFile }));
    expect(upgraded.decrypt(enc)).toBe('legacy-secret');
    expect(isWrappedOnDisk(keyFile)).toBe(true);
  });

  it('keeps the key wrapped across a rotateKey()', async () => {
    process.env[ENV] = 'rot-pass';
    const keyFile = await mkKeyFile();
    const vault = trackVault(new DefaultSecretVault({ keyFile }));
    const before = vault.encrypt('x');
    expect(vault.decrypt(before)).toBe('x');
    const { newVersion } = vault.rotateKey();
    expect(newVersion).toBe(2);
    expect(isWrappedOnDisk(keyFile)).toBe(true);
    // New encryptions use the rotated key and still round-trip.
    const after = vault.encrypt('y');
    expect(vault.decrypt(after)).toBe('y');
  });

  it('does NOT wrap when no passphrase is set (default behavior unchanged)', async () => {
    const keyFile = await mkKeyFile();
    const vault = trackVault(new DefaultSecretVault({ keyFile }));
    vault.encrypt('z');
    expect(isWrappedOnDisk(keyFile)).toBe(false);
    expect(fsSync.readFileSync(keyFile).length).toBe(32); // legacy raw key
  });
});
