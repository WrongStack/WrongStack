import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EventBus } from '@wrongstack/contracts/kernel/events';
import { NOTHING_TO_COMMIT } from './worktree-conflict-resolution-contracts.js';
import type {
  MergeOpts,
  MergeResult,
  RunResult,
  WorktreeHandle,
  WorktreeStatus,
} from './worktree-types.js';
export interface WorktreeConflictResolutionHost {
  projectRoot: string;
  runGit: (args: string[], cwd: string) => Promise<RunResult>;
  hasConflictMarkers(files?: string[]): Promise<boolean>;
  identityArgs(cwd: string): Promise<string[]>;
  setStatus(
    handle: WorktreeHandle,
    status: WorktreeStatus,
    patch?: Partial<WorktreeHandle> | undefined,
  ): void;
  emit<E extends Parameters<EventBus['emit']>[0]>(
    event: E,
    payload: Parameters<EventBus['emit']>[1],
  ): void;
  conflictMarkedFiles(files?: string[], firstOnly?: boolean): Promise<string[]>;
  detectBaseBranch(): Promise<string>;
}

export async function tryResolveConflict(
  host: WorktreeConflictResolutionHost,
  handle: WorktreeHandle,
  conflictFiles: string[],
  opts: MergeOpts,
): Promise<MergeResult | null> {
  let resolved = false;
  try {
    resolved = opts.resolve ? await opts.resolve({ conflictFiles, cwd: host.projectRoot }) : false;
  } catch {
    resolved = false;
  }
  if (!resolved) return null;

  // Stage the resolver's edits to the conflicted files — only those: the
  // squash already staged everything else, and `add -A` swept up whatever
  // else sat in the tree (the managed worktrees under .wrongstack/ went in
  // as embedded-repo gitlinks). Then refuse to commit if any conflict
  // marker survived (a half-resolved file is worse than a clean abort).
  await host.runGit(['add', '--', ...conflictFiles], host.projectRoot);
  if (await host.hasConflictMarkers(conflictFiles)) return null;

  const idArgs = await host.identityArgs(host.projectRoot);
  const msg = opts.message ?? `merge ${handle.branch} (squash, conflict resolved)`;
  const commit = await host.runGit([...idArgs, 'commit', '-m', msg], host.projectRoot);
  if (commit.code !== 0 && !NOTHING_TO_COMMIT.test(commit.stdout + commit.stderr)) {
    return null;
  }

  handle.conflictFiles = conflictFiles;
  host.setStatus(handle, 'merged');
  host.emit('worktree.merged', {
    handleId: handle.id,
    ownerId: handle.ownerId,
    branch: handle.branch,
    baseBranch: handle.baseBranch,
    squash: true,
  });
  return { ok: true, resolved: true, conflictFiles };
}

export async function hasConflictMarkers(
  host: WorktreeConflictResolutionHost,
  files?: string[],
): Promise<boolean> {
  return (await host.conflictMarkedFiles(files, true)).length > 0;
}

export async function conflictMarkedFiles(
  host: WorktreeConflictResolutionHost,
  files?: string[],
  firstOnly = false,
): Promise<string[]> {
  // When the caller knows which files conflicted, scan only those — the
  // union with all staged files would false-positive on legitimate
  // `=======` underlines in staged documents (e.g. markdown setext
  // headings) and discard valid resolution work. The staged listing is a
  // fallback for callers that don't supply paths.
  const listed = files ?? [];
  const paths =
    listed.length > 0
      ? listed
      : (await host.runGit(['diff', '--cached', '--name-only', '-z'], host.projectRoot)).stdout
          .split('\0')
          .filter(Boolean);
  // {7,} covers merge.conflictMarkerSize > 7; `\r` is stripped so the `$`
  // anchor (matches only before `\n` in /m) is not defeated by CRLF.
  // See the line-by-line scan below for why we can't just use a
  // single regex here: a bare `=======` line (e.g. a markdown setext
  // heading underline) is not a conflict marker. We require the
  // `=======` middle-divider to be preceded by a `<<<<<<<` or
  // `|||||||` start-marker within the same file.
  const marker = /^(?:<{7,}(?: |$)|={7,}$|>{7,}(?: |$)|\|{7,}(?: |$))/m;
  const startMarker = /^(?:<{7,}(?: |$)|\|{7,}(?: |$))/m;
  const marked: string[] = [];
  for (const rel of paths) {
    try {
      const content = (await readFile(join(host.projectRoot, rel), 'utf8')).replace(/\r/g, '');
      const lines = content.split('\n');
      let seenStart = false;
      for (const line of lines) {
        if (!marker.test(line)) continue;
        // `=======` is the middle divider of a conflict block; only
        // count it if a start-marker appeared on a prior line in
        // the same file. The `<<<<<<<` / `|||||||` arms also flip
        // the start-marker latch on (a half-written conflict still
        // indicates a dirty worktree).
        if (line.startsWith('=====')) {
          if (!seenStart) continue;
        } else if (startMarker.test(line)) {
          seenStart = true;
        }
        marked.push(rel);
        break;
      }
    } catch {
      // Deleted or unreadable — nothing to scan.
    }
    if (firstOnly && marked.length > 0) break;
  }
  return marked;
}

export async function diffSummary(
  host: WorktreeConflictResolutionHost,
  dir: string,
  baseBranch?: string | undefined,
): Promise<{
  files: Array<{ path: string; insertions: number; deletions: number }>;
  insertions: number;
  deletions: number;
  commits: number;
}> {
  const files: Array<{ path: string; insertions: number; deletions: number }> = [];
  let insertions = 0;
  let deletions = 0;
  let commits = 0;
  try {
    // -z: without it core.quotePath C-quotes non-ASCII names (`şema.ts` ->
    // `"\305\237ema.ts"`). A -z rename record leaves the path empty and names
    // the old and new paths in the next two fields.
    const numstat = await host.runGit(['diff', '--numstat', '-z', 'HEAD'], dir);
    const fields = numstat.stdout.split('\0');
    for (let i = 0; i < fields.length; i++) {
      const m = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(fields[i]!);
      if (!m) continue;
      let filePath = m[3]!;
      if (filePath === '') {
        i += 2;
        filePath = fields[i] ?? '';
      }
      if (!filePath) continue;
      const ins = m[1] === '-' ? 0 : Number(m[1]);
      const del = m[2] === '-' ? 0 : Number(m[2]);
      files.push({ path: filePath, insertions: ins, deletions: del });
      insertions += ins;
      deletions += del;
    }
  } catch {
    // best-effort
  }
  try {
    const base = baseBranch ?? (await host.detectBaseBranch());
    const count = await host.runGit(['rev-list', '--count', `${base}..HEAD`], dir);
    commits = Number(count.stdout.trim()) || 0;
  } catch {
    // best-effort
  }
  return { files, insertions, deletions, commits };
}
