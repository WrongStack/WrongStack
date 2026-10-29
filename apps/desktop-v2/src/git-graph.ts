export interface GraphCommit {
  hash: string;
  parents: readonly string[];
}

/** How one history row is drawn: its lane and the lines entering and leaving it. */
export interface GraphRow {
  lane: number;
  /** Lanes that pass by this row untouched. */
  through: number[];
  /** A child above leads into this commit. */
  fromAbove: boolean;
  /** The first parent continues down this commit's lane. */
  toBelow: boolean;
  /** Lanes that other parents (a merge) continue down. */
  merges: number[];
  /** Lanes from above that also end at this commit (branches forking from it). */
  converges: number[];
  /** Lanes in use on this row, for the column width. */
  width: number;
}

/**
 * Lanes for commits listed newest first, as `git log` returns them. Each lane waits for one
 * hash; a commit takes the lane waiting for it (or a free one) and hands it to its first
 * parent. Parents outside the loaded commits simply continue to the bottom.
 */
export function commitGraph(commits: readonly GraphCommit[]): GraphRow[] {
  const lanes: (string | null)[] = [];
  const free = () => {
    const index = lanes.indexOf(null);
    return index < 0 ? lanes.length : index;
  };
  return commits.map((commit) => {
    const waiting = lanes.flatMap((hash, index) => (hash === commit.hash ? [index] : []));
    const lane = waiting[0] ?? free();
    const converges = waiting.slice(1);
    const through = lanes.flatMap((hash, index) =>
      hash !== null && hash !== commit.hash ? [index] : [],
    );
    for (const index of converges) lanes[index] = null;
    const [first, ...others] = commit.parents;
    lanes[lane] = first ?? null;
    const merges: number[] = [];
    for (const parent of others) {
      const existing = lanes.indexOf(parent);
      if (existing >= 0) merges.push(existing);
      else {
        const index = free();
        lanes[index] = parent;
        merges.push(index);
      }
    }
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    return {
      lane,
      through,
      fromAbove: waiting.length > 0,
      toBelow: first !== undefined,
      merges,
      converges,
      width: Math.max(
        lane + 1,
        lanes.length,
        ...through.map((index) => index + 1),
        ...converges.map((i) => i + 1),
      ),
    };
  });
}
