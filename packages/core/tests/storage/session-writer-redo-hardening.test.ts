import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { _filePermOps } from '@wrongstack/persistence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stashRewoundTail } from '../../src/storage/session-writer-redo.js';

/**
 * F39 (WS-045 class): stashRewoundTail copies the journal bytes a rewind cuts
 * into `<journal>.redo/<id>.jsonl` via fsp.open(…, 'w', 0o600), and writeStack
 * replaces `stack.json` via a tmp writeFile + rename — both mode 0o600, a
 * Windows no-op, with no owner-only hardening. The stashed tail is verbatim
 * session transcript content. On Windows both files stayed readable by other
 * local accounts where inheritance was not owner-only. Every new tail file and
 * every stack.json replacement is hardened (best-effort).
 *
 * Deterministic call-site proof: inject the win32 seam (_filePermOps), capture
 * icacls for the stash paths.
 */
const icaclsCalls: Array<{ file: string; args: readonly string[] }> = [];
let dir: string;
let journal: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-f39-'));
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

const hardened = (t: string) => icaclsCalls.some((c) => c.file === 'icacls' && c.args[0] === t);
const stashOpts = (keptBytes: number) => ({
  journalPath: journal,
  keptBytes,
  activePromptIndex: 1,
  toPromptIndex: 0,
  transcriptPaths: [],
});

describe('redo stash owner-only hardening (F39)', () => {
  it('hardens the stashed tail and stack.json on stashRewoundTail', async () => {
    await stashRewoundTail(stashOpts('{"type":"prompt"}\n'.length));
    const stashDir = `${journal}.redo`;
    const tails = icaclsCalls.filter(
      (c) => c.file === 'icacls' && c.args[0].startsWith(stashDir) && c.args[0].endsWith('.jsonl'),
    );
    expect(tails.length, 'the cut tail file is hardened').toBe(1);
    expect(hardened(path.join(stashDir, 'stack.json')), 'stack.json is hardened').toBe(true);
  });

  it('hardens each NEW tail file on subsequent stashes', async () => {
    await stashRewoundTail(stashOpts('{"type":"prompt"}\n'.length));
    await stashRewoundTail(stashOpts('{"type":"prompt"}\n'.length));
    const stashDir = `${journal}.redo`;
    const tails = new Set(
      icaclsCalls
        .filter(
          (c) =>
            c.file === 'icacls' && c.args[0].startsWith(stashDir) && c.args[0].endsWith('.jsonl'),
        )
        .map((c) => c.args[0]),
    );
    expect(tails.size, 'both distinct tail files are hardened').toBe(2);
  });
});
