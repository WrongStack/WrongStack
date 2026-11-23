import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _filePermOps } from '@wrongstack/persistence';
import { HqSageStore } from '../src/sage-store.js';

/**
 * F70 (WS-045 directory-hardening-on-creation class): HqSageStore.merge creates
 * the HQ sage directory via fs.mkdir with no mode and no owner-only hardening
 * (the snapshot file itself uses atomicWrite, which hardens). Sage records are
 * agent learning/memory data. On Windows anything else created inside inherits
 * whatever the HQ dataDir grants. Hardening the directory AT CREATION (icacls
 * (OI)(CI) inheritance) covers future children.
 *
 * Deterministic call-site proof: inject the win32 seam (_filePermOps), capture
 * icacls for the sage directory.
 */
const icaclsCalls: Array<{ file: string; args: readonly string[] }> = [];
let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-f70-'));
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

describe('HQ sage directory-hardening-on-creation (F70)', () => {
  it('hardens the sage directory when merge prepares it', async () => {
    const store = new HqSageStore(dir);
    await store.merge({
      projectId: 'p',
      records: [{ id: 'm', revision: 1, changeId: 'a'.repeat(32), memory: null }],
    } as never);
    await store.drain();
    const targets = icaclsCalls.filter((c) => c.file === 'icacls').map((c) => c.args[0]);
    expect(targets, 'sage dir is hardened').toContain(path.join(dir, 'sage'));
  });
});
