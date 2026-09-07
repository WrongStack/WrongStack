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
    // is never reached.
    const { randomBytes } = await import('node:crypto');
    const magic = Buffer.from('WSKV', 'ascii');
    const buf = Buffer.alloc(magic.length + 1 + 32);
    magic.copy(buf, 0);
    buf[magic.length] = 1;
    randomBytes(32).copy(buf, magic.length + 1);
    await fs.writeFile(keyFile, buf, { mode: 0o600 });

    const before = await fs.readFile(keyFile);

    vi.mocked(restrictFilePermissions).mockClear();

    const vault = new DefaultSecretVault({ keyFile });
    const enc = vault.encrypt('test');
    expect(vault.decrypt(enc)).toBe('test');

    // The load-bearing proof that the create path was not taken: the key file
    // is byte-identical. A fresh-key create would have written a new random
    // key, and `decrypt` above would be decrypting with a different key.
    expect(await fs.readFile(keyFile)).toEqual(before);

    if (process.platform === 'win32') {
      // H-7: `keyFileNeedsHardening` deliberately returns true unconditionally
      // on Windows — mode bits say nothing there, and the previous early
      // return left every pre-existing `.key` carrying the parent directory's
      // inherited ACEs forever. So exactly one self-heal call is expected, and
      // it is `checkKeyFilePermissions`, not the create path.
      expect(restrictFilePermissions).toHaveBeenCalledTimes(1);
    } else {
      // POSIX: the key was written 0o600, so the mode check finds nothing to
      // repair and nothing else can fire.
      expect(restrictFilePermissions).not.toHaveBeenCalled();
    }
  });
});
