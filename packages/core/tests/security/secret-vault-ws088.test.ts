import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock file-permissions so we can spy on the actual restrictFilePermissions
// export — the function that the WS-088 fix calls on the fresh-key path.
// The spy captures call args without touching the filesystem or shelling
// out to icacls/chmod.
vi.mock('../../src/security/file-permissions.js', () => ({
  restrictFilePermissions: vi.fn().mockResolvedValue(undefined),
}));

// Import AFTER the mock is registered.
const { DefaultSecretVault } = await import('../../src/security/secret-vault.js');
const { restrictFilePermissions } = await import('../../src/security/file-permissions.js');

let tmp: string;
let keyFile: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-ws088-spy-'));
  keyFile = path.join(tmp, '.key');
  vi.mocked(restrictFilePermissions).mockClear();
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('WS-088: restrictFilePermissions spy on fresh-key path', () => {
  it('calls restrictFilePermissions after creating a fresh key file', () => {
    // Fresh key file: readFileSync throws ENOENT, writeFileSync creates it,
    // restrictFilePermissions must fire to harden Windows ACEs.
    const vault = new DefaultSecretVault({ keyFile });
    vault.encrypt('trigger');

    expect(restrictFilePermissions).toHaveBeenCalled();
    // At least one call must target our key file path.
    const calls = vi.mocked(restrictFilePermissions).mock.calls;
    expect(calls.some(([filePath]) => filePath === keyFile)).toBe(true);
  });

  it('does not fire from the fresh-key create path when key file already exists', async () => {
    // Pre-create a valid versioned v2 key file so readFileSync succeeds on
    // the first try — the create path (and its restrictFilePermissions call)
    // is never reached. checkKeyFilePermissions may still call it (self-heal
    // for wrong mode), but the key was created with correct 0o600 so even
    // that path is a no-op on POSIX.
    const { randomBytes } = await import('node:crypto');
    const magic = Buffer.from('WSKV', 'ascii');
    const buf = Buffer.alloc(magic.length + 1 + 32);
    magic.copy(buf, 0);
    buf[magic.length] = 1;
    randomBytes(32).copy(buf, magic.length + 1);
    await fs.writeFile(keyFile, buf, { mode: 0o600 });

    vi.mocked(restrictFilePermissions).mockClear();

    const vault = new DefaultSecretVault({ keyFile });
    const enc = vault.encrypt('test');
    expect(vault.decrypt(enc)).toBe('test');

    // On a correctly-permissioned key file, checkKeyFilePermissions is a
    // no-op (mode already 0o600 on POSIX), so no restrictFilePermissions call.
    // On Windows the mode check is skipped entirely. Either way, no call.
    // This proves the spy fires specifically on the fresh-key create path.
    expect(restrictFilePermissions).not.toHaveBeenCalled();
  });
});
