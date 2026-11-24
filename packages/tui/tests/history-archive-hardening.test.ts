import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _filePermOps } from '../../persistence/src/file-permissions.js';
import { HistoryArchive } from '../src/history-archive.js';

/**
 * F91 (WS-045 no-mode class): HistoryArchive opens the prompt-history archive
 * with fsp.open(file, 'a+', 0o600) — the positional mode is a Windows no-op —
 * and never hardens. The archive holds the user's prompt history. On Windows
 * it stayed readable by other local accounts where inheritance was not
 * owner-only. The file is hardened once when opened (best-effort).
 */
const icaclsCalls: Array<{ file: string; args: readonly string[] }> = [];
let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-f91-'));
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

describe('prompt history archive owner-only hardening (F91)', () => {
  it('hardens the archive when it is opened', async () => {
    const archive = new HistoryArchive(dir);
    archive.append({ text: 'a private prompt', ts: Date.now() } as never);
    await archive.close();
    const targets = icaclsCalls.filter((c) => c.file === 'icacls').map((c) => c.args[0]);
    expect(targets, 'archive is hardened').toContain(path.join(dir, 'history-archive.jsonl'));
  });
});
