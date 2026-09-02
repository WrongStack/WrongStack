/**
 * Single-series time-bucketed column chart. Dependency-free SVG.
 *
 * One chart = one measure = one hue. Two measures never share an axis — render
 * two charts instead. Because each chart carries a single series, there is no
 * legend (the section title names the measure) and no categorical palette to
 * validate; the hue is a semantic token passed in by the caller.
 *
 * Mark rules applied here: thin columns with a 2px surface gap, 4px rounded
 * data-ends anchored to the baseline, recessive gridlines, sparse time ticks,
 * and a hover layer whose hit target is the full column slot rather than the
 * mark. All text wears ink tokens; the hue appears only on the marks.
 */
import type * as React from 'react';
import { useId, useMemo, useState } from 'react';
import { cn } from '../../lib/utils.js';

export interface TimeseriesPoint {
  ts: number;
  value: number;
}

/** Viewport-independent drawing space; the SVG scales to its container. */
const VIEW_W = 720;
const PAD_LEFT = 46;
const PAD_RIGHT = 8;
const PAD_TOP = 10;
const PAD_BOTTOM = 22;
const MIN_BAR = 2;
const MAX_BAR = 18;
const SURFACE_GAP = 2;
const APPROX_X_TICKS = 5;

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function TimeseriesChart({
  points,
  /** A CSS color — pass a semantic token, e.g. `hsl(var(--primary))`. */
  color,
  height = 140,
  format,
  label,
  emptyLabel = 'no data',
  className,
}: {
  points: readonly TimeseriesPoint[];
  color: string;
  height?: number;
  /** Formats values for the y ticks and the tooltip. */
  format: (value: number) => string;
  /** Accessible name for the plot; the visible title lives in the section head. */
  label: string;
  emptyLabel?: string;
  className?: string;
}): React.ReactElement {
  const [hovered, setHovered] = useState<number | null>(null);
  const clipId = useId();

  const max = useMemo(
    () => points.reduce((peak, point) => Math.max(peak, point.value), 0),
    [points],
  );

  if (points.length === 0 || max <= 0) {
    return (
      <div
        data-testid="chart-empty"
        className={cn(
          'flex items-center justify-center border border-dashed border-border/70 py-8 text-[11px] text-muted-foreground',
          className,
        )}
        style={{ height }}
      >
        {emptyLabel}
      </div>
    );
  }

  const plotW = VIEW_W - PAD_LEFT - PAD_RIGHT;
  const plotH = height - PAD_TOP - PAD_BOTTOM;
  const slot = plotW / points.length;
  const barW = Math.max(MIN_BAR, Math.min(MAX_BAR, slot - SURFACE_GAP));
  const yFor = (value: number): number => PAD_TOP + plotH * (1 - value / max);
  const baseline = PAD_TOP + plotH;

  // Four recessive gridlines at quarter steps; the baseline carries the axis.
  const gridValues = [0.25, 0.5, 0.75, 1].map((fraction) => max * fraction);
  const tickEvery = Math.max(1, Math.round(points.length / APPROX_X_TICKS));
  const hoveredPoint = hovered !== null ? points[hovered] : undefined;

  return (
    <div data-testid="timeseries-chart" className={cn('relative', className)}>
      <svg
        viewBox={`0 0 ${VIEW_W} ${height}`}
        className="w-full"
        role="img"
        aria-label={`${label} — ${points.length} buckets, peak ${format(max)}`}
        onMouseLeave={() => setHovered(null)}
        onMouseMove={(event) => {
          const bounds = event.currentTarget.getBoundingClientRect();
          const x = ((event.clientX - bounds.left) / bounds.width) * VIEW_W;
          const index = Math.floor((x - PAD_LEFT) / slot);
          setHovered(index >= 0 && index < points.length ? index : null);
        }}
      >
        <clipPath id={clipId}>
          <rect x={PAD_LEFT} y={PAD_TOP} width={plotW} height={plotH} />
        </clipPath>

        {gridValues.map((value) => (
          <g key={value}>
            <line
              x1={PAD_LEFT}
              x2={VIEW_W - PAD_RIGHT}
              y1={yFor(value)}
              y2={yFor(value)}
              stroke="hsl(var(--border))"
              strokeWidth={1}
              opacity={0.6}
            />
            <text
              x={PAD_LEFT - 6}
              y={yFor(value) + 3}
              textAnchor="end"
              className="fill-muted-foreground text-[9px]"
            >
              {format(value)}
            </text>
          </g>
        ))}

        <line
          x1={PAD_LEFT}
          x2={VIEW_W - PAD_RIGHT}
          y1={baseline}
          y2={baseline}
          stroke="hsl(var(--border))"
          strokeWidth={1}
        />

        <g clipPath={`url(#${clipId})`}>
          {points.map((point, index) => {
            const y = yFor(point.value);
            const barH = baseline - y;
            if (barH <= 0) return null;
            return (
              <rect
                key={point.ts}
                x={PAD_LEFT + index * slot + (slot - barW) / 2}
                y={y}
                width={barW}
                height={barH}
                // Rounded data-end only; the baseline end stays square because
                // the column is anchored to the axis.
                rx={Math.min(4, barW / 2)}
                fill={color}
                opacity={hovered === null || hovered === index ? 1 : 0.45}
              />
            );
          })}
        </g>

        {points.map((point, index) =>
          index % tickEvery === 0 ? (
            <text
              key={point.ts}
              x={PAD_LEFT + index * slot + slot / 2}
              y={height - 6}
              textAnchor="middle"
              className="fill-muted-foreground text-[9px]"
            >
              {formatTime(point.ts)}
            </text>
          ) : null,
        )}

        {/* Transparent surface so the pointer target is the whole plot, not
            the thin marks. */}
        <rect x={PAD_LEFT} y={PAD_TOP} width={plotW} height={plotH} fill="transparent" />
      </svg>

      {hoveredPoint !== undefined && (
        <div
          data-testid="chart-tooltip"
          className="pointer-events-none absolute right-2 top-2 flex items-center gap-1.5 border border-border bg-popover px-2 py-1 text-[11px] shadow-md"
        >
          <span
            aria-hidden="true"
            className="size-2 shrink-0"
            style={{ backgroundColor: color }}
          />
          <span data-testid="chart-tooltip-value" className="tabular font-medium">
            {format(hoveredPoint.value)}
          </span>
          <span className="tabular text-muted-foreground">{formatTime(hoveredPoint.ts)}</span>
        </div>
      )}
    </div>
  );
}
