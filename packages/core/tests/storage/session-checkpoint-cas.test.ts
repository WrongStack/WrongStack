import { execFile } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type CheckpointGitResult,
  SessionCheckpointCas,
} from '../../src/storage/session-checkpoint-cas.js';

const HEAD = 'a'.repeat(40);
const execFileAsync = promisify(execFile);

describe('SessionCheckpointCas', () => {
  let tmp: string;
  let project: string;
  let target: string;
  let casRoot: string;

  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'wstack-checkpoint-cas-'));
    project = path.join(tmp, 'project');
    target = path.join(tmp, 'target');
    casRoot = path.join(tmp, 'cas');
    await Promise.all([
      fsp.mkdir(path.join(project, 'src'), { recursive: true }),
      fsp.mkdir(path.join(target, 'src'), { recursive: true }),
    ]);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  function git(opts: { tracked?: string[]; untracked?: string[] } = {}) {
    return vi.fn(async (args: string[]): Promise<CheckpointGitResult> => {
      if (args[0] === 'rev-parse') return { code: 0, stdout: `${HEAD}\n`, stderr: '' };
      if (args[0] === 'diff') {
        return { code: 0, stdout: `${(opts.tracked ?? []).join('\0')}\0`, stderr: '' };
      }
      if (args[0] === 'ls-files') {
        return { code: 0, stdout: `${(opts.untracked ?? []).join('\0')}\0`, stderr: '' };
      }
      if (args[0] === 'status') return { code: 0, stdout: '', stderr: '' };
      return { code: 1, stdout: '', stderr: 'unexpected git invocation' };
    });
  }

  it('captures changed/untracked bytes into CAS and materializes onto the matching base', async () => {
    const binary = Buffer.from([0, 1, 2, 255]);
    await Promise.all([
      fsp.writeFile(path.join(project, 'src', 'a.ts'), 'checkpoint version', 'utf8'),
      fsp.writeFile(path.join(project, 'new.bin'), binary),
      fsp.writeFile(path.join(target, 'src', 'a.ts'), 'base version', 'utf8'),
      fsp.writeFile(path.join(target, 'src', 'deleted.ts'), 'remove me', 'utf8'),
    ]);
    const runGit = git({
      tracked: ['src/a.ts', 'src/deleted.ts'],
      untracked: ['new.bin'],
    });
    const cas = new SessionCheckpointCas({ rootDir: casRoot, projectRoot: project, runGit });

    const checkpoint = await cas.capture('session-1', 3);
    expect(checkpoint).toMatchObject({
      baseHead: HEAD,
      entryCount: 3,
      unresolvedCount: 0,
      coverage: 'git-head-plus-dirty',
    });
    expect(checkpoint?.manifestHash).toMatch(/^[a-f\d]{64}$/);

    const result = await cas.materialize(checkpoint!, target);
    expect(result.errors).toEqual([]);
    expect(await fsp.readFile(path.join(target, 'src', 'a.ts'), 'utf8')).toBe('checkpoint version');
    expect(await fsp.readFile(path.join(target, 'new.bin'))).toEqual(binary);
    await expect(fsp.access(path.join(target, 'src', 'deleted.ts'))).rejects.toThrow();
  });

  it('round-trips through a real Git worktree with the default runner', async () => {
    await fsp.rm(target, { recursive: true, force: true });
    await Promise.all([
      fsp.writeFile(path.join(project, 'src', 'a.ts'), 'base version', 'utf8'),
      fsp.writeFile(path.join(project, 'delete-me.txt'), 'base deletion candidate', 'utf8'),
    ]);
    const git = async (...args: string[]) => {
      await execFileAsync('git', args, { cwd: project, windowsHide: true });
    };
    await git('init');
    await git('config', 'user.email', 'checkpoint-test@wrongstack.local');
    await git('config', 'user.name', 'WrongStack Checkpoint Test');
    await git('add', '.');
    await git('commit', '-m', 'base');
    await git('worktree', 'add', '--detach', target, 'HEAD');

    const binary = Buffer.from([9, 0, 8, 255]);
    await Promise.all([
      fsp.writeFile(path.join(project, 'src', 'a.ts'), 'workspace checkpoint', 'utf8'),
      fsp.writeFile(path.join(project, 'new.bin'), binary),
      fsp.rm(path.join(project, 'delete-me.txt')),
    ]);
    const cas = new SessionCheckpointCas({ rootDir: casRoot, projectRoot: project });
    const checkpoint = await cas.capture('real-git-session', 2);
    expect(checkpoint).toMatchObject({ entryCount: 3, unresolvedCount: 0 });

    const result = await cas.materialize(checkpoint!, target);
    expect(result.errors).toEqual([]);
    expect(await fsp.readFile(path.join(target, 'src', 'a.ts'), 'utf8')).toBe(
      'workspace checkpoint',
    );
    expect(await fsp.readFile(path.join(target, 'new.bin'))).toEqual(binary);
    await expect(fsp.access(path.join(target, 'delete-me.txt'))).rejects.toThrow();
  });

  it('deduplicates identical workspace manifests and concurrent blob publication', async () => {
    await Promise.all([
      fsp.writeFile(path.join(project, 'src', 'a.ts'), 'same bytes', 'utf8'),
      fsp.writeFile(path.join(project, 'src', 'b.ts'), 'same bytes', 'utf8'),
    ]);
    const runGit = git({ tracked: ['src/a.ts', 'src/b.ts'] });
    const firstCas = new SessionCheckpointCas({ rootDir: casRoot, projectRoot: project, runGit });
    const secondCas = new SessionCheckpointCas({ rootDir: casRoot, projectRoot: project, runGit });
    const [first, second] = await Promise.all([
      firstCas.capture('session-a', 1),
      secondCas.capture('session-b', 99),
    ]);

    expect(first).toMatchObject({ entryCount: 2, unresolvedCount: 0 });
    expect(second?.manifestHash).toBe(first?.manifestHash);
  });

  it('allows parent-root materialization but still rejects base mismatch and tampering', async () => {
    await fsp.writeFile(path.join(project, 'src', 'a.ts'), 'value', 'utf8');
    const runGit = git({ tracked: ['src/a.ts'] });
    const cas = new SessionCheckpointCas({ rootDir: casRoot, projectRoot: project, runGit });
    const checkpoint = await cas.capture('session-2', 1);

    await fsp.writeFile(path.join(project, 'src', 'a.ts'), 'after checkpoint', 'utf8');
    runGit.mockImplementation(async (args: string[], cwd?: string) => {
      if (args[0] === 'rev-parse') return { code: 0, stdout: `${HEAD}\n`, stderr: '' };
      if (args[0] === 'status' && cwd === project) {
        return { code: 0, stdout: ' M src/a.ts\0', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    });
    const parentResult = await cas.materialize(checkpoint!, project);
    expect(parentResult.errors).toEqual([]);
    expect(await fsp.readFile(path.join(project, 'src', 'a.ts'), 'utf8')).toBe('value');

    runGit.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-parse') return { code: 0, stdout: `${'b'.repeat(40)}\n`, stderr: '' };
      return { code: 0, stdout: '\0', stderr: '' };
    });
    await expect(cas.materialize(checkpoint!, target)).rejects.toThrow('target HEAD must equal');

    runGit.mockImplementation(async () => ({ code: 0, stdout: `${HEAD}\n`, stderr: '' }));
    const manifestPath = path.join(casRoot, 'manifests', `${checkpoint!.manifestHash}.json`);
    await fsp.appendFile(manifestPath, 'tampered', 'utf8');
    await expect(cas.materialize(checkpoint!, target)).rejects.toThrow('integrity check failed');
  });

  it('records unresolved non-file paths and refuses partial materialization', async () => {
    await fsp.mkdir(path.join(project, 'nested-repo'));
    const cas = new SessionCheckpointCas({
      rootDir: casRoot,
      projectRoot: project,
      runGit: git({ tracked: ['nested-repo'] }),
    });
    const checkpoint = await cas.capture('session-3', 0);
    expect(checkpoint).toMatchObject({ entryCount: 0, unresolvedCount: 1 });
    await expect(cas.materialize(checkpoint!, target)).rejects.toThrow(
      'exact materialization refused',
    );
  });

  it('marks oversized blobs unresolved without reading them into memory', async () => {
    const large = path.join(project, 'large.bin');
    await fsp.writeFile(large, '');
    await fsp.truncate(large, 64 * 1024 * 1024 + 1);
    const cas = new SessionCheckpointCas({
      rootDir: casRoot,
      projectRoot: project,
      runGit: git({ tracked: ['large.bin'] }),
    });
    await expect(cas.capture('session-large', 0)).resolves.toMatchObject({
      entryCount: 0,
      unresolvedCount: 1,
    });
  });

  it('excludes WrongStack-managed worktrees and refuses truncated Git discovery', async () => {
    await Promise.all([
      fsp.writeFile(path.join(project, 'src', 'a.ts'), 'value', 'utf8'),
      fsp.mkdir(path.join(project, '.wrongstack', 'worktrees', 'child'), { recursive: true }),
    ]);
    await fsp.writeFile(
      path.join(project, '.wrongstack', 'worktrees', 'child', 'nested.ts'),
      'do not capture',
      'utf8',
    );
    const runGit = git({
      tracked: ['src/a.ts'],
      untracked: ['.wrongstack/worktrees/child/nested.ts'],
    });
    const cas = new SessionCheckpointCas({ rootDir: casRoot, projectRoot: project, runGit });
    await expect(cas.capture('session-filter', 0)).resolves.toMatchObject({ entryCount: 1 });

    runGit.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-parse') return { code: 0, stdout: `${HEAD}\n`, stderr: '' };
      return { code: 0, stdout: 'src/a.ts\0', stderr: '', stdoutTruncated: true };
    });
    await expect(cas.capture('session-truncated', 0)).resolves.toBeUndefined();
  });

  it('refuses to overwrite a dirty materialization target', async () => {
    await fsp.writeFile(path.join(project, 'src', 'a.ts'), 'checkpoint version', 'utf8');
    const runGit = git({ tracked: ['src/a.ts'] });
    const cas = new SessionCheckpointCas({ rootDir: casRoot, projectRoot: project, runGit });
    const checkpoint = await cas.capture('session-dirty-target', 0);

    runGit.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-parse') return { code: 0, stdout: `${HEAD}\n`, stderr: '' };
      if (args[0] === 'status') return { code: 0, stdout: '?? local.txt\0', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    });
    await expect(cas.materialize(checkpoint!, target)).rejects.toThrow('clean checkout');
  });

  it('returns undefined outside a usable Git repository', async () => {
    const cas = new SessionCheckpointCas({
      rootDir: casRoot,
      projectRoot: project,
      runGit: async () => ({ code: 128, stdout: '', stderr: 'not a git repository' }),
    });
    await expect(cas.capture('session-4', 0)).resolves.toBeUndefined();
  });
});
