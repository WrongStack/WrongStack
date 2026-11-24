import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _filePermOps } from '@wrongstack/persistence';
import { beforeSnapshotPath, saveWiringSnapshot } from '../../src/execution/design-keep.js';

/**
 * F100 (WS-045 no-mode class): saveWiringSnapshot writes the design wiring
 * snapshot (before.json — user project state) via fs.writeFile with NO mode
 * and no hardening. On Windows it stayed readable by other local accounts
 * where inheritance was not owner-only. The snapshot is hardened (best-effort)
 * and the write requests 0o600 for POSIX.
 */
const icaclsCalls: Array<{ file: string; args: readonly string[] }> = [];
let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-f100-'));
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

describe('design wiring snapshot owner-only hardening (F100)', () => {
  it('hardens the before.json snapshot', async () => {
    await saveWiringSnapshot(dir, { files: [] } as never);
    const targets = icaclsCalls.filter((c) => c.file === 'icacls').map((c) => c.args[0]);
    expect(targets, 'snapshot is hardened').toContain(beforeSnapshotPath(dir));
  });
});
