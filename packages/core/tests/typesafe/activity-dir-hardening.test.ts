import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _filePermOps } from '@wrongstack/persistence';
import { appendJevActivity } from '../../src/typesafe/activity.js';

/**
 * F75 (WS-045 directory-hardening-on-creation class): appendJevActivity
 * creates the activity log directory via mkdir with no owner-only hardening
 * (the log file itself is hardened, F36). On Windows anything else created
 * inside inherits whatever the parent grants. Hardening the directory once
 * (icacls (OI)(CI) inheritance) covers future children (best-effort).
 *
 * Deterministic call-site proof: inject the win32 seam (_filePermOps), capture
 * icacls for the activity directory.
 */
const icaclsCalls: Array<{ file: string; args: readonly string[] }> = [];
let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-f75-'));
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

describe('JEV activity directory-hardening-on-creation (F75)', () => {
  it('hardens the activity directory when it is created', async () => {
    const activityDir = path.join(dir, 'activity');
    await appendJevActivity(path.join(activityDir, 'activity.jsonl'), {
      kind: 'tool',
      name: 'bash',
    } as never);
    const targets = icaclsCalls.filter((c) => c.file === 'icacls').map((c) => c.args[0]);
    expect(targets, 'activity dir is hardened').toContain(activityDir);
  });
});
