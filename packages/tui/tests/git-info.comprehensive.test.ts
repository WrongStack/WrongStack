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

describeIfGit('readGitInfo', () => {
  let repoDir: string;

  beforeAll(async () => {
    repoDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wstack-git-'));
    run(repoDir, ['init', '--initial-branch=main', '--quiet']);
    run(repoDir, ['config', 'user.email', 'test@example.com']);
    run(repoDir, ['config', 'user.name', 'test']);
    run(repoDir, ['config', 'commit.gpgsign', 'false']);
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

  it('returns null for a non-existent directory', async () => {
    expect(await readGitInfo('Z:\\nonexistent\\path\\for\\sure')).toBeNull();
  });

  it('reports branch and zero changes on a clean tree', async () => {
    await fsp.writeFile(path.join(repoDir, 'a.txt'), 'one\ntwo\nthree\n');
    run(repoDir, ['add', 'a.txt']);
    run(repoDir, ['commit', '-m', 'init', '--quiet']);
    const info = await readGitInfo(repoDir);
    expect(info).not.toBeNull();
    expect(info?.branch).toBe('main');
    expect(info?.added).toBe(0);
    expect(info?.deleted).toBe(0);
    expect(info?.untracked).toBe(0);
  });

  it('counts added and deleted lines from working-tree diff', async () => {
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

  it('handles detached HEAD state', async () => {
    // Create a commit and checkout its hash to get detached HEAD
    await fsp.writeFile(path.join(repoDir, 'detached.txt'), 'content');
    run(repoDir, ['add', 'detached.txt']);
    run(repoDir, ['commit', '-m', 'detached', '--quiet']);
    const hash = run(repoDir, ['rev-parse', 'HEAD']).trim();
    run(repoDir, ['checkout', '--detach', hash, '--quiet']);
    const info = await readGitInfo(repoDir);
    expect(info).not.toBeNull();
    // Should be a short SHA (detached head)
    expect(info?.branch).not.toBe('');
    expect(info?.branch).not.toBe('main');
    // Return to main for subsequent tests
    run(repoDir, ['checkout', 'main', '--quiet']);
  });

  it('renders the short OID for a detached HEAD in a SHA-256 repo', async () => {
    // SHA-256 repos (git init --object-format=sha256, git >= 2.29) emit
    // 64-hex branch.oid values; the label regex used to cap at 40 (SHA-1)
    // and degraded the chip to the literal 'detached'. Probe support at
    // runtime so older gits skip instead of fail.
    const sha256Dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wstack-git256-'));
    try {
      const probe = spawnSync(
        'git',
        ['init', '--object-format=sha256', '--initial-branch=main', '--quiet'],
        { cwd: sha256Dir, stdio: 'ignore' },
      );
      if (probe.status !== 0) return; // git too old for SHA-256 — skip
      run(sha256Dir, ['config', 'user.email', 'test@example.com']);
      run(sha256Dir, ['config', 'user.name', 'test']);
      run(sha256Dir, ['config', 'commit.gpgsign', 'false']);
      await fsp.writeFile(path.join(sha256Dir, 'a.txt'), 'sha256\n');
      run(sha256Dir, ['add', 'a.txt']);
      run(sha256Dir, ['commit', '-m', 'init', '--quiet']);
      const oid = run(sha256Dir, ['rev-parse', 'HEAD']).trim();
      expect(oid).toMatch(/^[0-9a-f]{64}$/);
      run(sha256Dir, ['checkout', '--detach', oid, '--quiet']);
      const info = await readGitInfo(sha256Dir);
      expect(info).not.toBeNull();
      expect(info?.branch).toBe(oid.slice(0, 7));
      expect(info?.branch).not.toBe('detached');
    } finally {
      await fsp.rm(sha256Dir, { recursive: true, force: true });
    }
  });

  it('handles binary files in numstat', async () => {
    // Create a file that git treats as binary
    const buf = Buffer.alloc(100);
    for (let i = 0; i < buf.length; i++) buf[i] = i > 50 ? 0 : 255;
    await fsp.writeFile(path.join(repoDir, 'binary.bin'), buf);
    run(repoDir, ['add', 'binary.bin']);
    run(repoDir, ['commit', '-m', 'add binary', '--quiet']);
    // Modify it
    await fsp.writeFile(path.join(repoDir, 'binary.bin'), Buffer.alloc(50));
    const info = await readGitInfo(repoDir);
    expect(info).not.toBeNull();
    // Binary files should not cause NaN - '-' values should be skipped
    expect(info?.added).toBeGreaterThanOrEqual(0);
    expect(info?.deleted).toBeGreaterThanOrEqual(0);
  });
});

function run(cwd: string, args: string[]): string {
  const r = spawnSync('git', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${r.status}): ${r.stderr?.toString()}`);
  }
  return r.stdout?.toString() ?? '';
}
