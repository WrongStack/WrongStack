import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { _filePermOps } from '@wrongstack/persistence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acquireOrJoin,
  finalize,
  MAILBOX_BRIDGE_LOCK_FILENAME,
  MAILBOX_BRIDGE_TOKEN_FILENAME,
} from '../src/single-instance-mailbox.js';

/**
 * F43 (WS-045 class): the mailbox-bridge lock holds the BEARER TOKEN (its own
 * module docs), and finalize also writes `.mailbox.token`. Both go through the
 * local atomicWriteString — tmp writeFile mode 0o600 + rename — with no
 * owner-only hardening. On Windows the mode is a no-op, so the token files
 * stayed readable by other local accounts where inheritance was not
 * owner-only: any local account could read the bearer and talk to the bridge.
 * Every atomic replacement is hardened (best-effort).
 *
 * Deterministic call-site proof: inject the win32 seam (_filePermOps), capture
 * icacls for the lock/token paths. acquireOrJoin on a fresh dir + finalize need
 * no network and no live owner (absent lock → no PID probe).
 */
const icaclsCalls: Array<{ file: string; args: readonly string[] }> = [];
let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-f43-'));
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

const hardened = (t: string) => icaclsCalls.some((c) => c.file === 'icacls' && c.args[0] === t);
const countFor = (t: string) =>
  icaclsCalls.filter((c) => c.file === 'icacls' && c.args[0] === t).length;
const lockPath = () => path.join(dir, MAILBOX_BRIDGE_LOCK_FILENAME);
const tokenPath = () => path.join(dir, MAILBOX_BRIDGE_TOKEN_FILENAME);

describe('mailbox bridge lock/token owner-only hardening (F43)', () => {
  it('hardens the tentative lock (bearer token) on acquireOrJoin', async () => {
    const result = await acquireOrJoin({
      projectDir: dir,
      host: '127.0.0.1',
      requestedPort: null,
      strictPort: false,
    });
    expect(result.kind).toBe('acquired');
    expect(hardened(lockPath()), 'acquireOrJoin issues icacls for the lock').toBe(true);
  });

  it('hardens the token file and the replaced lock on finalize', async () => {
    const result = await acquireOrJoin({
      projectDir: dir,
      host: '127.0.0.1',
      requestedPort: null,
      strictPort: false,
    });
    if (result.kind !== 'acquired') throw new Error('expected acquired');
    const finalized = await finalize(dir, result.lock, 4321);
    expect(hardened(tokenPath()), 'finalize issues icacls for .mailbox.token').toBe(true);
    expect(countFor(lockPath()), 'tentative AND finalized lock writes are hardened').toBe(2);
    // Valid-input control: the flow itself still works — token file matches.
    expect((await fs.readFile(tokenPath(), 'utf8')).trim()).toBe(finalized.token);
  });
});
