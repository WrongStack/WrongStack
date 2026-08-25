import { spawnSync } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { branchLabel, readGitInfo } from '../src/git-info.js';

const hasGit = (() => {
  try {
    const r = spawnSync('git', ['--version'], { stdio: 'ignore' });
    return r.status === 0;
  } catch {
    return false;
  }
})();

const describeIfGit = hasGit ? describe : describe.skip;

// Pure-label unit coverage needs no git binary, so it runs unconditionally —
// this is the regression net for the SHA-256 OID length bug (regex used to
// cap at 40 hex chars, degrading every SHA-256 repo's detached chip to the
// literal 'detached' instead of the short OID).
describe('branchLabel', () => {
  it('returns the branch name when present', () => {
    expect(branchLabel('main', 'abc1234')).toBe('main');
  });

  it('shortens a SHA-1 (40-hex) detached OID to 7 chars', () => {
    const oid = '0123456789abcdef0123456789abcdef01234567';
    expect(branchLabel('(detached)', oid)).toBe(oid.slice(0, 7));
  });

  it('shortens a SHA-256 (64-hex) detached OID to 7 chars', () => {
    const oid = 'a'.repeat(64);
    expect(branchLabel('(detached)', oid)).toBe('aaaaaaa');
  });

  it('falls back to "detached" for non-SHA sentinels', () => {
    expect(branchLabel('(detached)', '(initial)')).toBe('detached');
    expect(branchLabel('(detached)', '')).toBe('detached');
    // Too short to be a plausible OID prefix.
    expect(branchLabel('(detached)', 'abc123')).toBe('detached');
    // Non-hex characters must never render as an OID.
    expect(branchLabel('(detached)', 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz')).toBe('detached');
    // Longer than any known object format — reject rather than truncate.
    expect(branchLabel('(detached)', 'a'.repeat(65))).toBe('detached');
  });
});

describeIfGit('readGitInfo', () => {
  let repoDir: string;

  // Generous timeout: under full-suite parallel load the git child
  // processes can take far longer than the 10s default to get CPU time.
  beforeAll(async () => {
    repoDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wstack-git-'));
    // Initialise repo with a stable default branch and a noisy-quiet
    // git config so signed-commit or hook plugins don't trip the test.
    run(repoDir, ['init', '--initial-branch=main', '--quiet']);
    run(repoDir, ['config', 'user.email', 'test@example.com']);
    run(repoDir, ['config', 'user.name', 'test']);
    run(repoDir, ['config', 'commit.gpgsign', 'false']);
    await fsp.writeFile(path.join(repoDir, 'a.txt'), 'one\ntwo\nthree\n');
    run(repoDir, ['add', 'a.txt']);
    run(repoDir, ['commit', '-m', 'init', '--quiet']);
  }, 60_000);

  afterAll(async () => {
    await fsp.rm(repoDir, { recursive: true, force: true });
  });

  it('returns null for a non-git directory', async () => {
    const plain = await fsp.mkdtemp(path.join(os.tmpdir(), 'wstack-plain-'));
    try {
      expect(await readGitInfo(plain)).toBeNull();
    } finally {
      await fsp.rm(plain, { recursive: true, force: true });
    }
  });

  it('reports branch and zero changes on a clean tree', async () => {
    const info = await readGitInfo(repoDir);
    expect(info).not.toBeNull();
    expect(info?.branch).toBe('main');
    expect(info?.added).toBe(0);
    expect(info?.deleted).toBe(0);
    expect(info?.untracked).toBe(0);
  });

  it('counts added and deleted lines from working-tree diff', async () => {
    // Rewrite a.txt: 1 line deleted (three), 2 lines added (four/five).
    await fsp.writeFile(path.join(repoDir, 'a.txt'), 'one\ntwo\nfour\nfive\n');
    const info = await readGitInfo(repoDir);
    expect(info?.added).toBe(2);
    expect(info?.deleted).toBe(1);
  });

  it('counts untracked files separately', async () => {
    await fsp.writeFile(path.join(repoDir, 'newfile.txt'), 'hello');
    const info = await readGitInfo(repoDir);
    expect(info?.untracked).toBeGreaterThanOrEqual(1);
  });
});

function run(cwd: string, args: string[]): void {
  const r = spawnSync('git', args, { cwd, stdio: 'ignore' });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${r.status})`);
  }
}
