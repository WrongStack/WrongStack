import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { _filePermOps } from '@wrongstack/persistence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { materializeAutomationPatch } from '../src/automation/pull-request-git.js';

/**
 * F53 (WS-045 class): materializeAutomationPatch writes the automation patch —
 * project source diffs — via writeFile + mode 0o600 (a Windows no-op) with no
 * owner-only hardening. On Windows the patch stayed readable by other local
 * accounts where inheritance was not owner-only. The patch file is hardened
 * right after the write (best-effort), before git applies it to the isolated
 * index.
 *
 * Deterministic call-site proof: inject the win32 seam (_filePermOps), capture
 * icacls for the changes.patch temp path; a real git fixture drives the flow.
 */
const icaclsCalls: Array<{ file: string; args: readonly string[] }> = [];
let root: string;

const git = (...args: string[]) =>
  execFileSync('git', ['-C', root, ...args], { windowsHide: true, timeout: 15_000 })
    .toString()
    .trim();

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'ws-f53-'));
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'core.autocrlf', 'false');
  await writeFile(path.join(root, 'a.txt'), 'before\n');
  git('add', 'a.txt');
  git('commit', '-qm', 'base');
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
  await rm(root, { recursive: true, force: true });
});

describe('automation patch owner-only hardening (F53)', () => {
  it('hardens the changes.patch temp file', async () => {
    const sourceTree = git('rev-parse', 'HEAD^{tree}');
    await writeFile(path.join(root, 'a.txt'), 'after\n');
    git('add', 'a.txt');
    const patch = execFileSync('git', [
      '-C',
      root,
      'diff',
      '--cached',
      '--binary',
      'HEAD',
    ]).toString();
    await writeFile(path.join(root, 'a.txt'), 'before\n');
    git('add', 'a.txt');

    const result = await materializeAutomationPatch(root, patch, sourceTree);
    // Valid-input control: materialization still produces the change set.
    expect(result.changes.map((c) => c.path)).toContain('a.txt');
    const patchCalls = icaclsCalls.filter(
      (c) => c.file === 'icacls' && (c.args[0] ?? '').endsWith('changes.patch'),
    );
    expect(patchCalls.length, 'materialize issues icacls for the temp patch').toBe(1);
  }, 60_000);
});
