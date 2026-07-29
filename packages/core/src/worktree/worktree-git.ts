/**
 * Leaf git helpers behind {@link WorktreeManager} — the bits that only need a
 * runner and arguments, not manager state.
 *
 * Split out of `worktree-manager.ts`; `parseConflictPaths` and `assertSafePath`
 * keep their re-export from there, which remains the public import site.
 *
 * @module worktree/worktree-git
 */
import { spawn } from 'node:child_process';
import { resolve, sep } from 'node:path';
import { buildChildEnv } from '../utils/child-env.js';
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

export function defaultRun(gitBin: string, args: string[], cwd: string): Promise<RunResult> {
  return new Promise((res) => {
    let stdout = '';
    let stderr = '';
    // Bound the captured output — a merge/status against a huge worktree
    // can emit MBs that nothing reads in full (parseConflictPaths only
    // scans for CONFLICT lines). 1 MB matches grep.ts's buffer cap.
    const MAX_GIT_OUTPUT = 1_000_000;
    const child = spawn(gitBin, args, {
      cwd,
      env: buildChildEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: AbortSignal.timeout(30_000),
      windowsHide: true,
    });
    child.stdout?.on('data', (c: Buffer) => {
      if (stdout.length < MAX_GIT_OUTPUT) stdout += c.toString();
    });
    child.stderr?.on('data', (c: Buffer) => {
      if (stderr.length < MAX_GIT_OUTPUT) stderr += c.toString();
    });
    child.on('error', (err) => res({ code: 1, stdout, stderr: err.message }));
    child.on('close', (code) => res({ code: code ?? 1, stdout, stderr }));
  });
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
  for (const line of output.split('\n')) {
    const m = line.match(/^CONFLICT \([^)]*\): Merge conflict in (.+?)\s*$/);
    if (m?.[1]) paths.add(m[1]);
  }
  return [...paths];
}

/** Throw if `dir` resolves outside `projectRoot`. */
export function assertSafePath(dir: string, projectRoot: string): void {
  const root = resolve(projectRoot);
  const abs = resolve(dir);
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new Error(`worktree path escapes project root: ${dir}`);
  }
}
