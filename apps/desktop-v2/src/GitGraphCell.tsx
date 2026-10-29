import type { GraphRow } from './git-graph';

const LANE = 12,
  NODE_Y = 24,
  /** Wider graphs are clipped; the lanes past it stay listed in the commit details. */
  MAX_LANES = 10;
const x = (lane: number) => Math.min(lane, MAX_LANES - 1) * LANE + LANE / 2;

/** One row of the history graph, stretched over the full height of its list row. */
export function GitGraphCell({ row, merge }: { row: GraphRow; merge: boolean }) {
  const width = Math.min(row.width, MAX_LANES) * LANE;
  const node = x(row.lane);
  return (
    <span className="git-graph-cell" style={{ width }} aria-hidden="true">
      <svg width={width} height="100%" aria-hidden="true">
        {row.through.map((lane) => (
          <line
            key={`t${lane}`}
            className={`git-lane-${lane % 6}`}
            x1={x(lane)}
            y1={0}
            x2={x(lane)}
            y2="100%"
          />
        ))}
        {row.converges.map((lane) => (
          <line
            key={`c${lane}`}
            className={`git-lane-${lane % 6}`}
            x1={x(lane)}
            y1={0}
            x2={node}
            y2={NODE_Y}
          />
        ))}
        {row.fromAbove && (
          <line className={`git-lane-${row.lane % 6}`} x1={node} y1={0} x2={node} y2={NODE_Y} />
        )}
        {row.toBelow && (
          <line className={`git-lane-${row.lane % 6}`} x1={node} y1={NODE_Y} x2={node} y2="100%" />
        )}
        {row.merges.map((lane) => (
          <line
            key={`m${lane}`}
            className={`git-lane-${lane % 6}`}
            x1={node}
            y1={NODE_Y}
            x2={x(lane)}
            y2="100%"
          />
        ))}
        <circle
          className={`git-graph-node git-lane-${row.lane % 6} ${merge ? 'git-graph-merge' : ''}`}
          cx={node}
          cy={NODE_Y}
          r={merge ? 5 : 4}
        />
      </svg>
    </span>
  );
}
