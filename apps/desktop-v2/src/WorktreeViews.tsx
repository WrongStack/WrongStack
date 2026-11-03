import type { WorktreeView } from './worktree-model';

/** How the live worktrees are drawn: the list with actions, swim lanes, or a branch graph. */
export type WorktreeLayout = 'list' | 'lanes' | 'graph';

const LANE_COLORS = [
  'var(--accent)',
  'hsl(var(--ws-info))',
  'hsl(var(--ws-success))',
  'hsl(var(--ws-warning))',
  'var(--danger)',
  'var(--muted)',
];
const STATUS_WORDS: Record<string, string> = {
  allocating: 'Allocating',
  active: 'Active',
  committing: 'Committing',
  merging: 'Merging',
  merged: 'Merged',
  'needs-review': 'Conflict',
  failed: 'Failed',
};
const EDGE: Record<string, { dash: string; opacity: number }> = {
  allocating: { dash: '4 4', opacity: 0.4 },
  active: { dash: '4 4', opacity: 0.6 },
  committing: { dash: '4 4', opacity: 0.8 },
  merging: { dash: '0', opacity: 0.9 },
  merged: { dash: '0', opacity: 1 },
  'needs-review': { dash: '2 3', opacity: 0.9 },
  failed: { dash: '2 3', opacity: 0.6 },
};
const short = (branch: string) => branch.replace(/^wstack\/ap\//, '');
const inOrder = (worktrees: readonly WorktreeView[]) =>
  [...worktrees].sort((a, b) => a.allocatedAt - b.allocatedAt);
const troubled = (status: string) => status === 'needs-review' || status === 'failed';

export function WorktreeLayoutSwitch({
  value,
  onChange,
}: {
  value: WorktreeLayout;
  onChange: (layout: WorktreeLayout) => void;
}) {
  return (
    <fieldset className="worktree-layouts" aria-label="Worktree layout">
      {(
        [
          ['list', 'List'],
          ['lanes', 'Lanes'],
          ['graph', 'Graph'],
        ] as const
      ).map(([layout, label]) => (
        <button
          type="button"
          key={layout}
          aria-pressed={value === layout}
          onClick={() => onChange(layout)}
        >
          {label}
        </button>
      ))}
    </fieldset>
  );
}

/**
 * One lane per worktree in the order they were handed out, as the WebUI's lanes: status, branch,
 * owner, the live diff stat with a magnitude bar, and the newest lifecycle note.
 */
export function WorktreeLanes({
  worktrees,
  baseBranch,
}: {
  worktrees: readonly WorktreeView[];
  baseBranch: string;
}) {
  return (
    <section className="worktree-lanes" aria-label="Worktree lanes">
      <p className="field-help">
        Base <code>{baseBranch || 'HEAD'}</code> · {worktrees.length} isolated
      </p>
      {inOrder(worktrees).map((worktree) => (
        <article
          key={worktree.handleId || worktree.branch}
          className={`worktree-lane worktree-${worktree.status}`}
        >
          <span className="worktree-lane-dot" aria-hidden />
          <code>{short(worktree.branch)}</code>
          <span className="worktree-lane-owner">⟵ {worktree.ownerLabel}</span>
          {worktree.status === 'needs-review' ? (
            <strong className="worktree-lane-conflict">conflict</strong>
          ) : (
            <span className="worktree-lane-stat">
              <span>+{worktree.insertions}</span> <span>−{worktree.deletions}</span>{' '}
              {worktree.files}f
            </span>
          )}
          <span className="worktree-lane-bar" aria-hidden>
            <span
              style={{ width: `${Math.min(100, worktree.insertions + worktree.deletions)}%` }}
            />
          </span>
          <span className="worktree-lane-status">
            {STATUS_WORDS[worktree.status] ?? worktree.status}
          </span>
          {worktree.latest && <small>{worktree.latest}</small>}
        </article>
      ))}
    </section>
  );
}

/**
 * The base branch as a trunk with each worktree forking off it, and folding back once merged,
 * as the WebUI's worktree graph draws it from the same snapshot.
 */
export function WorktreeGraph({
  worktrees,
  baseBranch,
}: {
  worktrees: readonly WorktreeView[];
  baseBranch: string;
}) {
  const nodes = inOrder(worktrees).map((worktree, index) => ({
    worktree,
    color: LANE_COLORS[index % LANE_COLORS.length] as string,
    y: 60 + index * 48,
  }));
  const height = Math.max(120, 60 + nodes.length * 48 + 20);
  const trunk = 40;
  const branch = 220;
  const label = `Worktrees branching from ${baseBranch || 'HEAD'}`;
  return (
    <div className="worktree-graph">
      <svg width="100%" height={height} viewBox={`0 0 600 ${height}`} role="img" aria-label={label}>
        <title>{label}</title>
        <line
          x1={trunk}
          y1={20}
          x2={trunk}
          y2={height - 10}
          stroke="var(--accent)"
          strokeWidth={3}
        />
        <text x={trunk - 4} y={14} className="worktree-graph-muted">
          {baseBranch || 'HEAD'}
        </text>
        <circle cx={trunk} cy={20} r={5} fill="var(--accent)" />
        {nodes.map(({ worktree, color, y }) => {
          const edge = EDGE[worktree.status] ?? { dash: '4 4', opacity: 0.6 };
          const merged = worktree.status === 'merged';
          return (
            <g key={worktree.handleId || worktree.branch}>
              <path
                d={`M ${trunk} ${y - 24} C ${trunk + 60} ${y - 24}, ${branch - 60} ${y}, ${branch} ${y}`}
                fill="none"
                stroke={color}
                strokeWidth={2}
                strokeDasharray={edge.dash}
                opacity={edge.opacity}
              />
              {merged && (
                <path
                  d={`M ${branch} ${y} C ${branch - 60} ${y + 20}, ${trunk + 60} ${y + 24}, ${trunk} ${y + 24}`}
                  fill="none"
                  stroke="hsl(var(--ws-success))"
                  strokeWidth={2}
                  opacity={0.9}
                />
              )}
              <circle
                cx={branch}
                cy={y}
                r={5}
                fill={troubled(worktree.status) ? 'var(--danger)' : color}
              />
              <text x={branch + 12} y={y - 6} className="worktree-graph-branch">
                {short(worktree.branch)}
              </text>
              <text x={branch + 12} y={y + 10} className="worktree-graph-muted">
                {troubled(worktree.status)
                  ? `⚠ ${STATUS_WORDS[worktree.status]}`
                  : merged
                    ? `merged into ${baseBranch || 'HEAD'}`
                    : `+${worktree.insertions}/−${worktree.deletions} · ${worktree.ownerLabel}`}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
