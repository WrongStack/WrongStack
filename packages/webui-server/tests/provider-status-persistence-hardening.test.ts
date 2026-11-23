import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { _filePermOps } from '@wrongstack/persistence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProviderStatusPersistence } from '../src/server/provider-status-persistence.js';

/**
 * F38 (WS-045 class): createProviderStatusPersistence.persistControl appends the
 * provider-status audit log — error messages, session/agent ids — via
 * fs.appendFile + mode 0o600 (a Windows no-op) with no owner-only hardening (the
 * status document uses atomicWrite, which hardens, but the audit append did not).
 * On Windows the audit log stayed readable by other local accounts where
 * inheritance was not owner-only. The audit file is hardened once per instance.
 *
 * Deterministic call-site proof: inject the win32 seam (_filePermOps), capture
 * icacls for the audit path.
 */
const icaclsCalls: Array<{ file: string; args: readonly string[] }> = [];
let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-f38-'));
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
const tracker = { getStatus: () => undefined, restoreSnapshot: () => {} } as never;

describe('provider-status audit owner-only hardening (F38)', () => {
  it('hardens the audit log on persistControl', async () => {
    const p = createProviderStatusPersistence(tracker, path.join(dir, 'config.json'));
    await p.persistControl('openai', 'gpt-5', undefined, 'manual reset');
    expect(hardened(p.auditFile), 'persistControl issues icacls for the audit log').toBe(true);
  });

  it('hardens ONCE across multiple persistControl calls', async () => {
    const p = createProviderStatusPersistence(tracker, path.join(dir, 'config.json'));
    await p.persistControl('openai', 'gpt-5', undefined, 'a');
    await p.persistControl('openai', 'gpt-5', undefined, 'b');
    const count = icaclsCalls.filter(
      (c) => c.file === 'icacls' && c.args[0] === p.auditFile,
    ).length;
    expect(count).toBe(1);
  });
});
