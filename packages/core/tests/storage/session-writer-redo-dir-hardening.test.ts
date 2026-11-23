import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _filePermOps } from '@wrongstack/persistence';
import { stashRewoundTail } from '../../src/storage/session-writer-redo.js';

/**
 * F65 (WS-045 directory-hardening-on-creation class): stashRewoundTail creates
 * the redo stash directory (`<journal>.redo/`) via fsp.mkdir with no mode and
 * no owner-only hardening. The stash holds verbatim transcript tails. On
 * Windows every file created inside inherits whatever the sessions dir grants.
 * Hardening the directory AT CREATION (icacls (OI)(CI) inheritance) covers the
 * tail files and stack.json — including replacements by paths we do not
 * control.
 *
 * Deterministic call-site proof: inject the win32 seam (_filePermOps), capture
 * icacls for the stash directory.
 */
const icaclsCalls: Array<{ file: string; args: readonly string[] }> = [];
let dir: string;
let journal: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-f65-'));
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

describe('redo stash directory-hardening-on-creation (F65)', () => {
  it('hardens the stash directory when it is created', async () => {
    await stashRewoundTail({
      journalPath: journal,
      keptBytes: '{"type":"prompt"}\n'.length,
      activePromptIndex: 1,
      toPromptIndex: 0,
      transcriptPaths: [],
    });
    const targets = icaclsCalls.filter((c) => c.file === 'icacls').map((c) => c.args[0]);
    expect(targets, 'stash dir is hardened at creation').toContain(`${journal}.redo`);
  });
});
