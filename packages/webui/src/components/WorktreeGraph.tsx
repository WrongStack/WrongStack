import { expectDefined } from '@wrongstack/core/utils/expect-defined';
import { useAppTranslation } from '@/i18n';
import type { WorktreeHandleView } from '@/types';

const TOKEN_COLOR = {
  primary: 'hsl(var(--primary))',
  info: 'hsl(var(--info))',
  success: 'hsl(var(--success))',
  warning: 'hsl(var(--warning))',
  destructive: 'hsl(var(--destructive))',
  muted: 'hsl(var(--muted-foreground))',
  foreground: 'hsl(var(--foreground))',
} as const;

const LANE_COLORS = [
  TOKEN_COLOR.primary,
  TOKEN_COLOR.info,
  TOKEN_COLOR.success,
  TOKEN_COLOR.warning,
  TOKEN_COLOR.destructive,
  TOKEN_COLOR.muted,
];

const shortBranch = (b: string) => b.replace(/^wstack\/ap\//, '');

interface GraphNode {
  handle: WorktreeHandleView;
  color: string;
  y: number;
}

/**
 * Derive a simple trunk+branches graph from the flat snapshot: the base branch
 * is the trunk; each worktree is a branch off it. Pure — no extra backend data.
 */
export function deriveWorktreeGraph(worktrees: WorktreeHandleView[]): GraphNode[] {
  return [...worktrees]
    .sort((a, b) => a.allocatedAt - b.allocatedAt)
    .map((handle, i) => ({ handle, color: LANE_COLORS[i % LANE_COLORS.length], y: 60 + i * 48 }));
}

const EDGE_STATE: Record<string, { dash: string; opacity: number }> = {
  allocating: { dash: '4 4', opacity: 0.4 },
  active: { dash: '4 4', opacity: 0.6 },
  committing: { dash: '4 4', opacity: 0.8 },
  merging: { dash: '0', opacity: 0.9 },
  merged: { dash: '0', opacity: 1 },
  'needs-review': { dash: '2 3', opacity: 0.9 },
  failed: { dash: '2 3', opacity: 0.6 },
};

/**
 * WorktreeGraph — live DAG: the base trunk with one branch per worktree
 * forking off and (when merged) folding back in. SVG + Tailwind transitions.
 */
export function WorktreeGraph({
  worktrees,
  baseBranch,
}: {
  worktrees: WorktreeHandleView[];
  baseBranch: string;
}): React.ReactElement {
  const { t } = useAppTranslation();
  const nodes = deriveWorktreeGraph(worktrees);
  const height = Math.max(120, 60 + nodes.length * 48 + 20);
  const trunkX = 40;
  const branchX = 220;

  return (
    <div className="overflow-x-auto rounded-lg border border-border/70 bg-card/70 p-3">
      <svg
        width="100%"
        height={height}
        viewBox={`0 0 600 ${height}`}
        className="min-w-[420px]"
        role="img"
        aria-label={t('activity:worktree.graphAria', { base: baseBranch || 'HEAD' })}
      >
        <title>{t('activity:worktree.graphAria', { base: baseBranch || 'HEAD' })}</title>
        {/* trunk */}
        <line
          x1={trunkX}
          y1={20}
          x2={trunkX}
          y2={height - 10}
          stroke={TOKEN_COLOR.primary}
          strokeWidth={3}
        />
        <text x={trunkX - 4} y={14} fontSize={11} fill={TOKEN_COLOR.muted}>
          {baseBranch || 'HEAD'}
        </text>
        <circle cx={trunkX} cy={20} r={5} fill={TOKEN_COLOR.primary} />

        {nodes.map((n) => {
          const e = EDGE_STATE[n.handle.status] ?? expectDefined(EDGE_STATE.active);
          const merged = n.handle.status === 'merged';
          const conflict = n.handle.status === 'needs-review' || n.handle.status === 'failed';
          return (
            <g key={n.handle.handleId} className="transition-all duration-500">
              {/* fork out from trunk */}
              <path
                d={`M ${trunkX} ${n.y - 24} C ${trunkX + 60} ${n.y - 24}, ${branchX - 60} ${n.y}, ${branchX} ${n.y}`}
                fill="none"
                stroke={n.color}
                strokeWidth={2}
                strokeDasharray={e.dash}
                opacity={e.opacity}
              />
              {/* merge back into trunk (only when merged) */}
              {merged ? (
                <path
                  d={`M ${branchX} ${n.y} C ${branchX - 60} ${n.y + 20}, ${trunkX + 60} ${n.y + 24}, ${trunkX} ${n.y + 24}`}
                  fill="none"
                  stroke={TOKEN_COLOR.success}
                  strokeWidth={2}
                  opacity={0.9}
                />
              ) : null}
              <circle
                cx={branchX}
                cy={n.y}
                r={5}
                fill={conflict ? TOKEN_COLOR.destructive : n.color}
              />
              <text
                x={branchX + 12}
                y={n.y - 6}
                fontSize={12}
                fill={TOKEN_COLOR.foreground}
                fontFamily="monospace"
              >
                {shortBranch(n.handle.branch)}
              </text>
              <text x={branchX + 12} y={n.y + 10} fontSize={10} fill={TOKEN_COLOR.muted}>
                {conflict
                  ? `⚠ ${n.handle.status}`
                  : merged
                    ? t('activity:worktree.mergedLabel', { base: baseBranch })
                    : `+${n.handle.insertions}/-${n.handle.deletions} · ${n.handle.ownerLabel}`}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
