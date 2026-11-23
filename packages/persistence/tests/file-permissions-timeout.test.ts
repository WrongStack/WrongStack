import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _filePermOps, restrictFilePermissions } from '../src/file-permissions.js';

/**
 * F71 (WS-045 infrastructure): applyPermissions spawns icacls with NO timeout.
 * The documented contract is "failures are warned, never thrown — a hardening
 * step must not be able to block the write it protects", but a HUNG icacls
 * (observed on a 1830-entry directory on this machine: >90s and counting;
 * antivirus/ACL-propagation can stall it indefinitely) blocks the caller
 * forever — the trace recorder's writeChain, session writers, every hardened
 * path. The spawn must be bounded: on timeout, warn and settle.
 *
 * Deterministic proof: inject a never-resolving execFileAsync seam; the call
 * must still settle (RED: it hangs and the test times out).
 */
let dir: string;
let file: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-f71-'));
  file = path.join(dir, 'secret.txt');
  await fs.writeFile(file, 'x');
  _filePermOps.platform = 'win32';
  _filePermOps.userInfo = (() => ({
    username: 'tester',
    uid: -1,
    gid: -1,
    homedir: 'C:\\Users\\tester',
    shell: null,
  })) as typeof _filePermOps.userInfo;
});

afterEach(async () => {
  _filePermOps.platform = process.platform;
  _filePermOps.userInfo = undefined;
  _filePermOps.execFileAsync = undefined;
  await fs.rm(dir, { recursive: true, force: true });
});

describe('icacls hardening timeout (F71)', () => {
  it('settles with a warning when icacls never responds', async () => {
    _filePermOps.execFileAsync = () => new Promise(() => {}); // never resolves
    const warnings: string[] = [];
    const t0 = Date.now();
    await restrictFilePermissions(file, { label: 'f71', warn: (m) => warnings.push(m) });
    expect(Date.now() - t0, 'hardening is bounded, not infinite').toBeLessThan(15_000);
    expect(warnings.length, 'the stall is warned, not silent').toBeGreaterThan(0);
  }, 20_000);

  it('a responsive icacls still succeeds without warnings', async () => {
    _filePermOps.execFileAsync = async () => ({ stdout: 'processed file', stderr: '' });
    const warnings: string[] = [];
    await restrictFilePermissions(file, { label: 'f71', warn: (m) => warnings.push(m) });
    expect(warnings).toHaveLength(0);
  });
});
