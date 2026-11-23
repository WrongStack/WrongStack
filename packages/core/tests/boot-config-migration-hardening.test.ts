import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { _filePermOps } from '@wrongstack/persistence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateProfileFiles } from '../src/boot-config-migration.js';
import type { WstackPaths } from '../src/utils/wstack-paths.js';

/**
 * F41 (WS-045 class): migrateProfileFiles copies legacy profile-owned files
 * (memory.md — user memory content, sync.json, provider-status, …) into the
 * active profile via fs.writeFile + mode 0o600 (a Windows no-op) with no
 * owner-only hardening. On Windows the copied files stayed readable by other
 * local accounts where inheritance was not owner-only. Each copied file is
 * hardened (best-effort); the idempotent second run copies nothing and issues
 * no further hardening.
 *
 * Deterministic call-site proof: inject the win32 seam (_filePermOps), capture
 * icacls for the migrated paths.
 */
const icaclsCalls: Array<{ file: string; args: readonly string[] }> = [];
let dir: string;
let wpaths: WstackPaths;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-f41-'));
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
  await fs.writeFile(path.join(dir, 'memory.md'), '# Memory\nprivate note\n');
  await fs.writeFile(path.join(dir, 'sync.json'), '{"token":"secret"}');
});

afterEach(async () => {
  _filePermOps.platform = process.platform;
  _filePermOps.userInfo = undefined;
  _filePermOps.execFileAsync = undefined;
  await fs.rm(dir, { recursive: true, force: true });
});

const hardened = (t: string) => icaclsCalls.some((c) => c.file === 'icacls' && c.args[0] === t);
const countFor = (t: string) =>
  icaclsCalls.filter((c) => c.file === 'icacls' && c.args[0] === t).length;

describe('profile migration owner-only hardening (F41)', () => {
  it('hardens each copied profile file', async () => {
    await migrateProfileFiles(wpaths);
    const profileDir = path.join(dir, 'profiles', 'default');
    expect(hardened(path.join(profileDir, 'memory.md')), 'memory.md copy is hardened').toBe(true);
    expect(hardened(path.join(profileDir, 'sync.json')), 'sync.json copy is hardened').toBe(true);
  });

  it('issues no further hardening on the idempotent second run', async () => {
    await migrateProfileFiles(wpaths);
    const before = icaclsCalls.length;
    await migrateProfileFiles(wpaths);
    expect(icaclsCalls.length, 'second run copies nothing').toBe(before);
    const profileDir = path.join(dir, 'profiles', 'default');
    expect(countFor(path.join(profileDir, 'memory.md'))).toBe(1);
  });
});
