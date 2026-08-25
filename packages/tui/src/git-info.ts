import { spawn } from 'node:child_process';
import { buildChildEnv } from '@wrongstack/core/utils';

export interface GitInfo {
  branch: string;
  /** Total lines added in working tree vs HEAD (staged + unstaged). */
  added: number;
  /** Total lines deleted in working tree vs HEAD (staged + unstaged). */
  deleted: number;
  /** Count of untracked files in the working tree. */
  untracked: number;
}

/**
 * Read git branch + change summary for the given cwd. Returns `null`
 * when the directory isn't a git repository or git isn't installed —
 * the status bar just hides the git chip in that case.
 *
 * Spawns TWO short-lived `git` processes in parallel — `status
 * --porcelain=v2 --branch` (branch name, detached OID, untracked count) and
 * `diff HEAD --numstat` (line counts). It used to be three: `branch
 * --show-current` was its own spawn, plus a fourth `rev-parse --short`
 * whenever HEAD was detached. Porcelain v2's `# branch.oid` / `# branch.head`
 * header carries both, so those spawns are gone.
 *
 * Process spawn is the dominant cost here (~40-80ms each on Windows), not
 * git's own work, so spawn count is the number that matters. The caller owns
 * the cadence and should skip calling this when nothing has changed — see
 * `use-git-session-status.ts`.
 */
export async function readGitInfo(cwd: string): Promise<GitInfo | null> {
  // Folded as the child streams, never buffered. `--numstat` and
  // `--porcelain` are unbounded in the size of the working tree, and all we
  // want out of them is three integers. See foldGit.
  let added = 0;
  let deleted = 0;
  let untracked = 0;

  let branchHead = '';
  let branchOid = '';

  const [numstatRes, statusRes] = await Promise.all([
    foldGit(cwd, ['diff', 'HEAD', '--numstat'], (line) => {
      if (!line) return;
      const [a, d] = line.split('\t');
      // Binary files report '-' for both columns — skip them.
      if (a && a !== '-') added += Number.parseInt(a, 10) || 0;
      if (d && d !== '-') deleted += Number.parseInt(d, 10) || 0;
    }),
    foldGit(cwd, ['status', '--porcelain=v2', '--branch'], (line) => {
      // Porcelain v2 emits its header lines first; they are the only reason
      // we pass --branch: `# branch.head <name|(detached)>` and
      // `# branch.oid <sha|(initial)>`.
      if (line.startsWith('# branch.head ')) {
        branchHead = line.slice('# branch.head '.length).trim();
        return;
      }
      if (line.startsWith('# branch.oid ')) {
        branchOid = line.slice('# branch.oid '.length).trim();
        return;
      }
      // v2 marks untracked entries with a bare '? ' prefix (v1 used '?? ').
      if (line.startsWith('? ')) untracked++;
    }),
  ]);

  // If either failed with a non-zero exit OR git wasn't found, we're not in a
  // repo (or git is missing) — bail entirely. The counters above may hold
  // partial folds; discarding them here is why they are never read on the
  // failure path.
  if (!numstatRes.ok || !statusRes.ok) return null;

  return { branch: branchLabel(branchHead, branchOid), added, deleted, untracked };
}

/**
 * Collapse porcelain v2's branch header into the chip's single label.
 *
 * `branch.head` is the branch name, or the literal `(detached)`. On a
 * detached HEAD we render the short OID so the chip is never blank;
 * `branch.oid` is `(initial)` in a repo with no commits yet, which is not a
 * SHA and must not be shown as one. OID length depends on the repo's object
 * format — 40 hex for SHA-1 repos, 64 for SHA-256 (`git init
 * --object-format=sha256`) — so both bounds are accepted.
 */
export function branchLabel(head: string, oid: string): string {
  if (head && head !== '(detached)') return head;
  if (/^[0-9a-f]{7,64}$/.test(oid)) return oid.slice(0, 7);
  return 'detached';
}

/**
 * Ceiling on the in-flight partial line held by {@link foldGit}. git never
 * emits a line this long (a path would have to exceed it), so hitting the
 * cap means something is wrong and dropping the excess is preferable to
 * letting one "line" become the buffer we were trying to avoid.
 */
const MAX_LINE_CHARS = 64 * 1024;

function spawnGit(cwd: string, args: string[]) {
  // `--no-optional-locks` is a git-level option and must precede the
  // subcommand. Without it `git status` refreshes the stat cache by REWRITING
  // .git/index (922KB in this repo) on every poll, and holds .git/index.lock
  // while doing so — racing the user's own git commands and their editor's
  // git integration. Every invocation here is a read, so that refresh is
  // pure cost.
  return spawn('git', ['--no-optional-locks', ...args], {
    cwd,
    env: buildChildEnv(),
    // Inherit stderr (silent) — we don't care about git's noise.
    stdio: ['ignore', 'pipe', 'ignore'],
    // Don't let a slow git hang the TUI.
    timeout: 3000,
    windowsHide: true,
  });
}

/**
 * Run git and reduce its stdout line-by-line, retaining nothing beyond the
 * current partial line.
 *
 * `git status --porcelain` and `git diff --numstat` are unbounded in the size
 * of the working tree — a repo with a large unignored subtree (a stray
 * `dist/`, an un-gitignored `node_modules`) emits tens of megabytes. This
 * runs on a 10-second interval from `use-git-session-status`, so buffering
 * the whole thing meant a multi-megabyte string allocated and discarded six
 * times a minute for output we immediately collapse into two integers.
 * Folding as it streams keeps the peak at one chunk.
 *
 * `onLine` receives lines WITHOUT the trailing newline, including empty ones
 * — callers filter as they see fit.
 */
function foldGit(
  cwd: string,
  args: string[],
  onLine: (line: string) => void,
): Promise<{ ok: boolean }> {
  return new Promise((resolve) => {
    try {
      const child = spawnGit(cwd, args);
      let carry = '';
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        carry += chunk;
        // Walk with an index rather than re-slicing per line: `carry` is one
        // chunk wide, but a chunk can hold thousands of porcelain lines and
        // slicing each one off the front would be quadratic.
        let start = 0;
        let nl = carry.indexOf('\n', start);
        while (nl !== -1) {
          onLine(carry.slice(start, nl));
          start = nl + 1;
          nl = carry.indexOf('\n', start);
        }
        if (start > 0) carry = carry.slice(start);
        if (carry.length > MAX_LINE_CHARS) carry = carry.slice(0, MAX_LINE_CHARS);
      });
      child.on('error', () => resolve({ ok: false }));
      child.on('close', (code) => {
        // Trailing line without a terminating newline.
        if (carry) onLine(carry);
        resolve({ ok: code === 0 });
      });
    } catch {
      resolve({ ok: false });
    }
  });
}
