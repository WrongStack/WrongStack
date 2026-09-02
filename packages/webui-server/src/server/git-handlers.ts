/**
 * Shared `git.info` WebSocket handler for both the standalone WebUI server and
 * the CLI's `--webui` embedded server. Extracted from the duplicated switch
 * cases in `index.ts` and `cli/src/webui-server.ts`, which had drifted (the
 * standalone copy transposed ahead/behind and never matched deletions). One
 * implementation here keeps both surfaces in lockstep.
 *
 *   case 'git.info': return handleGitInfo(ws, projectRoot);
 */

import type { WebSocket } from 'ws';
import nodePath from 'node:path';
import { isPathInside } from './path-containment.js';
import { send } from './ws-utils.js';

/**
 * Read git branch, change stats, and upstream sync status from `projectRoot`
 * and broadcast a `git.info` message. Never throws — a non-repo / missing-git
 * directory yields an empty-but-valid payload.
 */
export async function handleGitInfo(ws: WebSocket, projectRoot: string): Promise<void> {
  const cwd = projectRoot || undefined;
  try {
    const { execFile: ef } = await import('node:child_process');
    const git = (args: string[]): Promise<string> =>
      new Promise((resolve) => {
        ef('git', args, { cwd, timeout: 3000 }, (err: Error | null, stdout: string) => {
          resolve(err ? '' : stdout.trim());
        });
      });

    const [branchRaw, diffRaw, statusRaw, upstreamRaw] = await Promise.all([
      git(['branch', '--show-current']),
      git(['diff', '--stat']),
      git(['status', '--porcelain']),
      git(['rev-list', '--left-right', '--count', '@{upstream}...HEAD']),
    ]);

    const branch = branchRaw || '(detached)';

    // `git diff --stat` summary line: "N files changed, X insertions(+), Y deletions(-)".
    // Deletions are formatted "Y deletions(-)" — the `+` only ever precedes
    // INSERTIONS, so a `\+`-anchored deletion regex never matches.
    const addMatch = /(\d+)\s+insertion/i.exec(diffRaw);
    const delMatch = /(\d+)\s+deletion/i.exec(diffRaw);
    const added = addMatch ? Number(addMatch[1]) : 0;
    const deleted = delMatch ? Number(delMatch[1]) : 0;

    // Untracked files from `git status --porcelain` (lines starting with "??").
    const untracked = statusRaw.split('\n').filter((l) => l.startsWith('??')).length;

    // `git rev-list --left-right --count @{upstream}...HEAD` prints "<behind>\t<ahead>":
    // left = commits in upstream not in HEAD (BEHIND), right = HEAD-only (AHEAD).
    const [behindRaw, aheadRaw] = (upstreamRaw || '0\t0').split('\t');
    const behind = Number(behindRaw) || 0;
    const ahead = Number(aheadRaw) || 0;

    send(ws, { type: 'git.info', payload: { branch, added, deleted, untracked, ahead, behind } });
  } catch {
    // Git not available or not a repo — send empty info silently.
    send(ws, {
      type: 'git.info',
      payload: { branch: '', added: 0, deleted: 0, untracked: 0, ahead: 0, behind: 0 },
    });
  }
}

/** One changed file in the working tree (vs HEAD). */
export interface GitChangedFile {
  /** Repo-relative path (POSIX separators, as git reports). */
  path: string;
  /**
   * Single-letter change kind for the badge:
   * `M` modified, `A` added/staged-new, `D` deleted, `R` renamed,
   * `?` untracked, `C` copied, `U` unmerged/conflict.
   */
  status: string;
  /** Lines added (best-effort; 0 for untracked-binary / unknown). */
  added: number;
  /** Lines removed (best-effort). */
  deleted: number;
  /** True when the change is at least partly staged. */
  staged: boolean;
}

/** Spawn `git` in `cwd` and resolve its trimmed stdout ('' on any error). */
function makeGit(cwd: string | undefined) {
  return async (args: string[]): Promise<string> => {
    const { execFile: ef } = await import('node:child_process');
    return new Promise((resolve) => {
      ef(
        'git',
        args,
        { cwd, timeout: 5000, maxBuffer: 1024 * 1024 * 16 },
        (err: Error | null, stdout: string) => resolve(err ? '' : stdout),
      );
    });
  };
}

/**
 * Compute the repo-relative prefix for a project root, normalized to
 * forward slashes with a trailing separator ('' when the project root IS
 * the repo root, or either side is unknown/escapes the repo).
 *
 * `git status --porcelain` always reports paths relative to the REPOSITORY
 * root, while `files.tree` node paths are relative to the PROJECT root.
 * When a subdirectory of the repo is opened as the project (e.g.
 * `packages/webui`), git paths like `packages/webui/src/a.ts` carry a
 * prefix the tree never emits — every explorer git badge would silently
 * miss. Prepending this prefix to tree-relative paths aligns the two
 * bases; separator normalization keeps it valid on Windows where
 * `rev-parse --show-toplevel` may print either separator style.
 */
export function repoRelativePrefix(repoRoot: string, projectRoot: string): string {
  if (!repoRoot || !projectRoot) return '';
  const rel = nodePath
    .relative(nodePath.normalize(repoRoot), nodePath.normalize(projectRoot))
    .replaceAll('\\', '/');
  if (!rel || rel === '.') return '';
  // Outside the repo maps to '' — SEGMENT-aware: '..' or '../x' escapes,
  // but a legal `..hidden` directory name does NOT (a raw startsWith('..')
  // falsely reported "no relation" for projects under such a directory).
  if (rel === '..' || rel.startsWith('../')) return '';
  return rel + '/';
}

/**
 * Rank for aggregating a directory's badge status from its children:
 * conflict > deletion > modification > rename/copy > addition > untracked.
 */
const DIR_STATUS_RANK: Record<string, number> = { U: 6, D: 5, M: 4, R: 3, C: 3, A: 2, '?': 1 };

/**
 * Read the working-tree change set (everything that differs from HEAD:
 * staged, unstaged, and untracked) and broadcast a `git.changes` message.
 *
 * The file list comes from `git status --porcelain -z` (NUL-delimited so
 * paths with spaces/unicode survive intact, and renames are unambiguous).
 * Per-file line counts come from `--numstat` of both the unstaged and the
 * staged diff, summed. Untracked files intentionally report 0/0 here so the
 * list view does not read every untracked file; `git.diff` loads a selected
 * file lazily on demand.
 * Never throws — a non-repo yields an empty list.
 */
export async function handleGitChanges(ws: WebSocket, projectRoot: string): Promise<void> {
  const cwd = projectRoot || undefined;
  try {
    const git = makeGit(cwd);
    const [statusRaw, unstagedNumstat, stagedNumstat, toplevelRaw] = await Promise.all([
      git(['status', '--porcelain', '-z']),
      git(['diff', '--numstat', '-z']),
      git(['diff', '--cached', '--numstat', '-z']),
      git(['rev-parse', '--show-toplevel']),
    ]);
    // Porcelain paths are repo-root-relative; tree paths are
    // project-root-relative. Send the mapping prefix so the client does
    // not have to guess (see repoRelativePrefix). The trim matters: this
    // git helper (unlike handleGitInfo's) does not strip the trailing
    // newline rev-print emits, and a "\n" suffix breaks path.relative.
    const repoPrefix = repoRelativePrefix(toplevelRaw.trim(), projectRoot);

    // Seed the shared cache (see currentRepoPrefix): every changes
    // refresh re-warms the prefix for this project root, so the NEXT
    // stage/unstage/discard skips its rev-parse entirely. Only successful
    // lookups are cached — an empty toplevel (not a repo) must not pin ''
    // for the TTL window.
    const toplevel = toplevelRaw.trim();
    if (toplevel) {
      cacheRepoRoot(nodePath.resolve(projectRoot || '.'), toplevel);
    }

    // numstat -z format: "<added>\t<deleted>\t<path>\0" per entry. For a rename
    // git emits "<added>\t<deleted>\0<oldpath>\0<newpath>\0" (path field empty,
    // two extra NUL records). Parse defensively, keying counts by final path.
    const counts = new Map<string, { added: number; deleted: number }>();
    const parseNumstat = (raw: string): void => {
      const parts = raw.split('\0');
      for (let i = 0; i < parts.length; i++) {
        const entry = parts[i];
        if (!entry) continue;
        const m = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(entry);
        if (!m) continue;
        const added = m[1] === '-' ? 0 : Number(m[1]);
        const deleted = m[2] === '-' ? 0 : Number(m[2]);
        let path = m[3] ?? '';
        if (path === '') {
          // Rename: next two records are old, then new path.
          i += 1;
          path = parts[i + 1] ?? parts[i] ?? '';
          i += 1;
        }
        if (!path) continue;
        const prev = counts.get(path) ?? { added: 0, deleted: 0 };
        counts.set(path, { added: prev.added + added, deleted: prev.deleted + deleted });
      }
    };
    parseNumstat(unstagedNumstat);
    parseNumstat(stagedNumstat);

    // `git status --porcelain -z`: each record is "XY <path>" (no separator
    // after the 2-char code beyond the single space). Rename/copy records are
    // followed by a separate NUL record carrying the original path.
    const records = statusRaw.split('\0').filter((r) => r.length > 0);
    const files: GitChangedFile[] = [];
    for (let i = 0; i < records.length; i++) {
      const rec = records[i];
      if (!rec || rec.length < 3) continue;
      const x = rec[0] ?? ' ';
      const y = rec[1] ?? ' ';
      const path = rec.slice(3);
      const isRename = x === 'R' || x === 'C' || y === 'R' || y === 'C';
      if (isRename) i += 1; // consume the original-path record that follows

      let status: string;
      if (x === '?' && y === '?') status = '?';
      else if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D'))
        status = 'U';
      else if (x === 'R' || y === 'R') status = 'R';
      else if (x === 'C' || y === 'C') status = 'C';
      else if (x === 'A' || y === 'A') status = 'A';
      else if (x === 'D' || y === 'D') status = 'D';
      else status = 'M';

      const staged = x !== ' ' && x !== '?';

      let added = counts.get(path)?.added ?? 0;
      let deleted = counts.get(path)?.deleted ?? 0;
      if (status === '?') {
        // Untracked files are not present in numstat. Do not read every file
        // here: large generated/untracked trees made git.changes an N+1 file
        // scan. The diff endpoint loads a selected file on demand.
        added = 0;
        deleted = 0;
      }
      files.push({ path, status, added, deleted, staged });
    }

    // Aggregate per-directory status so the explorer can badge folders from
    // server data instead of client-side prefix scanning: every ancestor
    // directory of a changed file inherits the highest-ranked child status
    // (see DIR_STATUS_RANK). Keys are repo-relative like `files`; the client
    // aligns them with project-relative tree paths via repoPrefix. The
    // trailing-slash strip handles porcelain's collapsed untracked dirs
    // (`?? assets/`), which arrive as a single "file" record.
    const dirs = new Map<string, string>();
    for (const f of files) {
      const rank = DIR_STATUS_RANK[f.status] ?? 0;
      // A trailing slash means porcelain COLLAPSED a fully-untracked
      // directory into a single record (`?? assets/`): the path IS a
      // directory, not a file with a parent to pop. Register the directory
      // itself with its status — the client's tree paths carry no trailing
      // slash, so neither the file map nor the popped walk can badge it.
      const collapsedDir = f.path.endsWith('/');
      const segments = f.path.replace(/\/$/, '').split('/');
      if (!collapsedDir) segments.pop(); // drop the filename — files only
      for (let i = 1; i <= segments.length; i++) {
        const dir = segments.slice(0, i).join('/');
        const prev = dirs.get(dir);
        if (!prev || (DIR_STATUS_RANK[prev] ?? 0) < rank) dirs.set(dir, f.status);
      }
    }

    send(ws, {
      type: 'git.changes',
      payload: { files, dirs: Object.fromEntries(dirs), repoPrefix },
    });
  } catch (err) {
    send(ws, {
      type: 'git.changes',
      payload: {
        files: [],
        dirs: {},
        repoPrefix: '',
        error: err instanceof Error ? err.message : String(err),
      },
    });
  }
}

const MAX_DIFF_BYTES = 2 * 1024 * 1024; // 2 MB per side — guard the renderer

/**
 * Resolve the before/after text for a single file and broadcast a `git.diff`
 * message. `oldText` is the file at HEAD (`git show HEAD:<path>`), `newText`
 * is the current working-tree content. New/untracked files have empty
 * `oldText`; deleted files have empty `newText`. Binary or oversized files
 * are reported with a flag instead of content so the client can show a notice.
 */
export async function handleGitDiff(
  ws: WebSocket,
  projectRoot: string,
  path: string,
): Promise<void> {
  const cwd = projectRoot || undefined;
  const reply = (extra: Record<string, unknown>): void =>
    send(ws, { type: 'git.diff', payload: { path, ...extra } });

  // Same segment-based validator as the action handlers: a legal
  // `release..notes.md` filename must be diffable, not just stageable —
  // the old raw substring check rejected it here while staging accepted it.
  if (isUnsafeRelativePath(path)) {
    reply({ oldText: '', newText: '', error: 'invalid path' });
    return;
  }

  try {
    const git = makeGit(cwd);
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');

    // The client sends REPO-relative paths (the git.changes shape). The
    // `git show HEAD:<path>` rev syntax is itself repo-root-relative from
    // any cwd, so the original path is correct there — but the working-
    // tree readFile joins against projectRoot and would double-nest in a
    // subdirectory project (`<project>/packages/webui/packages/webui/…`),
    // making every file read as deleted. Translate ONLY the read side.
    const prefix = await currentRepoPrefix(projectRoot);
    if (prefix && !path.startsWith(prefix)) {
      reply({ oldText: '', newText: '', error: 'path outside project root' });
      return;
    }
    const treePath = prefix ? path.slice(prefix.length) : path;

    // HEAD version. `git show` writes nothing for a path absent at HEAD.
    const oldText = await git(['show', `HEAD:${path}`]);

    // Working-tree version (absent → deleted file → empty).
    let newText = '';
    try {
      const abs = cwd ? join(cwd, treePath) : treePath;
      let readPath = abs;
      if (cwd) {
        const { realpath } = await import('node:fs/promises');
        const realRoot = await realpath(cwd).catch(() => nodePath.resolve(cwd));
        try {
          readPath = await realpath(abs);
        } catch (err) {
          // ENOENT: deleted in the working tree — lexical containment only.
          // Never readFile(abs): that would follow a dangling-or-escaping symlink.
          // Any other realpath failure is fail-closed (no unresolved fallback).
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            if (!isPathInside(nodePath.resolve(cwd), nodePath.resolve(abs))) {
              reply({ oldText: '', newText: '', error: 'path outside project root' });
              return;
            }
            newText = '';
            readPath = '';
          } else {
            reply({ oldText: '', newText: '', error: 'path outside project root' });
            return;
          }
        }
        if (readPath && !isPathInside(realRoot, readPath)) {
          reply({ oldText: '', newText: '', error: 'path outside project root' });
          return;
        }
      }
      if (readPath) {
        const buf = await readFile(readPath);
        if (buf.includes(0)) {
          reply({ oldText: '', newText: '', binary: true });
          return;
        }
        if (buf.length > MAX_DIFF_BYTES) {
          reply({ oldText: '', newText: '', tooLarge: true });
          return;
        }
        newText = buf.toString('utf8');
      }
    } catch {
      newText = '';
    }

    if ((oldText.length || 0) > MAX_DIFF_BYTES) {
      reply({ oldText: '', newText: '', tooLarge: true });
      return;
    }
    if (oldText.includes('\0')) {
      reply({ oldText: '', newText: '', binary: true });
      return;
    }

    reply({ oldText, newText });
  } catch (err) {
    reply({ oldText: '', newText: '', error: err instanceof Error ? err.message : String(err) });
  }
}

async function execGit(
  cwd: string | undefined,
  args: string[],
  opts?: { literalPathspecs?: boolean },
): Promise<{ ok: boolean; stdout: string; stderr: string; error?: string }> {
  const { execFile: ef } = await import('node:child_process');
  return new Promise((resolve) => {
    ef(
      'git',
      args,
      {
        cwd,
        timeout: 10000,
        maxBuffer: 1024 * 1024 * 16,
        // Pathspec magic containment (chimera round-4), OPT-IN (chimera
        // follow-up): a validated input like `packages/webui/:(top)keep.txt`
        // translates to `:(top)keep.txt`, passes every lexical check as an
        // odd filename, and — WITHOUT this flag — git interprets the
        // `:(top)` magic and targets a repo-ROOT file outside the opened
        // project. Literal pathspecs make every `--` argument a plain
        // filename; the attack then simply matches nothing.
        // Scoped per-call because the variable LEAKS to child processes:
        // `git commit` runs user hooks (pre-commit, commit-msg), and
        // GIT_LITERAL_PATHSPECS=1 in that environment rewrites how the
        // user's own hook scripts interpret every pathspec they touch.
        // Only pathspec-carrying mutations opt in (`.` and literal paths
        // only — no caller relies on magic).
        env:
          opts?.literalPathspecs === true
            ? { ...process.env, GIT_LITERAL_PATHSPECS: '1' }
            : process.env,
      },
      (err: Error | null, stdout: string, stderr: string) => {
        if (err) {
          resolve({ ok: false, stdout: stdout || '', stderr: stderr || '', error: err.message });
        } else {
          resolve({ ok: true, stdout: stdout || '', stderr: stderr || '' });
        }
      },
    );
  });
}

/**
 * Lexical safety for a RELATIVE pathspec. The `..` check is SEGMENT-based,
 * not substring: `release..notes.md` is a legal filename (two dots inside
 * one segment), while `a/../b` traverses. Empty segments (`foo//bar`, a
 * trailing `/`) are NOT unsafe — they are paste artifacts that
 * {@link normalizePathspec} collapses; rejecting them turned valid client
 * payloads into hard errors. Absolute, NUL, and leading-dash paths are
 * rejected outright.
 */
function isUnsafeRelativePath(p: string): boolean {
  if (
    !p ||
    typeof p !== 'string' ||
    p.includes('\0') ||
    nodePath.isAbsolute(p) ||
    p.startsWith('-')
  ) {
    return true;
  }
  return p
    .replaceAll('\\', '/')
    .split('/')
    .some((seg) => seg === '..');
}

/** Collapse `//` runs and trailing separators into a clean git pathspec. */
function normalizePathspec(p: string): string {
  const collapsed = p.replaceAll('\\', '/').replace(/\/+/g, '/').replace(/\/+$/, '');
  return collapsed || '.';
}

function validateAndFilterPaths(
  projectRoot: string,
  paths: string[],
): { safe: string[]; error?: string } {
  const safe: string[] = [];
  const root = nodePath.resolve(projectRoot || '.');
  for (const p of paths) {
    if (isUnsafeRelativePath(p)) {
      return { safe: [], error: `Invalid or unsafe path: ${p}` };
    }
    const abs = nodePath.resolve(root, p);
    if (!isPathInside(root, abs)) {
      return { safe: [], error: `Path outside project root: ${p}` };
    }
    safe.push(p);
  }
  return { safe };
}

/**
 * Repo→project prefix for the CURRENT repository ('' when projectRoot is
 * the repo root, or git is unavailable / not a repo).
 *
 * The rev-parse result is cached per RESOLVED projectRoot (chimera perf:
 * one git process per stage/unstage/discard/diff call was pure overhead
 * for click bursts). The cache key is the project root itself, so a
 * project SWITCH resolves fresh — each project gets its own prefix,
 * never the previous project's. A short TTL bounds staleness for the
 * rare case of the repo layout changing under an unchanged project root
 * (e.g. a new `git init` inside the project). Failed rev-parses are NOT
 * cached: a transient failure must not pin '' for the TTL window.
 */
const REPO_ROOT_CACHE_TTL_MS = 30_000;
/** Bound the cache: distinct project roots are few, but a long-running
 * server must never retain one entry per root forever. Map preserves
 * insertion order, so eviction drops the oldest entry. */
const REPO_ROOT_CACHE_MAX = 64;
const repoRootCache = new Map<string, { repoRoot: string; at: number }>();

/** Record a successful rev-parse, evicting the oldest entry at capacity. */
function cacheRepoRoot(key: string, repoRoot: string): void {
  if (repoRootCache.size >= REPO_ROOT_CACHE_MAX) {
    const oldest = repoRootCache.keys().next().value;
    if (oldest !== undefined) repoRootCache.delete(oldest);
  }
  repoRootCache.set(key, { repoRoot, at: Date.now() });
}

async function currentRepoPrefix(projectRoot: string): Promise<string> {
  const key = nodePath.resolve(projectRoot || '.');
  const hit = repoRootCache.get(key);
  if (hit) {
    if (Date.now() - hit.at < REPO_ROOT_CACHE_TTL_MS) {
      return repoRelativePrefix(hit.repoRoot, projectRoot);
    }
    // Expired entries are DELETED, not just bypassed — otherwise the map
    // retains one stale entry per project root for the process lifetime.
    repoRootCache.delete(key);
  }
  const res = await execGit(projectRoot || undefined, ['rev-parse', '--show-toplevel']);
  if (!res.ok) return '';
  const repoRoot = res.stdout.trim();
  cacheRepoRoot(key, repoRoot);
  return repoRelativePrefix(repoRoot, projectRoot);
}

/**
 * Translate REPO-relative pathspecs (the shape `git.changes` emits and the
 * Changes panel sends back) into pathspecs relative to `projectRoot`, the
 * cwd every path-consuming git action executes with.
 *
 * When a repo subdirectory is opened as the project, a repo-relative path
 * like `packages/webui/a.ts` resolved against projectRoot double-nests
 * (`<project>/packages/webui/packages/webui/a.ts`) — stage/unstage/discard
 * then fail or silently no-op. Stripping the server-computed prefix aligns
 * the pathspec with the execution cwd.
 *
 * Translation (not executing from the repo root) is deliberate: mutating
 * files outside the opened project would widen the client's write surface,
 * against this server's containment posture — a repo-relative path that
 * does not carry the prefix is rejected, same message as the lexical check.
 */
async function translateRepoPathspecs(
  projectRoot: string,
  paths: string[],
): Promise<{ safe: string[]; originals: string[]; error?: string }> {
  for (const p of paths) {
    if (isUnsafeRelativePath(p)) {
      return { safe: [], originals: [], error: `Invalid or unsafe path: ${p}` };
    }
  }
  const prefix = await currentRepoPrefix(projectRoot);
  const translated: string[] = [];
  for (const raw of paths) {
    const p = normalizePathspec(raw);
    if (prefix) {
      // SEGMENT boundary, not raw string prefix: `packages/webui` (the
      // project directory itself, no trailing separator) must still match
      // `packages/webui/` — a plain startsWith(prefix) rejected it as
      // "outside project root".
      const dir = prefix.slice(0, -1);
      if (p !== dir && !p.startsWith(prefix)) {
        return { safe: [], originals: [], error: `Path outside project root: ${raw}` };
      }
    }
    // Slicing the exact directory yields '' — stage the whole project.
    translated.push(prefix ? p.slice(prefix.length) || '.' : p);
  }
  const validation = validateAndFilterPaths(projectRoot, translated);
  if (validation.error) return { safe: [], originals: [], error: validation.error };
  return { safe: validation.safe, originals: paths };
}

export async function handleGitStage(
  ws: WebSocket,
  projectRoot: string,
  paths: string[],
): Promise<void> {
  const cwd = projectRoot || undefined;
  const { safe, originals, error } = await translateRepoPathspecs(projectRoot, paths);
  if (error) {
    send(ws, { type: 'git.action_result', payload: { action: 'stage', ok: false, error } });
    return;
  }

  // Intentional empty array = "stage all" (ChangesPanel sends []). The
  // explicit `.` pathspec matters in a subdirectory project: since Git 2.0,
  // bare `git add -A` stages the ENTIRE repository from any cwd — escaping
  // the opened project. `.` limits the sweep to the execution cwd.
  const args = safe.length === 0 ? ['add', '-A', '--', '.'] : ['add', '--', ...safe];
  const res = await execGit(cwd, args, { literalPathspecs: true });
  if (!res.ok) {
    send(ws, {
      type: 'git.action_result',
      payload: { action: 'stage', ok: false, error: res.stderr || res.error || 'git add failed' },
    });
    return;
  }

  send(ws, { type: 'git.action_result', payload: { action: 'stage', ok: true, paths: originals } });
  await Promise.all([handleGitChanges(ws, projectRoot), handleGitInfo(ws, projectRoot)]);
}

export async function handleGitUnstage(
  ws: WebSocket,
  projectRoot: string,
  paths: string[],
): Promise<void> {
  const cwd = projectRoot || undefined;
  const { safe, originals, error } = await translateRepoPathspecs(projectRoot, paths);
  if (error) {
    send(ws, { type: 'git.action_result', payload: { action: 'unstage', ok: false, error } });
    return;
  }

  // `.` keeps the no-path unstage contained to the execution cwd (same
  // subdirectory rationale as the stage-all pathspec above).
  const args =
    safe.length === 0 ? ['restore', '--staged', '--', '.'] : ['restore', '--staged', '--', ...safe];
  const res = await execGit(cwd, args, { literalPathspecs: true });
  if (!res.ok) {
    send(ws, {
      type: 'git.action_result',
      payload: {
        action: 'unstage',
        ok: false,
        error: res.stderr || res.error || 'git unstage failed',
      },
    });
    return;
  }

  send(ws, {
    type: 'git.action_result',
    payload: { action: 'unstage', ok: true, paths: originals },
  });
  await Promise.all([handleGitChanges(ws, projectRoot), handleGitInfo(ws, projectRoot)]);
}

export async function handleGitDiscard(
  ws: WebSocket,
  projectRoot: string,
  paths: string[],
): Promise<void> {
  const cwd = projectRoot || undefined;
  if (!paths || paths.length === 0) {
    send(ws, {
      type: 'git.action_result',
      payload: { action: 'discard', ok: false, error: 'Explicit path required for discard' },
    });
    return;
  }
  const { safe, originals, error } = await translateRepoPathspecs(projectRoot, paths);
  if (error) {
    send(ws, { type: 'git.action_result', payload: { action: 'discard', ok: false, error } });
    return;
  }

  // Restore modified/deleted tracked files, then clean untracked ones.
  // Results are checked: reporting ok:true while the repo is locked (or a
  // pathspec is invalid) leaves the UI claiming a discard that never
  // happened. "did not match" is EXPECTED in both directions — restore
  // says it for an untracked path (clean handles those), clean says it for
  // a tracked-only pathspec.
  // Restore runs PER PATH, not batched: with a mixed batch (one tracked +
  // one untracked pathspec) a single `git restore` invocation fails
  // wholesale on the untracked name and the TRACKED sibling never gets
  // restored — while the handler still reported ok:true. Per-path calls
  // make each file's outcome independent. Discard is an explicit user
  // action on a small path set, so the extra invocations are fine.
  const benign = /not removing|no such file or directory|did not match/i;
  for (const p of safe) {
    const r = await execGit(cwd, ['restore', '--', p], { literalPathspecs: true });
    if (!r.ok && !benign.test(r.stderr)) {
      send(ws, {
        type: 'git.action_result',
        payload: {
          action: 'discard',
          ok: false,
          error: `${p}: ${r.stderr || r.error || 'git restore failed'}`,
        },
      });
      return;
    }
  }
  const cleanRes = await execGit(cwd, ['clean', '-fd', '--', ...safe], { literalPathspecs: true });
  if (!cleanRes.ok && !benign.test(cleanRes.stderr)) {
    send(ws, {
      type: 'git.action_result',
      payload: {
        action: 'discard',
        ok: false,
        error: cleanRes.stderr || cleanRes.error || 'git clean failed',
      },
    });
    return;
  }

  send(ws, {
    type: 'git.action_result',
    payload: { action: 'discard', ok: true, paths: originals },
  });
  await Promise.all([handleGitChanges(ws, projectRoot), handleGitInfo(ws, projectRoot)]);
}

export async function handleGitCommit(
  ws: WebSocket,
  projectRoot: string,
  message: string,
): Promise<void> {
  const cwd = projectRoot || undefined;
  const trimmed = message?.trim();
  if (!trimmed) {
    send(ws, {
      type: 'git.action_result',
      payload: { action: 'commit', ok: false, error: 'Commit message cannot be empty' },
    });
    return;
  }

  const res = await execGit(cwd, ['commit', '-m', trimmed, '--', '.']);
  if (!res.ok) {
    send(ws, {
      type: 'git.action_result',
      payload: {
        action: 'commit',
        ok: false,
        error: res.stderr || res.error || 'git commit failed',
      },
    });
    return;
  }

  send(ws, {
    type: 'git.action_result',
    payload: { action: 'commit', ok: true, message: trimmed },
  });
  await Promise.all([handleGitChanges(ws, projectRoot), handleGitInfo(ws, projectRoot)]);
}
