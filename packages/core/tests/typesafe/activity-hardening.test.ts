import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { _filePermOps } from '@wrongstack/persistence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendJevActivity } from '../../src/typesafe/activity.js';

/**
 * F36 (WS-045 class): appendJevActivity appends JEV tool-activity rows via
 * appendFile + mode 0o600 (a Windows no-op) with no owner-only hardening. On
 * Windows the activity log stayed readable by other local accounts where
 * inheritance was not owner-only. Each target is hardened once (best-effort) and
 * re-hardened after rotation.
 *
 * Deterministic call-site proof: inject the win32 seam (_filePermOps), capture
 * icacls for the activity path.
 */
const icaclsCalls: Array<{ file: string; args: readonly string[] }> = [];
let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-f36-'));
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

describe('JEV activity owner-only hardening (F36)', () => {
  it('hardens the activity log on append', async () => {
    const target = path.join(dir, 'activity.jsonl');
    await appendJevActivity(target, { kind: 'tool', name: 'bash' } as never);
    expect(hardened(target), 'appendJevActivity issues icacls for the activity log').toBe(true);
  });

  it('hardens ONCE across multiple appends', async () => {
    const target = path.join(dir, 'activity.jsonl');
    await appendJevActivity(target, { kind: 'tool', name: 'a' } as never);
    await appendJevActivity(target, { kind: 'tool', name: 'b' } as never);
    const count = icaclsCalls.filter((c) => c.file === 'icacls' && c.args[0] === target).length;
    expect(count).toBe(1);
  });
});
