import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { _filePermOps } from '@wrongstack/persistence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendToIndexStrict,
  writeTombstone,
} from '../../src/storage/session-store/session-store-index.js';

/**
 * F35 (WS-045 class): appendToIndexStrict / writeTombstone append session index
 * rows — session metadata — via fsp.appendFile + mode 0o600 (a Windows no-op)
 * with no owner-only hardening. On Windows the index stayed readable by other
 * local accounts where inheritance was not owner-only. Each index file is
 * hardened once (best-effort) and re-hardened after compaction.
 *
 * Deterministic call-site proof: inject the win32 seam (_filePermOps), capture
 * icacls for the index path.
 */
const icaclsCalls: Array<{ file: string; args: readonly string[] }> = [];
let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-f35-'));
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

describe('session index owner-only hardening (F35)', () => {
  it('hardens the index on writeTombstone', async () => {
    const indexFile = path.join(dir, '_index.jsonl');
    await writeTombstone(
      dir,
      indexFile,
      'sess-1',
      async () => {},
      () => {},
    );
    expect(hardened(indexFile), 'writeTombstone issues icacls for the index').toBe(true);
  });

  it('hardens the index on appendToIndexStrict', async () => {
    const indexFile = path.join(dir, '_index.jsonl');
    await appendToIndexStrict(
      dir,
      indexFile,
      { id: 'sess-1', title: 't', startedAt: '2026-01-01', model: 'm', provider: 'p' } as never,
      async () => {},
      () => ({ shouldCompact: false }),
      async () => {},
    );
    expect(hardened(indexFile), 'appendToIndexStrict issues icacls for the index').toBe(true);
  });
});
