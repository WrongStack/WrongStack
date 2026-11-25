import type { WSServerMessage } from '@/types';

/** Wire types, graph geometry, and formatters for the repository history view. */

export type HistoryPayload = Extract<WSServerMessage, { type: 'git.history' }>['payload'];
export type HistoryCommit = HistoryPayload['commits'][number];
export type HistoryRef = HistoryPayload['refs'][number];
export type DetailPayload = Extract<WSServerMessage, { type: 'git.commit_detail' }>['payload'];
export type FileDiffPayload = Extract<WSServerMessage, { type: 'git.commit_file_diff' }>['payload'];
export const ROW_HEIGHT = 48;
export const LANE_GAP = 15;

export const COMMIT_DETAIL_PANEL_CLASS =
  'ws-commit-detail flex h-[44%] min-h-[230px] max-h-[460px] shrink-0 flex-col overflow-hidden border-t border-border/70 bg-card/35 shadow-[0_-16px_40px_-34px_hsl(var(--primary)/0.8)] sm:h-[36%] sm:max-h-[390px] sm:flex-row';

export interface GraphLayout {
  lanes: number[];
  laneCount: number;
  edges: Array<{ fromRow: number; fromLane: number; toRow: number; toLane: number }>;
}

/** Stable topology layout: first parent continues a lane, merge parents fan out. */
export function layoutCommitGraph(commits: HistoryCommit[]): GraphLayout {
  const slots: Array<string | undefined> = [];
  const lanes: number[] = [];
  const rowByHash = new Map(commits.map((commit, index) => [commit.hash, index]));
  for (const commit of commits) {
    let lane = slots.indexOf(commit.hash);
    if (lane < 0) {
      lane = slots.indexOf(undefined);
      if (lane < 0) lane = slots.length;
    }
    lanes.push(lane);
    slots[lane] = commit.parents[0];
    for (const parent of commit.parents.slice(1)) {
      if (slots.includes(parent)) continue;
      let parentLane = slots.indexOf(undefined);
      if (parentLane < 0) parentLane = slots.length;
      slots[parentLane] = parent;
    }
  }
  const laneByHash = new Map(commits.map((commit, index) => [commit.hash, lanes[index] ?? 0]));
  const edges = commits.flatMap((commit, fromRow) =>
    commit.parents.flatMap((parent) => {
      const toRow = rowByHash.get(parent);
      if (toRow === undefined) return [];
      return [
        { fromRow, fromLane: lanes[fromRow] ?? 0, toRow, toLane: laneByHash.get(parent) ?? 0 },
      ];
    }),
  );
  return { lanes, laneCount: Math.max(1, ...lanes.map((lane) => lane + 1)), edges };
}

export function shortHash(hash: string): string {
  return hash.slice(0, 7);
}

export function relativeTime(value: string): string {
  const elapsed = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(elapsed)) return value;
  const minutes = Math.max(0, Math.round(elapsed / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 60) return `${days}d`;
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(
    new Date(value),
  );
}

export function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('');
}
