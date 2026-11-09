/**
 * Leaf git helpers behind {@link WorktreeManager} — the bits that only need a
 * runner and arguments, not manager state.
 *
 * Split out of `worktree-manager.ts`; `parseConflictPaths` and `assertSafePath`
 * keep their re-export from there, which remains the public import site.
 *
 * @module worktree/worktree-git
 */
import { resolve, sep } from 'node:path';
import { gitFilterIsolationEnv, runVcs } from '@wrongstack/core/vcs';
import type { RunResult } from './worktree-types.js';

const MAX_SLUG = 40;

/** Shape of the `git` runner the manager threads through these helpers. */
export type GitRunner = (args: string[], cwd: string) => Promise<RunResult>;

export function makeSlug(hint: string, usedSlugs: Set<string>): string {
  let base = hint
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+/, '')
    .replace(/[-.]+$/, '')
    .slice(0, MAX_SLUG)
    .replace(/[-.]+$/, '');
  if (!base) base = 'wt';
  let slug = `${base}-${crypto.randomUUID().slice(0, 6)}`;
  while (usedSlugs.has(slug)) slug = `${base}-${crypto.randomUUID().slice(0, 6)}`;
  usedSlugs.add(slug);
  return slug;
}

export async function collectStats(
  runGit: GitRunner,
  dir: string,
): Promise<{ insertions: number; deletions: number; files: number; sha: string }> {
  const sha = (await runGit(['rev-parse', 'HEAD'], dir)).stdout.trim();
  const numstat = await runGit(['show', '--numstat', '--format=', 'HEAD'], dir);
  let insertions = 0;
  let deletions = 0;
  let files = 0;
  for (const line of numstat.stdout.split('\n')) {
    const m = line.trim().match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!m) continue;
    files++;
    if (m[1] !== '-') insertions += Number(m[1]);
    if (m[2] !== '-') deletions += Number(m[2]);
  }
  return { insertions, deletions, files, sha };
}

/**
 * `git -c user.*` fallback so commits succeed on machines and CI runners
 * that have no global git identity configured. Returns `[]` when both
 * `user.name` and `user.email` are already set (the common case), so a real
 * user's identity is never overridden. The worktree branch commits are
 * squashed away on merge, so the fallback identity never reaches the base
 * branch history.
 */
export async function identityArgs(runGit: GitRunner, cwd: string): Promise<string[]> {
  const name = (await runGit(['config', 'user.name'], cwd)).stdout.trim();
  const email = (await runGit(['config', 'user.email'], cwd)).stdout.trim();
  if (name && email) return [];
  return ['-c', `user.name=${name || 'Goal'}`, '-c', `user.email=${email || 'goal@agent.local'}`];
}

/**
 * Subcommands that only read run isolated from the programs the repository's
 * own config names (fsmonitor, `.gitattributes` filters). Merges, resets and
 * `worktree add` write files and keep git's ordinary behavior: blanking a
 * local smudge filter there (git-crypt) would check out the stored bytes.
 */
const READ_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'status',
  'diff',
  'ls-files',
  'log',
  'show',
]);

export async function defaultRun(gitBin: string, args: string[], cwd: string): Promise<RunResult> {
  let env: Record<string, string> | undefined;
  if (READ_SUBCOMMANDS.has(args[0] ?? '')) {
    env = await gitFilterIsolationEnv(gitBin, cwd);
    if (!env) {
      return {
        code: 1,
        stdout: '',
        stderr: 'git isolation unavailable: the repository config could not be read',
      };
    }
  }
  // Bound the captured output — a merge/status against a huge worktree
  // can emit MBs that nothing reads in full (parseConflictPaths only
  // scans for CONFLICT lines). 1 MB matches grep.ts's buffer cap.
  const { code, stdout, stderr } = await runVcs(gitBin, args, cwd, {
    maxOutputBytes: 1_000_000,
    env,
  });
  return { code, stdout, stderr };
}

/**
 * Extract conflicted paths from git merge output. Git prints one
 * `CONFLICT (<kind>): Merge conflict in <path>` line per conflicted file to
 * stdout — a portable signal that doesn't depend on the post-merge index
 * state (which `git diff --diff-filter=U` can report as empty on some runners
 * after a `--squash` conflict).
 */
export function parseConflictPaths(output: string): string[] {
  const paths = new Set<string>();
  for (const rawLine of output.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const contentMatch = line.match(/^CONFLICT \([^)]*\): Merge conflict in (.+?)\s*$/);
    if (contentMatch?.[1]) {
      paths.add(contentMatch[1]);
      continue;
    }
    const modDelMatch = line.match(
      /^CONFLICT \(modify\/delete\): (.+?) deleted in .+ and modified in /,
    );
    if (modDelMatch?.[1]) {
      paths.add(modDelMatch[1]);
      continue;
    }
    const renDelMatch = line.match(
      /^CONFLICT \(rename\/delete\): (.+?) renamed to (.+?) in .+?, but deleted in /,
    );
    if (renDelMatch?.[2]) {
      paths.add(renDelMatch[2]);
      continue;
    }
    const fileDirMatch = line.match(
      /^CONFLICT \(file\/directory\): There is a directory with name (.+?) in /,
    );
    if (fileDirMatch?.[1]) {
      paths.add(fileDirMatch[1]);
    }
  }
  return [...paths];
}

/** Throw if `dir` resolves outside `projectRoot`. */
export function assertSafePath(dir: string, projectRoot: string): void {
  const norm = (p: string): string =>
    process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p);
  const root = norm(projectRoot);
  const abs = norm(dir);
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new Error(`worktree path escapes project root: ${dir}`);
  }
}
