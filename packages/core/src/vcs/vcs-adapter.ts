/**
 * One interface over the version-control systems a project can live in: git,
 * Jujutsu (jj) and Mercurial (hg). It covers what core asks of a checkout
 * that does not depend on git's model — what the working copy is based on,
 * what changed since, and whether it is untouched — so workspace checkpoints
 * work the same in all three. Git-only features (worktrees, squash merges)
 * keep using git directly.
 *
 * Every method answers `undefined` when the VCS could not give a complete
 * answer (binary missing, command failed, output cut off), so a caller never
 * mistakes a failure for "nothing changed".
 *
 * @module vcs/vcs-adapter
 */
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { gitIsolationEnv } from '@wrongstack/primitives';
import { buildChildEnv } from '../utils/child-env.js';
import { runVcs, type VcsRunner, type VcsRunResult } from './vcs-runner.js';

export type VcsKind = 'git' | 'jj' | 'hg';

export interface VcsAdapter {
  readonly kind: VcsKind;
  /** The checkout this adapter answers for. */
  readonly root: string;
  /**
   * The commit the working copy is based on (git `HEAD`, jj `@-`, hg `.`),
   * lowercased. Undefined in a repository that has none yet, or when the
   * working copy has more than one parent.
   */
  baseRevision(): Promise<string | undefined>;
  /**
   * Root-relative, `/`-separated paths that differ from the base: modified,
   * added, deleted and untracked. Ignored files are left out.
   */
  changedPaths(): Promise<string[] | undefined>;
  /**
   * True when the checkout has no changes, no untracked files and no ignored
   * files. jj cannot list ignored files, so for jj ignored files are not seen.
   */
  isPristine(): Promise<boolean | undefined>;
  /** The branch (git, hg) or bookmark (jj, hg) the working copy is on. */
  currentBranch(): Promise<string | undefined>;
}

export interface VcsOptions {
  runner?: VcsRunner | undefined;
  /** Binary per VCS; defaults to `git`, `jj` and `hg` on PATH. */
  binaries?: Partial<Record<VcsKind, string>> | undefined;
  /** Per-command timeout for the default runner. */
  timeoutMs?: number | undefined;
}

/**
 * Environment for every `hg` this module runs.
 *
 * These run on their own — the system-prompt environment block calls them for
 * the first prompt of every session, before any tool call, under `--restricted`
 * too — in whatever directory the user opened. `.hg/` is not special to git, so
 * a repository can commit one and a "Download ZIP" of it (no `.git/`) makes hg
 * the nearest VCS. Mercurial reads that repository's `.hg/hgrc` for every
 * command, and `[hooks]` / `[extensions]` there run code: HGPLAIN only drops
 * aliases, defaults and output settings. HGRCSKIPREPO (Mercurial 5.4+) stops
 * the repository file from being read at all; the user's and system config
 * still apply (WS-2026-09-26-02).
 */
export const HG_ISOLATED_ENV: Readonly<Record<string, string>> = Object.freeze({
  HGPLAIN: '1',
  HGRCSKIPREPO: '1',
});

/**
 * Leading `git` options for commands run on a repository the user has not
 * vouched for. `core.fsmonitor` names a program git runs on status/diff; an
 * extracted archive can carry a `.git/config` that sets it.
 */
export const GIT_ISOLATION_ARGS: readonly string[] = Object.freeze(['-c', 'core.fsmonitor=false']);

/**
 * The git isolation environment for `cwd`, over core's scrubbed child
 * environment: fsmonitor off and the repository's own filter commands
 * blanked (see `gitIsolationEnv` in @wrongstack/primitives). Undefined when
 * the config could not be listed: the caller must not run git then.
 */
export function gitFilterIsolationEnv(
  binary: string,
  cwd: string,
  timeoutMs?: number,
): Promise<Record<string, string> | undefined> {
  return gitIsolationEnv(cwd, { binary, timeoutMs, baseEnv: buildChildEnv() });
}

/** Nearest repository first; at the same level git, then jj, then hg. */
const MARKERS: ReadonlyArray<{ kind: VcsKind; marker: string }> = [
  // A colocated jj repository also has `.git`, and git answers correctly
  // there, so git wins the tie.
  { kind: 'git', marker: '.git' },
  { kind: 'jj', marker: '.jj' },
  { kind: 'hg', marker: '.hg' },
];

/**
 * The repository `dir` is in, by walking up to the nearest `.git` (a
 * directory, or the file a git worktree has), `.jj` or `.hg`.
 */
export async function detectVcs(dir: string): Promise<{ kind: VcsKind; root: string } | undefined> {
  let current = path.resolve(dir);
  for (;;) {
    for (const { kind, marker } of MARKERS) {
      const found = await fsp.stat(path.join(current, marker)).catch(() => undefined);
      if (found && (found.isDirectory() || (kind === 'git' && found.isFile()))) {
        return { kind, root: current };
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** The adapter for the repository `dir` is in; undefined outside one. */
export async function openVcs(dir: string, opts: VcsOptions = {}): Promise<VcsAdapter | undefined> {
  const found = await detectVcs(dir);
  return found ? vcsAdapter(found.kind, found.root, opts) : undefined;
}

/** An adapter of a known kind for `root`, without detection. */
export function vcsAdapter(kind: VcsKind, root: string, opts: VcsOptions = {}): VcsAdapter {
  const binary = opts.binaries?.[kind] ?? kind;
  const resolvedRoot = path.resolve(root);
  const env = kind === 'hg' ? HG_ISOLATED_ENV : undefined;
  // The isolation is applied where the process is spawned, so an injected
  // runner still sees the bare subcommand (`rev-parse`, `status`, …).
  const lead = kind === 'git' ? GIT_ISOLATION_ARGS : [];
  const run: VcsRunner =
    opts.runner ??
    (async (bin, args, cwd) => {
      const gitEnv =
        kind === 'git' ? await gitFilterIsolationEnv(bin, cwd, opts.timeoutMs) : undefined;
      // Unlisted filters are unblanked ones: answer as a failed command.
      if (kind === 'git' && !gitEnv) {
        return { code: -1, stdout: '', stderr: 'git config could not be listed' };
      }
      return runVcs(bin, [...lead, ...args], cwd, {
        env: gitEnv ?? env,
        timeoutMs: opts.timeoutMs,
      });
    });
  if (kind === 'git') return gitAdapter(resolvedRoot, binary, run);
  if (kind === 'jj') return jjAdapter(resolvedRoot, binary, run);
  return hgAdapter(resolvedRoot, binary, run);
}

function ok(result: VcsRunResult): boolean {
  return result.code === 0 && !result.stdoutTruncated;
}

const REVISION_RE = /^[a-f\d]{40,64}$/;
const NULL_REVISION_RE = /^0+$/;

/** A single commit id, or undefined for none, the null commit, or several. */
function singleRevision(result: VcsRunResult): string | undefined {
  if (!ok(result)) return undefined;
  const lines = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .filter(Boolean);
  const [revision] = lines;
  if (lines.length !== 1 || !revision || !REVISION_RE.test(revision)) return undefined;
  return NULL_REVISION_RE.test(revision) ? undefined : revision;
}

/** A VCS path as a root-relative, `/`-separated path; null if it leaves the root. */
export function normalizeVcsPath(input: string): string | null {
  if (
    !input ||
    path.isAbsolute(input) ||
    path.win32.isAbsolute(input) ||
    path.win32.parse(input).root
  ) {
    return null;
  }
  // `path.posix.normalize` already drops a leading `./` and collapses empty
  // segments. Stripping the `./` prefix first was wrong: it turned `.//x` into
  // `/x` — an ABSOLUTE path, not the root-relative `x` the contract promises —
  // and `.//../x` into `/../x`, which normalize then resolved against `/`
  // instead of rejecting, so an input that leaves the root came back as an
  // absolute path (and `path.resolve(root, result)` escapes `root`).
  const resolved = path.posix.normalize(input.replace(/\\/g, '/'));
  if (!resolved || path.posix.isAbsolute(resolved)) return null;
  if (resolved === '.' || resolved === '..' || resolved.startsWith('../')) return null;
  return resolved;
}

/** Undefined when a listed path is rejected: the list would be incomplete. */
function paths(output: string, separator: RegExp | string): string[] | undefined {
  const normalized = output.split(separator).filter(Boolean).map(normalizeVcsPath);
  return normalized.every((value): value is string => value !== null) ? normalized : undefined;
}

function firstLine(result: VcsRunResult): string | undefined {
  if (!ok(result)) return undefined;
  return result.stdout.split(/\r?\n/)[0]?.trim() || undefined;
}

function gitAdapter(root: string, binary: string, run: VcsRunner): VcsAdapter {
  const git = (...args: string[]) => run(binary, args, root);
  return {
    kind: 'git',
    root,
    baseRevision: async () => singleRevision(await git('rev-parse', '--verify', 'HEAD')),
    changedPaths: async () => {
      const [tracked, untracked] = await Promise.all([
        // `--no-renames`: rename detection is on by default for `git diff`,
        // and `--name-only` then prints only a staged rename's NEW path. The
        // old one is a deletion from the base, and without it a workspace
        // checkpoint records no `absent` entry — materialized onto a checkout
        // of the base, the renamed-away file stays behind.
        git('diff', 'HEAD', '--name-only', '--no-renames', '-z', '--'),
        git('ls-files', '--others', '--exclude-standard', '-z'),
      ]);
      if (!ok(tracked) || !ok(untracked)) return undefined;
      const trackedPaths = paths(tracked.stdout, '\0');
      const untrackedPaths = paths(untracked.stdout, '\0');
      if (!trackedPaths || !untrackedPaths) return undefined;
      return [...new Set([...trackedPaths, ...untrackedPaths])];
    },
    isPristine: async () => {
      const status = await git(
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
        '--ignored=matching',
      );
      return ok(status) ? status.stdout.length === 0 : undefined;
    },
    // `symbolic-ref` also names the branch of a repository with no commit yet.
    currentBranch: async () => firstLine(await git('symbolic-ref', '--short', '-q', 'HEAD')),
  };
}

function jjAdapter(root: string, binary: string, run: VcsRunner): VcsAdapter {
  // jj snapshots the working copy on every command, so its answers are current.
  const jj = (...args: string[]) => run(binary, ['--color=never', ...args], root);
  const changed = async () => {
    const diff = await jj('diff', '-r', '@', '--name-only');
    return ok(diff) ? paths(diff.stdout, /\r?\n/) : undefined;
  };
  return {
    kind: 'jj',
    root,
    baseRevision: async () =>
      singleRevision(await jj('log', '-r', '@-', '--no-graph', '-T', 'commit_id ++ "\\n"')),
    changedPaths: changed,
    isPristine: async () => {
      const list = await changed();
      return list === undefined ? undefined : list.length === 0;
    },
    currentBranch: async () =>
      firstLine(
        await jj(
          'log',
          '-r',
          '@-',
          '--no-graph',
          '-T',
          'local_bookmarks.map(|b| b.name()).join("\\n")',
        ),
      ),
  };
}

function hgAdapter(root: string, binary: string, run: VcsRunner): VcsAdapter {
  const hg = (...args: string[]) => run(binary, args, root);
  const status = async (flags: string) => {
    const result = await hg('status', flags, '-n', '-0');
    return ok(result) ? paths(result.stdout, '\0') : undefined;
  };
  return {
    kind: 'hg',
    root,
    baseRevision: async () => singleRevision(await hg('log', '-r', '.', '-T', '{node}\\n')),
    // modified, added, removed, deleted (missing) and unknown (untracked).
    changedPaths: () => status('-mardu'),
    isPristine: async () => {
      const list = await status('-mardui');
      return list === undefined ? undefined : list.length === 0;
    },
    currentBranch: async () =>
      firstLine(await hg('log', '-r', '.', '-T', '{activebookmark}')) ??
      firstLine(await hg('branch')),
  };
}
