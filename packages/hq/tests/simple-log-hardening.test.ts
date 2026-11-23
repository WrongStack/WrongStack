import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { _filePermOps } from '@wrongstack/persistence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HqSimpleLog } from '../src/persistence/simple-log.js';

/**
 * F49 (WS-045 class): HqSimpleLog.appendInternal appends HQ command-audit and
 * alert records (command text, session context) via fs.appendFile with NO mode
 * at all — the file is created with the umask default (0644 on POSIX) and on
 * Windows inherits whatever the directory grants. Only the rotation rewrite
 * used atomicWrite + 0o600. The append path is hardened once per log instance
 * (best-effort) and the append now also requests 0o600 for POSIX.
 *
 * Deterministic call-site proof: inject the win32 seam (_filePermOps), capture
 * icacls for the log path.
 */
const icaclsCalls: Array<{ file: string; args: readonly string[] }> = [];
let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-f49-'));
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

describe('HQ simple log owner-only hardening (F49)', () => {
  it('hardens the log on append', async () => {
    const log = new HqSimpleLog({ dataDir: dir, filename: 'commands.jsonl' });
    log.append({ command: 'secret prompt' });
    await log.drain();
    expect(hardened(path.join(dir, 'commands.jsonl')), 'append issues icacls for the log').toBe(
      true,
    );
  });

  it('hardens ONCE across multiple appends', async () => {
    const log = new HqSimpleLog({ dataDir: dir, filename: 'commands.jsonl' });
    log.append({ command: 'a' });
    log.append({ command: 'b' });
    await log.drain();
    expect(countFor(path.join(dir, 'commands.jsonl'))).toBe(1);
  });
});
