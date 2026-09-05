import { type ExecResult, execCommand } from '../exec-command.js';

/** Injectable command runner (defaults to execCommand) for testability. */
export type Exec = (opts: {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  shell?: boolean | undefined;
}) => Promise<ExecResult>;

/**
 * Extract the model's patch from a finished SWE-bench workdir.
 *
 * The workdir is a git checkout at the instance's base commit; the agent's
 * edits are uncommitted. `git add -A` stages new/modified/deleted files, then
 * `git diff --cached` produces a unified diff in the exact form the official
 * SWE-bench harness expects as `model_patch`.
 *
 * Changes to files touched by the held-out `test_patch` are stripped: the
 * harness applies the model patch and then the test patch, and the agent is
 * told not to edit tests — dropping those sections keeps the model patch from
 * conflicting with (or sneaking changes into) the graded tests.
 */
export async function extractModelPatch(opts: {
  workdir: string;
  /** The instance's held-out test patch, used to exclude test-file edits. */
  testPatch?: string | undefined;
  timeoutMs: number;
  exec?: Exec | undefined;
}): Promise<string> {
  const exec = opts.exec ?? execCommand;
  // git is a real executable — no shell needed, so nothing in the (controlled)
  // args is ever interpreted.
  await exec({
    command: 'git',
    args: ['add', '-A'],
    cwd: opts.workdir,
    timeoutMs: opts.timeoutMs,
    shell: false,
  });
  const diff = await exec({
    command: 'git',
    args: ['diff', '--cached', '--no-color'],
    cwd: opts.workdir,
    timeoutMs: opts.timeoutMs,
    shell: false,
  });
  const raw = diff.stdout;
  const testPaths = opts.testPatch ? extractPatchPaths(opts.testPatch) : new Set<string>();
  // Always drop two kinds of sections: (1) edits to the held-out test files,
  // and (2) harness bookkeeping the wstack subprocess writes into the checkout
  // (the `.gitignore` `.wrongstack/` line and any `.wrongstack/` dir) — neither
  // is part of the model's fix, and both would corrupt a SWE-bench prediction.
  return filterPatchSections(
    raw,
    (a, b) => testPaths.has(a) || testPaths.has(b) || isHarnessArtifact(a) || isHarnessArtifact(b),
  );
}

/** True for paths the wstack harness itself creates/edits in the checkout. */
function isHarnessArtifact(p: string): boolean {
  return p === '.gitignore' || p.split('/')[0] === '.wrongstack';
}

/**
 * Collect the file paths a unified diff touches. Reads both the
 * `diff --git a/<p> b/<p>` header and the `+++ b/<p>` / `--- a/<p>` lines so it
 * works on patches produced by git or by `diff -u`.
 */
export function extractPatchPaths(patch: string): Set<string> {
  const paths = new Set<string>();
  for (const line of patch.split('\n')) {
    const git = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (git) {
      paths.add(git[1] as string);
      paths.add(git[2] as string);
      continue;
    }
    const minus = /^--- (?:a\/)?(.+)$/.exec(line);
    if (minus && minus[1] !== '/dev/null') paths.add(stripTimestamp(minus[1] as string));
    const plus = /^\+\+\+ (?:b\/)?(.+)$/.exec(line);
    if (plus && plus[1] !== '/dev/null') paths.add(stripTimestamp(plus[1] as string));
  }
  return paths;
}

/**
 * Drop every per-file section of `patch` whose target path is in `exclude`.
 * Sections are delimited by `diff --git` headers (git's format).
 */
export function filterPatchExcludingPaths(patch: string, exclude: Set<string>): string {
  if (exclude.size === 0) return patch;
  return filterPatchSections(patch, (a, b) => exclude.has(a) || exclude.has(b));
}

/**
 * Drop each per-file section for which `shouldDrop(aPath, bPath)` is true.
 *
 * Sections are delimited by `diff --git` headers (git's format) or, when the
 * patch has none, by `---`/`+++` unified-diff headers (`diff -u`'s format) —
 * matching the dual-format support in {@link extractPatchPaths}. A path cannot
 * begin with a literal `--- `/`+++ ` content line, so those are unambiguous
 * section starts in the absence of `diff --git` headers.
 */
export function filterPatchSections(
  patch: string,
  shouldDrop: (aPath: string, bPath: string) => boolean,
): string {
  const lines = patch.split('\n');
  const out: string[] = [];
  let skipping = false;
  let gitFormat = false;
  // In diff -u mode a section's `--- old`/`+++ new` headers pair up; the drop
  // decision depends on BOTH paths, so buffer the header lines and flush them
  // only once the whole section's skip state is known (at the first content
  // line, the next section start, or EOF). This keeps a dropped section from
  // leaking a lone `---`/`+++` header.
  let pending: string[] = [];
  let pendingSkipping = false;
  // Flush a buffered diff -u section. Returns true when a section was finalized
  // (so the caller can then lock `skipping` from `pendingSkipping` exactly once).
  const flushPending = (): boolean => {
    if (pending.length === 0) return false;
    if (!pendingSkipping) out.push(...pending);
    pending = [];
    return true;
  };
  for (const line of lines) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (header) {
      flushPending();
      gitFormat = true;
      skipping = shouldDrop(header[1] as string, header[2] as string);
    } else if (!gitFormat) {
      const minus = /^--- (?:a\/)?(.+)$/.exec(line);
      const plus = /^\+\+\+ (?:b\/)?(.+)$/.exec(line);
      if (minus) {
        flushPending();
        if (minus[1] !== '/dev/null') {
          pendingSkipping = shouldDrop(stripTimestamp(minus[1] as string), '');
        } else {
          pendingSkipping = false;
        }
        pending.push(line);
        continue;
      }
      if (plus) {
        if (plus[1] !== '/dev/null') {
          pendingSkipping = pendingSkipping || shouldDrop(stripTimestamp(plus[1] as string), '');
        }
        pending.push(line);
        continue;
      }
      // Non-header content line: finalize the pending section's headers, then
      // lock skipping for every remaining content line of this section.
      if (flushPending()) {
        skipping = pendingSkipping;
        pendingSkipping = false;
      }
    }
    if (!skipping) out.push(line);
  }
  flushPending();
  return out.join('\n');
}

/** Strip a trailing tab+timestamp some diff tools append to `+++`/`---` paths. */
function stripTimestamp(p: string): string {
  const tab = p.indexOf('\t');
  return tab === -1 ? p : p.slice(0, tab);
}
