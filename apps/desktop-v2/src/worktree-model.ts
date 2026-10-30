import { entries, record } from './engine-values';

export interface WorktreeView {
  handleId: string;
  ownerLabel: string;
  dir: string;
  branch: string;
  baseBranch: string;
  status: string;
  insertions: number;
  deletions: number;
  files: number;
  conflictFiles: string[];
  lastError: string;
}

export interface WorktreeOrphan {
  kind: 'worktree' | 'branch';
  dir: string;
  branch: string;
}

const text = (value: unknown) => (typeof value === 'string' ? value : '');
const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/** Worktrees the engine is tracking for runs in this project (`worktree.state`). */
export function worktreeViews(payload: unknown): { baseBranch: string; worktrees: WorktreeView[] } {
  const state = record(payload);
  return {
    baseBranch: text(state['baseBranch']),
    worktrees: entries(state['worktrees']).map((row) => ({
      handleId: text(row['handleId']),
      ownerLabel: text(row['ownerLabel']) || text(row['ownerId']) || 'unknown owner',
      dir: text(row['dir']),
      branch: text(row['branch']),
      baseBranch: text(row['baseBranch']),
      status: text(row['status']) || 'unknown',
      insertions: count(row['insertions']),
      deletions: count(row['deletions']),
      files: count(row['files']),
      conflictFiles: Array.isArray(row['conflictFiles']) ? row['conflictFiles'].map(String) : [],
      lastError: text(row['lastError']),
    })),
  };
}

/** Managed checkouts and branches no live run owns (`worktree.orphans`). */
export function worktreeOrphans(payload: unknown): {
  orphans: WorktreeOrphan[];
  canClean: boolean;
  reason: string;
} {
  const state = record(payload);
  return {
    orphans: entries(state['orphans']).map((row) => ({
      kind: row['kind'] === 'branch' ? 'branch' : 'worktree',
      dir: text(row['dir']),
      branch: text(row['branch']),
    })),
    canClean: state['canClean'] === true,
    reason: text(state['reason']),
  };
}

/** One line for a cleanup or removal result (`worktree.cleanup_result`). */
export function cleanupOutcome(payload: unknown): string {
  const result = record(payload);
  const removed = count(result['removed']);
  return result['ok'] === true
    ? `Removed ${removed} ${removed === 1 ? 'item' : 'items'}.`
    : `Nothing was removed: ${text(result['reason']) || 'the engine refused the request'}.`;
}

/** One line for a merge result (`worktree.merge_result`), naming conflicts when reported. */
export function mergeOutcome(payload: unknown): string {
  const result = record(payload);
  const branch = text(result['branch']);
  if (result['ok'] === true) return `Merged ${branch}.`;
  const conflicts = Array.isArray(result['conflictFiles'])
    ? result['conflictFiles'].map(String)
    : [];
  if (result['conflict'] === true || conflicts.length)
    return `${branch} was not merged: conflicts in ${conflicts.length ? conflicts.join(', ') : 'the checkout'}.`;
  return `${branch} was not merged: ${text(result['reason']) || 'the engine refused the request'}.`;
}

/** The changes summary for one checkout (`worktree.diff_result`), or null when unavailable. */
export function diffSummary(payload: unknown): {
  dir: string;
  summary: {
    files: { path: string; insertions: number; deletions: number }[];
    insertions: number;
    deletions: number;
    commits: number;
  } | null;
} {
  const result = record(payload);
  const raw = result['summary'];
  if (!raw || typeof raw !== 'object') return { dir: text(result['dir']), summary: null };
  const summary = record(raw);
  return {
    dir: text(result['dir']),
    summary: {
      files: entries(summary['files']).map((file) => ({
        path: text(file['path']),
        insertions: count(file['insertions']),
        deletions: count(file['deletions']),
      })),
      insertions: count(summary['insertions']),
      deletions: count(summary['deletions']),
      commits: count(summary['commits']),
    },
  };
}
