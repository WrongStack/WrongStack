/**
 * Character-cell rendering of the shared worktree timeline (see
 * `@wrongstack/contracts/types/worktree-timeline`) for the TUI monitor. Pure: maps
 * time onto `width` columns and returns colourable runs, so the Ink component
 * only picks colours.
 */
import type {
  WorktreeLane,
  WorktreeLanePhase,
  WorktreeTimeline,
} from '@wrongstack/contracts/types/worktree-timeline';

export const WORKTREE_PHASE_CHAR: Record<WorktreeLanePhase, string> = {
  working: '▓',
  queued: '▒',
  merging: '█',
  kept: '░',
};

export interface WorktreeBarRun {
  text: string;
  /** null = no segment covers these columns. */
  phase: WorktreeLanePhase | null;
}

function column(at: number, start: number, span: number, width: number): number {
  return Math.min(width - 1, Math.max(0, Math.floor(((at - start) / span) * width)));
}

function compress<T>(cells: readonly T[], key: (cell: T) => string, char: (cell: T) => string) {
  const runs: Array<{ cell: T; text: string }> = [];
  for (const cell of cells) {
    const last = runs.at(-1);
    if (last && key(last.cell) === key(cell)) last.text += char(cell);
    else runs.push({ cell, text: char(cell) });
  }
  return runs;
}

/**
 * One lane as runs over `width` columns of `[start, end]`. Each column takes
 * the phase covering most of its time slice; a segment too short to win any
 * column still gets the column it starts in, so an instant merge stays visible.
 * That column is taken from its holder when the holder keeps another column
 * (or is itself an instant step) — an instant merge usually lands inside the
 * column the preceding working slice already owns, and only taking EMPTY
 * columns hid it.
 */
export function worktreeBarRuns(
  lane: WorktreeLane,
  start: number,
  end: number,
  width: number,
): WorktreeBarRun[] {
  if (width <= 0) return [];
  const span = Math.max(1, end - start);
  const cells: Array<WorktreeLanePhase | null> = Array.from({ length: width }, () => null);
  const best: number[] = Array.from({ length: width }, () => 0);
  const owner: number[] = Array.from({ length: width }, () => -1);
  const owned: number[] = [];
  const instant = new Set<number>();
  const take = (i: number, index: number, phase: WorktreeLanePhase): void => {
    const previous = owner[i]!;
    if (previous >= 0) owned[previous] = (owned[previous] ?? 1) - 1;
    owner[i] = index;
    owned[index] = (owned[index] ?? 0) + 1;
    cells[i] = phase;
  };
  lane.segments.forEach((seg, index) => {
    const segEnd = seg.end ?? end;
    const first = column(seg.start, start, span, width);
    const last = column(Math.max(seg.start, segEnd - 1), start, span, width);
    let won = false;
    for (let i = first; i <= last; i++) {
      const c0 = start + (i * span) / width;
      const c1 = start + ((i + 1) * span) / width;
      const overlap = Math.min(c1, segEnd) - Math.max(c0, seg.start);
      if (overlap > best[i]!) {
        best[i] = overlap;
        take(i, index, seg.phase);
        won = true;
      }
    }
    if (won) return;
    const holder = owner[first]!;
    if (holder < 0 || instant.has(holder) || (owned[holder] ?? 0) > 1) {
      take(first, index, seg.phase);
      instant.add(index);
    }
  });
  return compress(
    cells,
    (p) => p ?? '',
    (p) => (p ? WORKTREE_PHASE_CHAR[p] : ' '),
  ).map((r) => ({ text: r.text, phase: r.cell }));
}

/** The base branch row: `─` with `●` where a squash commit landed. */
export function worktreeBaseRuns(
  timeline: Pick<WorktreeTimeline, 'baseCommits' | 'start' | 'end'>,
  width: number,
): Array<{ text: string; commit: boolean }> {
  if (width <= 0) return [];
  const span = Math.max(1, timeline.end - timeline.start);
  const commits = new Set(
    timeline.baseCommits.map((c) => column(c.at, timeline.start, span, width)),
  );
  const cells = Array.from({ length: width }, (_, i) => commits.has(i));
  return compress(
    cells,
    (c) => String(c),
    (c) => (c ? '●' : '─'),
  ).map((r) => ({ text: r.text, commit: r.cell }));
}

/** Tick labels placed at their columns; a label that would overlap the previous one is dropped. */
export function worktreeAxisLine(
  ticks: readonly number[],
  start: number,
  end: number,
  width: number,
  format: (at: number) => string,
): string {
  if (width <= 0) return '';
  const span = Math.max(1, end - start);
  const line = Array.from({ length: width }, () => ' ');
  let nextFree = 0;
  for (const at of ticks) {
    const label = format(at);
    const center = Math.round(((at - start) / span) * (width - 1));
    const from = Math.max(0, Math.min(width - label.length, center - Math.floor(label.length / 2)));
    if (from < nextFree || label.length > width) continue;
    for (let i = 0; i < label.length; i++) line[from + i] = label[i]!;
    nextFree = from + label.length + 1;
  }
  return line.join('');
}
