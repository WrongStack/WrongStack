import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _filePermOps } from '@wrongstack/persistence';
import { DefaultLogger } from '../../src/infrastructure/logger.js';

/**
 * F73 (WS-045 directory-hardening-on-creation class): DefaultLogger creates
 * the log directory via fsp.mkdir chained onto the write tail with no
 * owner-only hardening (the log file itself is hardened, F32). Log lines can
 * carry scrubbed-but-sensitive context. On Windows anything else created
 * inside inherits whatever the parent grants. Hardening the directory in the
 * same chained preparation (icacls (OI)(CI) inheritance) covers future
 * children (best-effort).
 *
 * Deterministic call-site proof: inject the win32 seam (_filePermOps), capture
 * icacls for the log directory.
 */
const icaclsCalls: Array<{ file: string; args: readonly string[] }> = [];
let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-f73-'));
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

describe('logger directory-hardening-on-creation (F73)', () => {
  it('hardens the log directory when it is prepared', async () => {
    const logDir = path.join(dir, 'logs');
    const logger = new DefaultLogger({
      file: path.join(logDir, 'app.log'),
      stderr: false,
      level: 'info',
    });
    logger.info('a line');
    await logger.flush();
    const targets = icaclsCalls.filter((c) => c.file === 'icacls').map((c) => c.args[0]);
    expect(targets, 'log dir is hardened').toContain(logDir);
  });
});
