import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _filePermOps } from '@wrongstack/persistence';
import { emptyHqNotifyConfig, writeHqNotifyConfig } from '../src/notify-config.js';

/**
 * F72 (WS-045 directory-hardening-on-creation class): writeHqNotifyConfig
 * creates the HQ dataDir root via fs.mkdir with no owner-only hardening (the
 * config file itself is hardened). The dataDir holds event logs, timeseries,
 * kanban/sage snapshots and webhook notify config. On Windows anything created
 * inside by a path that does not harden inherits whatever the parent grants.
 * Hardening the root AT CREATION (icacls (OI)(CI) inheritance) covers future
 * children (best-effort).
 *
 * Deterministic call-site proof: inject the win32 seam (_filePermOps), capture
 * icacls for the dataDir.
 */
const icaclsCalls: Array<{ file: string; args: readonly string[] }> = [];
let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-f72-'));
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

describe('HQ dataDir directory-hardening-on-creation (F72)', () => {
  it('hardens the dataDir root when the notify config is written', async () => {
    const dataDir = path.join(dir, 'hq');
    await writeHqNotifyConfig(dataDir, emptyHqNotifyConfig());
    const targets = icaclsCalls.filter((c) => c.file === 'icacls').map((c) => c.args[0]);
    expect(targets, 'dataDir root is hardened').toContain(dataDir);
  });
});
