import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _filePermOps } from '@wrongstack/persistence';
import { rewriteSessionToCheckpoint } from '../../src/storage/session-writer-truncate.js';

/**
 * F90 (WS-045 class): rewriteSessionToCheckpoint rebuilds the journal into
 * `<journal>.rewind.tmp` via fsp.open(tmp, 'w', 0o600) — a Windows no-op —
 * then renames over the journal. Every rewind/truncate therefore REPLACED the
 * hardened transcript with a file carrying the sessions dir's inherited ACL.
 * The temp is hardened before the rename (best-effort).
 */
const icaclsCalls: Array<{ file: string; args: readonly string[] }> = [];
let dir: string;
let journal: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-f90-'));
  journal = path.join(dir, 'session.jsonl');
  await fs.writeFile(journal, '{"type":"prompt"}\n{"type":"answer"}\n');
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

describe('journal rewrite owner-only hardening (F90)', () => {
  it('hardens the rewind temp before it replaces the journal', async () => {
    // checkpointByteOffset names the checkpoint line's START; the rewrite
    // keeps through the end of that line.
    await rewriteSessionToCheckpoint(journal, 0);
    const targets = icaclsCalls.filter((c) => c.file === 'icacls').map((c) => c.args[0]);
    expect(targets, 'rewind temp is hardened').toContain(`${journal}.rewind.tmp`);
    // Valid-input control: the rewrite still truncates correctly.
    expect(await fs.readFile(journal, 'utf8')).toBe('{"type":"prompt"}\n');
  });
});
