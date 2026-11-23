import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { _filePermOps } from '@wrongstack/persistence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DefaultLogger } from '../../src/infrastructure/logger.js';

/**
 * F32 (WS-045 class): DefaultLogger appends log lines — which may carry secrets
 * despite scrubbing best-effort — via fsp.appendFile + mode 0o600 (a Windows
 * no-op) with no owner-only hardening. On Windows the log file stayed readable by
 * other local accounts where inheritance was not owner-only. The logger now
 * hardens once per active file via restrictFilePermissions and re-hardens after
 * rotation.
 *
 * Deterministic call-site proof: inject the win32 seam (_filePermOps), capture
 * icacls for the log path.
 */
const icaclsCalls: Array<{ file: string; args: readonly string[] }> = [];
let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-f32-'));
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

describe('DefaultLogger owner-only hardening (F32)', () => {
  it('hardens the log file on a written line', async () => {
    const filePath = path.join(dir, 'app.log');
    const logger = new DefaultLogger({ file: filePath, stderr: false, level: 'info' });
    logger.info('a log line with SECRET-VALUE');
    await logger.flush();
    expect(hardened(filePath), 'append issues icacls for the log file').toBe(true);
  });

  it('hardens ONCE across multiple lines', async () => {
    const filePath = path.join(dir, 'app.log');
    const logger = new DefaultLogger({ file: filePath, stderr: false, level: 'info' });
    logger.info('one');
    logger.info('two');
    logger.info('three');
    await logger.flush();
    const count = icaclsCalls.filter((c) => c.file === 'icacls' && c.args[0] === filePath).length;
    expect(count).toBe(1);
  });
});
