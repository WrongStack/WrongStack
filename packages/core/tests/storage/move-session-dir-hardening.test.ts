import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _filePermOps } from '@wrongstack/persistence';
import { DefaultSessionStore } from '../../src/storage/session-store.js';

/**
 * F78 (WS-045 directory-hardening-on-creation class): copySessionFiles creates
 * the TARGET store's shard directory via a raw fsp.mkdir — bypassing the
 * hardened ensureShardDir (F67). The moved journal lands in a directory whose
 * ACL is whatever the target sessions root grants; future sidecars created
 * there by other paths inherit it. Reuse ensureShardDir so the target shard is
 * hardened once, exactly like a locally-created session's.
 *
 * Deterministic call-site proof: inject the win32 seam (_filePermOps), capture
 * icacls for the target shard directory; real cross-project move flow.
 */
const icaclsCalls: Array<{ file: string; args: readonly string[] }> = [];
let tmp: string;
let sourceDir: string;
let targetDir: string;

const ID = '2026-09-24/sess_move';

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-f78-'));
  sourceDir = path.join(tmp, 'a', 'sessions');
  targetDir = path.join(tmp, 'b', 'sessions');
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
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('move target directory-hardening-on-creation (F78)', () => {
  it('hardens the target shard directory via the shared ensureShardDir', async () => {
    const source = new DefaultSessionStore({ dir: sourceDir, projectRoot: path.join(tmp, 'a') });
    const target = new DefaultSessionStore({ dir: targetDir, projectRoot: path.join(tmp, 'b') });
    const ts = '2026-09-24T10:00:00.000Z';
    const writer = await source.create({
      id: ID,
      model: 'm',
      provider: 'p',
      checkout: '/repo/main',
    });
    await writer.append({ type: 'user_input', ts, content: 'build the thing' });
    await writer.close();
    icaclsCalls.length = 0; // only count the move's target-side hardening

    await source.move(ID, { store: target, checkout: path.join(tmp, 'b') });
    const targets = icaclsCalls.filter((c) => c.file === 'icacls').map((c) => c.args[0]);
    expect(targets, 'target shard dir is hardened').toContain(path.join(targetDir, '2026-09-24'));
  }, 60_000);
});
