import { spawnSync } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readGitInfo } from '../src/git-info.js';

const hasGit = (() => {
  try {
    const r = spawnSync('git', ['--version'], { stdio: 'ignore' });
    return r.status === 0;
  } catch {
    return false;
  }
})();

const describeIfGit = hasGit ? describe : describe.skip;

/**
 * `readGitInfo` folds `git status --porcelain` and `git diff --numstat` line
 * by line instead of buffering the whole output, because both are unbounded
 * in the size of the working tree and the status bar polls them every 10 s.
 *
 * The fold carries a partial line between `data` events, which is the part
 * that can silently lose or duplicate a line. Every other git-info test uses
 * a tiny repo whose output arrives in a single chunk and so never exercises
 * it. This one deliberately produces output larger than a pipe chunk (64 KiB)
 * and pins the counts exactly.
 */
const UNTRACKED_FILE_COUNT = 2_000;
// Long enough that 2 000 porcelain lines (`?? <name>\n`) comfortably exceed
// the 64 KiB pipe chunk and force multiple `data` events.
const FILENAME_PADDING = 'x'.repeat(60);

describeIfGit('readGitInfo — output spanning multiple stdout chunks', () => {
  let repoDir: string;

  beforeAll(async () => {
    repoDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wstack-git-large-'));
    run(repoDir, ['init', '--initial-branch=main', '--quiet']);
    run(repoDir, ['config', 'user.email', 'test@example.com']);
    run(repoDir, ['config', 'user.name', 'test']);
    run(repoDir, ['config', 'commit.gpgsign', 'false']);
    await fsp.writeFile(path.join(repoDir, 'tracked.txt'), 'one\ntwo\nthree\n');
    run(repoDir, ['add', 'tracked.txt']);
    run(repoDir, ['commit', '-m', 'init', '--quiet']);

    // Untracked files must sit at the repo root: git collapses an untracked
    // DIRECTORY to a single `?? dir/` line, which would defeat the point.
    await Promise.all(
      Array.from({ length: UNTRACKED_FILE_COUNT }, (_unused, i) =>
        fsp.writeFile(path.join(repoDir, `untracked-${FILENAME_PADDING}-${i}.txt`), 'x'),
      ),
    );
  }, 120_000);

  afterAll(async () => {
    await fsp.rm(repoDir, { recursive: true, force: true });
  });

  it('counts every untracked file when porcelain output exceeds one chunk', async () => {
    // Guard the premise: if git ever emitted this in under a chunk the test
    // would pass without testing anything.
    const porcelainBytes = Buffer.byteLength(run(repoDir, ['status', '--porcelain']), 'utf8');
    expect(porcelainBytes).toBeGreaterThan(64 * 1024);

    const info = await readGitInfo(repoDir);
    expect(info).not.toBeNull();
    // Exact, not >=: an off-by-one at a chunk boundary shows up here.
    expect(info?.untracked).toBe(UNTRACKED_FILE_COUNT);
    expect(info?.branch).toBe('main');
  }, 60_000);

  it('still sums numstat correctly alongside a large status', async () => {
    // 1 line deleted (three), 2 added (four/five).
    await fsp.writeFile(path.join(repoDir, 'tracked.txt'), 'one\ntwo\nfour\nfive\n');
    const info = await readGitInfo(repoDir);
    expect(info?.added).toBe(2);
    expect(info?.deleted).toBe(1);
    expect(info?.untracked).toBe(UNTRACKED_FILE_COUNT);
  }, 60_000);
});

function run(cwd: string, args: string[]): string {
  const r = spawnSync('git', args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    // The porcelain read below is intentionally large.
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${r.status}): ${r.stderr?.toString()}`);
  }
  return r.stdout?.toString() ?? '';
}
