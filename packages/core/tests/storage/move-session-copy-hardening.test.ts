import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { _filePermOps } from '@wrongstack/persistence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DefaultSessionStore } from '../../src/storage/session-store.js';

/**
 * F57 (WS-045 copy-time class): a cross-project session move copies the journal
 * (verbatim transcript), its sidecars and the per-session directory via fsp.cp.
 * On Windows the copied children land with the destination's inherited ACL,
 * NOT the source's owner-only ACL, so the moved transcript stayed readable by
 * other local accounts. Every copied file (and recursive directory child) is
 * hardened after the copy (best-effort).
 *
 * Deterministic call-site proof: inject the win32 seam (_filePermOps), capture
 * icacls for the target-store paths; real DefaultSessionStore move flow.
 */
const icaclsCalls: Array<{ file: string; args: readonly string[] }> = [];
let tmp: string;
let sourceDir: string;
let targetDir: string;

const ID = '2026-09-24/sess_move';

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-f57-'));
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

const hardened = (t: string) => icaclsCalls.some((c) => c.file === 'icacls' && c.args[0] === t);

describe('cross-project move copy-time hardening (F57)', () => {
  it('hardens the copied journal, sidecars and session-directory children', async () => {
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
    await fs.writeFile(path.join(sourceDir, `${ID}.todos.json`), '{"todos":[]}');
    await fs.mkdir(path.join(sourceDir, ID, 'subagents'), { recursive: true });
    await fs.writeFile(path.join(sourceDir, ID, 'subagents', 'a.jsonl'), '{}\n');
    icaclsCalls.length = 0; // only count the move's copy hardening

    const result = await source.move(ID, { store: target, checkout: path.join(tmp, 'b') });
    // Valid-input control: the move still lands and lists in the target.
    expect(result.kind).toBe('project');
    expect((await target.list(5)).map((s) => s.id)).toContain(ID);
    expect(hardened(path.join(targetDir, `${ID}.jsonl`)), 'copied journal is hardened').toBe(true);
    expect(hardened(path.join(targetDir, `${ID}.todos.json`)), 'copied sidecar is hardened').toBe(
      true,
    );
    expect(
      hardened(path.join(targetDir, ID, 'subagents', 'a.jsonl')),
      'copied directory child is hardened',
    ).toBe(true);
  }, 60_000);
});
