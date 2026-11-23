import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _filePermOps } from '@wrongstack/persistence';
import { ensureShardDir } from '../../src/storage/session-store/paths.js';

/**
 * F67 (WS-045 directory-hardening-on-creation class): ensureShardDir creates
 * the date-shard directory that holds session journals (verbatim transcripts)
 * via ensureDir with no owner-only hardening. On Windows every session file
 * created inside inherits whatever the sessions root grants. Hardening the
 * shard directory AT CREATION (icacls (OI)(CI) inheritance) covers every
 * journal/sidecar — including ones written by paths we do not control. Once
 * per directory: session loads must not pay an icacls spawn each time.
 *
 * Deterministic call-site proof: inject the win32 seam (_filePermOps), capture
 * icacls for the shard directory.
 */
const icaclsCalls: Array<{ file: string; args: readonly string[] }> = [];
let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-f67-'));
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

const countFor = (t: string) =>
  icaclsCalls.filter((c) => c.file === 'icacls' && c.args[0] === t).length;

describe('session shard directory-hardening-on-creation (F67)', () => {
  it('hardens the shard directory and only once across calls', async () => {
    const shard = await ensureShardDir(dir, '2026-09-24/sess_x');
    expect(shard).toBe(path.join(dir, '2026-09-24'));
    expect(countFor(shard), 'shard dir is hardened at creation').toBe(1);
    await ensureShardDir(dir, '2026-09-24/sess_y');
    expect(countFor(shard), 'second session in the same shard pays no icacls').toBe(1);
  });
});
