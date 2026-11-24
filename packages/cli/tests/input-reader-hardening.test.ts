import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _filePermOps } from '@wrongstack/persistence';
import { ReadlineInputReader } from '../src/input-reader.js';

/**
 * F93 (WS-045 no-mode class): ReadlineInputReader.saveHistory writes the
 * scrubbed prompt history via fs.writeFile with NO mode and no hardening.
 * Scrubbing removes secret lines, but the remaining prompt history is still
 * user content. On Windows it stayed readable by other local accounts where
 * inheritance was not owner-only. The history file is hardened once per
 * reader (best-effort) and the write requests 0o600 for POSIX.
 */
const icaclsCalls: Array<{ file: string; args: readonly string[] }> = [];
let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-f93-'));
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

describe('input history owner-only hardening (F93)', () => {
  it('hardens the history file on persist', async () => {
    const historyFile = path.join(dir, 'history');
    const reader = new ReadlineInputReader({ historyFile });
    await reader.close();
    const targets = icaclsCalls.filter((c) => c.file === 'icacls').map((c) => c.args[0]);
    expect(targets, 'history file is hardened').toContain(historyFile);
  });
});
