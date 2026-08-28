/**
 * Custom React Flow edge type for the OfficeMapCanvas.
 *
 * Extracted from OfficeMapCanvas.tsx to keep the main file under the
 * 2000-line hotspot guardrail.
 */
import {
  type Edge,
  EdgeLabelRenderer,
  type EdgeProps,
  type EdgeTypes,
  getBezierPath,
  Position,
} from '@xyflow/react';
import { useOfficeMapStore } from '@/stores';
import { OFFICE_COLOR } from './nodes.js';

type OfficeEdgeData = {
  color?: string;
  animated?: boolean;
  intensity?: number;
  label?: string;
};

export const edgeTypes: EdgeTypes = {
  wire: ({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    data,
    selected,
  }: EdgeProps<Edge<OfficeEdgeData>>) => {
    const color = data?.color || OFFICE_COLOR.primary;
    const animateEdges = useOfficeMapStore((s) => s.animateEdges);
    const isAnimated = data?.animated && animateEdges;
    const intensity = isAnimated ? Math.max(0.15, data?.intensity ?? 0.6) : 0;

    const [path, labelX, labelY] = getBezierPath({
      sourceX,
      sourceY,
      sourcePosition: sourcePosition ?? Position.Bottom,
      targetX,
      targetY,
      targetPosition: targetPosition ?? Position.Top,
      curvature: 0.28,
    });

    const dashLen = 5 + intensity * 7;
    const dashGap = 5 + intensity * 4;
    const period = dashLen + dashGap;
    const dur = `${Math.max(0.5, 1.6 - intensity).toFixed(2)}s`;

    return (
      <>
        {/* Base wire — always visible so the topology reads even when idle. */}
        <path
          d={path}
          fill="none"
          stroke={color}
          strokeWidth={selected ? 2.5 : 1.4}
          strokeOpacity={selected ? 0.9 : 0.28}
          className="react-flow__edge-path"
        />
        {/* Flowing dashes when active — direction shows source → target. */}
        {intensity > 0.05 && (
          <path
            d={path}
            fill="none"
            stroke={color}
            strokeWidth={2.2}
            strokeOpacity={0.45 + intensity * 0.5}
            strokeDasharray={`${dashLen} ${dashGap}`}
            strokeLinecap="round"
            style={{ filter: `drop-shadow(0 0 ${2 + intensity * 4}px ${color})` }}
          >
            <animate
              attributeName="stroke-dashoffset"
              from={period}
              to="0"
              dur={dur}
              repeatCount="indefinite"
            />
          </path>
        )}
        {/* Label only on active flow — keeps idle wires uncluttered. */}
        {data?.label && intensity > 0.1 && (
          <EdgeLabelRenderer>
            <div
              style={{
                position: 'absolute',
                transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              }}
              className="pointer-events-none max-w-[220px] truncate whitespace-nowrap rounded-full border border-border/70 bg-card/90 px-1.5 py-0.5 text-[8px] font-medium text-foreground backdrop-blur-sm"
            >
              {data.label}
            </div>
          </EdgeLabelRenderer>
        )}
      </>
    );
  },
};
