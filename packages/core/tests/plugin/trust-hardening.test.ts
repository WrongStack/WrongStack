import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { _filePermOps } from '@wrongstack/persistence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writePluginTrustStore } from '../../src/plugin/trust.js';

/**
 * F26 (WS-045 class): writePluginTrustStore writes the plugin trust store — a
 * security-relevant record (its own docblock) — via temp file + rename with
 * mode 0o600 (a Windows no-op) and no owner-only hardening. On Windows the trust
 * store stayed readable by other local accounts where inheritance was not
 * owner-only. The final path is hardened after the rename.
 *
 * Deterministic call-site proof: inject the win32 seam (_filePermOps), capture
 * icacls for the trust store path.
 */
const icaclsCalls: Array<{ file: string; args: readonly string[] }> = [];
let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-f26-'));
  icaclsCalls.length = 0;
  _filePermOps.platform = 'win32';
  _filePermOps.userInfo = (() => ({
    username: 'tester',
    uid: -1,
    gid: -1,
    homedir: 'C:\\Users\\tester',
    shell: null,
  })) as typeof _filePermOps.userInfo;
  _filePermOps.execFileAsync = async (file, args) => {
    icaclsCalls.push({ file, args });
    return { stdout: '', stderr: '' };
  };
});

afterEach(async () => {
  _filePermOps.platform = process.platform;
  _filePermOps.userInfo = undefined;
  _filePermOps.execFileAsync = undefined;
  await fs.rm(dir, { recursive: true, force: true });
});

describe('plugin trust store owner-only hardening (F26)', () => {
  it('hardens the trust store it writes', async () => {
    const storePath = path.join(dir, 'plugin-trust.json');
    await writePluginTrustStore(storePath, { pinned: {} } as never);
    expect(
      icaclsCalls.some((c) => c.file === 'icacls' && c.args[0] === storePath),
      'writePluginTrustStore issues icacls for the trust store',
    ).toBe(true);
  });
});
