import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { _filePermOps } from '@wrongstack/persistence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backupConfigFile } from '../../src/utils/config-backup.js';

/**
 * F25 (WS-045 class): backupConfigFile writes timestamped config snapshots —
 * full config content, which may carry API keys — via fs.writeFile + mode 0o600
 * (a Windows no-op) with no owner-only hardening. On Windows the backups stayed
 * readable by other local accounts where inheritance was not owner-only. Each
 * snapshot is a new file (flag 'wx'), so each is hardened after its write.
 *
 * Deterministic call-site proof: inject the win32 seam (_filePermOps), capture
 * icacls for the created backup file.
 */
const icaclsCalls: Array<{ file: string; args: readonly string[] }> = [];
let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-f25-'));
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

describe('config backup owner-only hardening (F25)', () => {
  it('hardens the config snapshot it writes', async () => {
    const globalRoot = path.join(dir, 'global');
    const configPath = path.join(globalRoot, 'config.json');
    await fs.mkdir(globalRoot, { recursive: true });
    await fs.writeFile(configPath, '{"apiKey":"SECRET-KEY-VALUE"}\n', 'utf8');

    await backupConfigFile(configPath, { globalRoot });

    const backupDir = path.join(globalRoot, 'config-history');
    const backups = await fs.readdir(backupDir);
    expect(backups.length).toBe(1);
    const backupFile = path.join(backupDir, backups[0]!);
    expect(
      icaclsCalls.some((c) => c.file === 'icacls' && c.args[0] === backupFile),
      'backupConfigFile issues icacls for the snapshot',
    ).toBe(true);
  });
});
