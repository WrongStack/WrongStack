import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { _filePermOps } from '@wrongstack/persistence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SddBoardStore } from '../src/sdd-board-store.js';

/**
 * F34 (WS-045 class): SddBoardStore.appendEventInternal appends board events —
 * spec/design data that may carry sensitive detail — via fsp.appendFile + mode
 * 0o600 (a Windows no-op) with no owner-only hardening (only compaction rewrites
 * via atomicWrite). On Windows the event log stayed readable by other local
 * accounts where inheritance was not owner-only. The store now hardens once per
 * active event file via restrictFilePermissions and re-hardens after compaction.
 *
 * Deterministic call-site proof: inject the win32 seam (_filePermOps), capture
 * icacls for the event log path.
 */
const icaclsCalls: Array<{ file: string; args: readonly string[] }> = [];
let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-f34-'));
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

describe('SddBoardStore owner-only hardening (F34)', () => {
  it('hardens the event log on appendEvent', async () => {
    const store = new SddBoardStore({ baseDir: dir });
    await store.appendEvent('run1', {
      ts: Date.now(),
      type: 'note',
      payload: { text: 'SECRET' },
    } as never);
    expect(hardened(store.eventsPath('run1')), 'appendEvent issues icacls for the event log').toBe(
      true,
    );
  });

  it('hardens ONCE across multiple appends', async () => {
    const store = new SddBoardStore({ baseDir: dir });
    await store.appendEvent('run1', { ts: 1, type: 'note' } as never);
    await store.appendEvent('run1', { ts: 2, type: 'note' } as never);
    const count = icaclsCalls.filter(
      (c) => c.file === 'icacls' && c.args[0] === store.eventsPath('run1'),
    ).length;
    expect(count).toBe(1);
  });
});
