import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { _filePermOps } from '@wrongstack/persistence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateProfileFiles } from '../src/boot-config-migration.js';
import type { WstackPaths } from '../src/utils/wstack-paths.js';

/**
 * F56 (WS-045 copy-time class): migrateProfileFiles copies legacy profile
 * DIRECTORIES (skills, prompts, instructions, design-kits, settings, history —
 * user content) via fs.cp recursive. On Windows the copied children land with
 * the destination's inherited ACL, NOT the source's owner-only ACL, so the
 * migrated tree stayed readable by other local accounts. Every copied file and
 * directory is hardened after the copy (best-effort).
 *
 * Deterministic call-site proof: inject the win32 seam (_filePermOps), capture
 * icacls for the nested copied paths.
 */
const icaclsCalls: Array<{ file: string; args: readonly string[] }> = [];
let dir: string;
let wpaths: WstackPaths;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-f56-'));
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
  await fs.mkdir(path.join(dir, 'skills', 'demo'), { recursive: true });
  await fs.writeFile(path.join(dir, 'skills', 'demo', 'SKILL.md'), '# private skill');
});

afterEach(async () => {
  _filePermOps.platform = process.platform;
  _filePermOps.userInfo = undefined;
  _filePermOps.execFileAsync = undefined;
  await fs.rm(dir, { recursive: true, force: true });
});

const hardened = (t: string) => icaclsCalls.some((c) => c.file === 'icacls' && c.args[0] === t);

describe('profile directory migration copy-time hardening (F56)', () => {
  it('hardens the copied tree, including nested files', async () => {
    await migrateProfileFiles(wpaths);
    const copied = path.join(dir, 'profiles', 'default', 'skills');
    // Valid-input control: the copy itself still works.
    expect(await fs.readFile(path.join(copied, 'demo', 'SKILL.md'), 'utf8')).toBe(
      '# private skill',
    );
    expect(hardened(path.join(copied, 'demo', 'SKILL.md')), 'nested copied file is hardened').toBe(
      true,
    );
    expect(hardened(path.join(copied, 'demo')), 'copied subdirectory is hardened').toBe(true);
  });
});
