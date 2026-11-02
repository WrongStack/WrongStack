/**
 * A repository's `.gitattributes` can assign a filter whose command its own
 * `.git/config` names; git runs it whenever status/diff/add/hash-object reads
 * that file. The isolation environment must blank exactly those commands,
 * keep the user's own (git-lfs), and refuse when the config cannot be read.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  gitConfigEnv,
  gitIsolationEnv,
  gitIsolationEnvSync,
  untrustedGitFilterKeys,
} from '../src/git-isolation.js';

let repo: string;
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
const marker = () => path.join(repo, 'filter-ran.txt');

beforeEach(() => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wstack-git-isolation-')));
  git('init', '-q');
  fs.writeFileSync(path.join(repo, '.gitattributes'), '*.ts filter=evil\n');
  fs.writeFileSync(path.join(repo, 'a.ts'), 'a\n');
  git('add', '.');
  git('-c', 'user.email=t@example.test', '-c', 'user.name=t', 'commit', '-qm', 'one');
  git('config', 'filter.evil.clean', 'echo ran > filter-ran.txt; cat');
  git('config', 'filter.evil.process', 'sh -c "echo ran > filter-ran.txt"');
  fs.writeFileSync(path.join(repo, 'a.ts'), 'b\n');
});
afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

/** The keys an isolation environment overrides, with their values. */
const overrides = (env: Record<string, string> | undefined) => {
  const out: Record<string, string> = {};
  for (const [name, key] of Object.entries(env ?? {})) {
    const n = name.match(/^GIT_CONFIG_KEY_(\d+)$/)?.[1];
    if (n !== undefined) out[key] = env?.[`GIT_CONFIG_VALUE_${n}`] ?? '<missing>';
  }
  return out;
};

const status = (env: Record<string, string>) =>
  spawnSync('git', ['status', '--porcelain'], {
    cwd: repo,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });

describe('gitIsolationEnv', () => {
  it('turns fsmonitor off and blanks the repository filter commands', async () => {
    expect(overrides(await gitIsolationEnv(repo))).toEqual({
      'core.fsmonitor': 'false',
      'filter.evil.clean': '',
      'filter.evil.process': '',
    });
  });

  it('git status under it runs no repository program', async () => {
    const env = await gitIsolationEnv(repo);
    expect(env).toBeDefined();
    expect(status(env!).stdout).toContain('a.ts');
    expect(fs.existsSync(marker())).toBe(false);
  });

  it('without it, the same status runs the program (the fixture is live)', () => {
    status({});
    expect(fs.existsSync(marker())).toBe(true);
  });

  it('blanks a filter whose name holds "="', async () => {
    fs.writeFileSync(path.join(repo, '.gitattributes'), '*.ts filter=a=b\n');
    git('config', '--remove-section', 'filter.evil');
    git('config', 'filter.a=b.process', 'sh -c "echo ran > filter-ran.txt"');
    const env = await gitIsolationEnv(repo);
    expect(overrides(env)).toMatchObject({ 'filter.a=b.process': '' });
    status(env!);
    expect(fs.existsSync(marker())).toBe(false);
  });

  it('counts an included file as the repository, and an lfs override too', async () => {
    fs.writeFileSync(path.join(repo, 'inc.cfg'), '[filter "inc"]\n\tclean = y\n');
    git('config', 'include.path', '../inc.cfg');
    git('config', 'filter.lfs.process', 'evil');
    expect(overrides(await gitIsolationEnv(repo))).toMatchObject({
      'filter.inc.clean': '',
      'filter.lfs.process': '',
    });
  });

  it("keeps the user's own filters", async () => {
    git('config', '--remove-section', 'filter.evil');
    // Whatever the machine's system/global config holds (git-lfs on most).
    expect(overrides(await gitIsolationEnv(repo))).toEqual({ 'core.fsmonitor': 'false' });
  });

  it('is undefined when the config cannot be listed', async () => {
    fs.appendFileSync(path.join(repo, '.git', 'config'), '\n[broken\n');
    expect(await gitIsolationEnv(repo)).toBeUndefined();
    expect(gitIsolationEnvSync(repo)).toBeUndefined();
    expect(await gitIsolationEnv(repo, { binary: 'wstack-no-such-git' })).toBeUndefined();
  });

  it('the sync form agrees', async () => {
    expect(gitIsolationEnvSync(repo)).toEqual(await gitIsolationEnv(repo));
  });

  it("never rewrites the index on a read, so it cannot hold the user's index.lock", async () => {
    git('config', '--remove-section', 'filter.evil');
    git('checkout', '-q', '--', 'a.ts');
    // Same content, new timestamp: a plain status refreshes and rewrites the index for it.
    const stale = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(repo, 'a.ts'), stale, stale);
    const index = path.join(repo, '.git', 'index');
    const before = fs.readFileSync(index);
    const env = await gitIsolationEnv(repo);
    expect(env?.['GIT_OPTIONAL_LOCKS']).toBe('0');
    execFileSync('git', ['status', '--porcelain'], {
      cwd: repo,
      env: { ...process.env, ...env },
      stdio: 'pipe',
    });
    expect(fs.readFileSync(index).equals(before)).toBe(true);
    git('status', '--porcelain');
    expect(fs.readFileSync(index).equals(before)).toBe(false);
  });
});

describe('gitConfigEnv', () => {
  it('appends after the entries the base environment holds', () => {
    expect(gitConfigEnv([['filter.x.clean', '']], { GIT_CONFIG_COUNT: '2' })).toEqual({
      GIT_CONFIG_KEY_2: 'filter.x.clean',
      GIT_CONFIG_VALUE_2: '',
      GIT_CONFIG_COUNT: '3',
    });
  });
});

describe('untrustedGitFilterKeys', () => {
  it('keeps system/global, drops non-command keys, blanks all without scopes', () => {
    const scoped = [
      'system',
      'filter.lfs.clean',
      'global',
      'filter.lfs.process',
      'local',
      'filter.evil.clean',
      'worktree',
      'filter.wt.smudge',
      'local',
      'filter.evil.required',
      '',
    ].join('\0');
    expect(untrustedGitFilterKeys(scoped, true)).toEqual(['filter.evil.clean', 'filter.wt.smudge']);
    expect(untrustedGitFilterKeys('filter.lfs.clean\0filter.x.process\0', false)).toEqual([
      'filter.lfs.clean',
      'filter.x.process',
    ]);
  });
});
