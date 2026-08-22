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
    send(ws, { type: 'git.info', payload: { branch: '', added: 0, deleted: 0, untracked: 0, ahead: 0, behind: 0 } });
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
    const [statusRaw, unstagedNumstat, stagedNumstat] = await Promise.all([
      git(['status', '--porcelain', '-z']),
      git(['diff', '--numstat', '-z']),
      git(['diff', '--cached', '--numstat', '-z']),
    ]);

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
      else if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) status = 'U';
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

    send(ws, { type: 'git.changes', payload: { files } });
  } catch (err) {
    send(ws, {
      type: 'git.changes',
      payload: { files: [], error: err instanceof Error ? err.message : String(err) },
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

  if (!path || path.includes('\0') || path.includes('..') || nodePath.isAbsolute(path)) {
    reply({ oldText: '', newText: '', error: 'invalid path' });
    return;
  }

  try {
    const git = makeGit(cwd);
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');

    // HEAD version. `git show` writes nothing for a path absent at HEAD.
    const oldText = await git(['show', `HEAD:${path}`]);

    // Working-tree version (absent → deleted file → empty).
    let newText = '';
    try {
      const abs = cwd ? join(cwd, path) : path;
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
