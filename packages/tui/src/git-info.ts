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
 * Spawns two short-lived `git` processes in parallel. Cheap enough to
 * call on a 3–5 second interval; the caller is responsible for the
 * cadence (this function is purely fire-and-result).
 */
export async function readGitInfo(cwd: string): Promise<GitInfo | null> {
  // Folded as the child streams, never buffered. `--numstat` and
  // `--porcelain` are unbounded in the size of the working tree, and all we
  // want out of them is three integers. See foldGit.
  let added = 0;
  let deleted = 0;
  let untracked = 0;

  const [branchRes, numstatRes, statusRes] = await Promise.all([
    runGit(cwd, ['branch', '--show-current']),
    foldGit(cwd, ['diff', 'HEAD', '--numstat'], (line) => {
      if (!line) return;
      const [a, d] = line.split('\t');
      // Binary files report '-' for both columns — skip them.
      if (a && a !== '-') added += Number.parseInt(a, 10) || 0;
      if (d && d !== '-') deleted += Number.parseInt(d, 10) || 0;
    }),
    foldGit(cwd, ['status', '--porcelain'], (line) => {
      if (line.startsWith('?? ')) untracked++;
    }),
  ]);

  // If any of the three failed with a non-zero exit OR git wasn't
  // found, we're not in a repo (or git is missing) — bail entirely.
  // The counters above may hold partial folds; discarding them here is why
  // they are never read on the failure path.
  if (!branchRes.ok || !numstatRes.ok || !statusRes.ok) return null;

  const branch = branchRes.stdout.trim();
  // Detached HEAD: `branch --show-current` returns empty. Render the
  // short SHA instead so the chip isn't blank.
  const branchLabel = branch || (await detachedShortSha(cwd)) || 'detached';

  return { branch: branchLabel, added, deleted, untracked };
}

async function detachedShortSha(cwd: string): Promise<string | null> {
  const res = await runGit(cwd, ['rev-parse', '--short', 'HEAD']);
  return res.ok ? res.stdout.trim() : null;
}

interface GitResult {
  ok: boolean;
  stdout: string;
}

/**
 * Ceiling on retained stdout for the commands whose full text we actually
 * need (`branch --show-current`, `rev-parse --short`). Both emit a single
 * short line; the cap only exists so a wedged or hostile git can't grow the
 * string without bound.
 */
const MAX_RETAINED_STDOUT = 64 * 1024;

/**
 * Ceiling on the in-flight partial line held by {@link foldGit}. git never
 * emits a line this long (a path would have to exceed it), so hitting the
 * cap means something is wrong and dropping the excess is preferable to
 * letting one "line" become the buffer we were trying to avoid.
 */
const MAX_LINE_CHARS = 64 * 1024;

function spawnGit(cwd: string, args: string[]) {
  return spawn('git', args, {
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

function runGit(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    let stdout = '';
    try {
      const child = spawnGit(cwd, args);
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        if (stdout.length >= MAX_RETAINED_STDOUT) return;
        stdout += chunk;
      });
      child.on('error', () => resolve({ ok: false, stdout: '' }));
      child.on('close', (code) => {
        resolve({ ok: code === 0, stdout });
      });
    } catch {
      resolve({ ok: false, stdout: '' });
    }
  });
}
