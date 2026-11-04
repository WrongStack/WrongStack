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
  /** When the engine handed the worktree out; lanes and the graph keep this order. */
  allocatedAt: number;
  /** The newest lifecycle note (`kind: text`), or empty. */
  latest: string;
}

export interface WorktreeOrphan {
  kind: 'worktree' | 'branch';
  dir: string;
  branch: string;
}

const text = (value: unknown) => (typeof value === 'string' ? value : '');
const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

function latestActivity(value: unknown) {
  const last = entries(value).at(-1);
  return last ? [text(last['kind']), text(last['text'])].filter(Boolean).join(': ') : '';
}

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
      allocatedAt: count(row['allocatedAt']),
      latest: latestActivity(row['recentActivity']),
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
/** English wording of the outcome lines; the desktop passes the display-language catalog. */
const OUTCOME_WORDS = {
  removedOne: 'Removed 1 item.',
  removedMany: 'Removed {{number}} items.',
  notRemoved: 'Nothing was removed: {{reason}}.',
  refused: 'the engine refused the request',
  merged: 'Merged {{branch}}.',
  conflicts: '{{branch}} was not merged: conflicts in {{files}}.',
  theCheckout: 'the checkout',
  notMerged: '{{branch}} was not merged: {{reason}}.',
} as const;
export type WorktreeOutcomeWord = keyof typeof OUTCOME_WORDS;
export type WorktreeSay = (
  word: WorktreeOutcomeWord,
  values?: Record<string, string | number>,
) => string;
const english: WorktreeSay = (word, values = {}) =>
  OUTCOME_WORDS[word].replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(values[name] ?? ''));

export function cleanupOutcome(payload: unknown, say: WorktreeSay = english): string {
  const result = record(payload);
  const removed = count(result['removed']);
  if (result['ok'] !== true)
    return say('notRemoved', { reason: text(result['reason']) || say('refused') });
  return removed === 1 ? say('removedOne') : say('removedMany', { number: removed });
}

/** One line for a merge result (`worktree.merge_result`), naming conflicts when reported. */
export function mergeOutcome(payload: unknown, say: WorktreeSay = english): string {
  const result = record(payload);
  const branch = text(result['branch']);
  if (result['ok'] === true) return say('merged', { branch });
  const conflicts = Array.isArray(result['conflictFiles'])
    ? result['conflictFiles'].map(String)
    : [];
  if (result['conflict'] === true || conflicts.length)
    return say('conflicts', {
      branch,
      files: conflicts.length ? conflicts.join(', ') : say('theCheckout'),
    });
  return say('notMerged', { branch, reason: text(result['reason']) || say('refused') });
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
