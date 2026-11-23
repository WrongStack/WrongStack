import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _filePermOps } from '@wrongstack/persistence';
import { migrateProfileFiles } from '../src/boot-config-migration.js';
import type { WstackPaths } from '../src/utils/wstack-paths.js';

/**
 * F77 (WS-045 directory-hardening-on-creation class): migrateProfileFiles
 * creates the active profile directory via fs.mkdir with no owner-only
 * hardening. The profile holds config (provider settings), memory, sync state
 * and history. On Windows anything created inside by a path that does not
 * harden inherits whatever the profiles root grants. Hardening the profile
 * directory AT CREATION (icacls (OI)(CI) inheritance) covers future children
 * (best-effort, inside the existing boot-safe catch).
 *
 * Deterministic call-site proof: inject the win32 seam (_filePermOps), capture
 * icacls for the profile directory.
 */
const icaclsCalls: Array<{ file: string; args: readonly string[] }> = [];
let dir: string;
let wpaths: WstackPaths;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-f77-'));
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
  const profilesDir = path.join(dir, 'profiles');
  wpaths = {
    profileName: 'default',
    globalRoot: dir,
    globalConfig: path.join(dir, 'config.json'),
    profilesDir,
    profileConfig: (n: string) => path.join(profilesDir, n, 'config.json'),
    profileStatuslineConfig: (n: string) => path.join(profilesDir, n, 'statusline.json'),
    profileModeConfig: (n: string) => path.join(profilesDir, n, 'mode.json'),
    profileProviderStatus: (n: string) => path.join(profilesDir, n, 'provider-status.json'),
    profileUpdateCache: (n: string) => path.join(profilesDir, n, 'update-cache.json'),
  } as unknown as WstackPaths;
  await fs.writeFile(wpaths.globalConfig, JSON.stringify({ version: 1, activeProfile: 'default' }));
});

afterEach(async () => {
  _filePermOps.platform = process.platform;
  _filePermOps.userInfo = undefined;
  _filePermOps.execFileAsync = undefined;
  await fs.rm(dir, { recursive: true, force: true });
});

describe('profile directory-hardening-on-creation (F77)', () => {
  it('hardens the active profile directory when it is created', async () => {
    await migrateProfileFiles(wpaths);
    const targets = icaclsCalls.filter((c) => c.file === 'icacls').map((c) => c.args[0]);
    expect(targets, 'profile dir is hardened').toContain(path.join(dir, 'profiles', 'default'));
  });
});
