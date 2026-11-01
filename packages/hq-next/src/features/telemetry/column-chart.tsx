'use client';

/**
 * One measure over time as columns. Every column of the window is drawn, empty
 * ones included, so a quiet hour reads as a gap instead of vanishing.
 *
 * The SVG only carries the marks and stretches to its box; every label is
 * HTML, so text stays at its set size on any screen. Pointer users read a
 * column by hovering; everyone gets the numbers as a table one click away.
 */
import type { ReactNode } from 'react';
import { useState } from 'react';
import { cn } from '@/lib/cn';
import { niceCeiling } from './model';

export interface ChartColumn {
  ts: number;
  value: number;
}

const X_TICKS = 5;

function timeLabel(ts: number, withDay: boolean): string {
  const date = new Date(ts);
  return withDay
    ? date.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })
    : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function ColumnChart({
  title,
  total,
  columns,
  bucketMs,
  color,
  format,
}: {
  title: string;
  /** The window's sum, shown beside the title. */
  total: string;
  columns: readonly ChartColumn[];
  bucketMs: number;
  /** A CSS colour, e.g. `var(--color-primary)`. */
  color: string;
  format: (value: number) => string;
}): ReactNode {
  const [active, setActive] = useState<number | null>(null);
  const max = columns.reduce((peak, column) => Math.max(peak, column.value), 0);
  // The scale runs to a round number above the peak, so gridline labels read cleanly.
  const top = niceCeiling(max);
  const withDay = columns.length > 0 && bucketMs * columns.length > 24 * 60 * 60 * 1000;
  const span = (column: ChartColumn): string =>
    `${timeLabel(column.ts, withDay)} – ${timeLabel(column.ts + bucketMs, false)}`;
  const shown = active !== null ? columns[active] : undefined;
  const step = Math.max(1, Math.round(columns.length / X_TICKS));

  return (
    <figure className="flex flex-col gap-3">
      <figcaption className="flex flex-wrap items-baseline gap-x-3">
        <span className="text-sm font-semibold">{title}</span>
        <span className="tabular text-sm text-muted-foreground">{total}</span>
        <span className="tabular ml-auto text-sm" aria-live="polite">
          {shown !== undefined && (
            <>
              <span className="font-semibold">{format(shown.value)}</span>{' '}
              <span className="text-muted-foreground">{span(shown)}</span>
            </>
          )}
        </span>
      </figcaption>

      {max <= 0 ? (
        <p className="grid h-40 place-items-center border border-dashed border-border text-sm text-muted-foreground">
          Nothing in this window
        </p>
      ) : (
        <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2">
          <div className="tabular flex h-40 flex-col justify-between text-right text-xs text-muted-foreground">
            <span>{format(top)}</span>
            <span>{format(top / 2)}</span>
            <span>0</span>
          </div>
          <div
            role="img"
            aria-label={`${title}: ${total} over ${columns.length} columns, peak ${format(max)}. Every value is listed under Show the numbers.`}
            onMouseLeave={() => setActive(null)}
            onMouseMove={(event) => {
              const bounds = event.currentTarget.getBoundingClientRect();
              const index = Math.floor(
                ((event.clientX - bounds.left) / bounds.width) * columns.length,
              );
              setActive(index >= 0 && index < columns.length ? index : null);
            }}
            className="relative h-40 border-b border-border bg-[linear-gradient(to_bottom,var(--color-border)_1px,transparent_1px)] bg-[length:100%_50%]"
          >
            <svg
              viewBox={`0 0 ${columns.length} 100`}
              preserveAspectRatio="none"
              className="absolute inset-0 size-full"
              aria-hidden="true"
            >
              {columns.map((column, index) => {
                const height = (column.value / top) * 100;
                if (height <= 0) return null;
                return (
                  <rect
                    key={column.ts}
                    x={index + 0.15}
                    width={0.7}
                    y={100 - Math.max(height, 1)}
                    height={Math.max(height, 1)}
                    fill={color}
                    opacity={active === null || active === index ? 1 : 0.4}
                  />
                );
              })}
            </svg>
          </div>
          <span />
          <div className="relative h-5 text-xs text-muted-foreground">
            {columns.map((column, index) =>
              index % step === 0 ? (
                <span
                  key={column.ts}
                  className="tabular absolute top-1 -translate-x-1/2 whitespace-nowrap"
                  style={{ left: `${((index + 0.5) / columns.length) * 100}%` }}
                >
                  {timeLabel(column.ts, withDay)}
                </span>
              ) : null,
            )}
          </div>
        </div>
      )}

      <details className="text-sm">
        <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
          Show the numbers
        </summary>
        <table className="mt-2 w-full max-w-md text-sm">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="py-1 font-medium">From</th>
              <th className="py-1 text-right font-medium">{title}</th>
            </tr>
          </thead>
          <tbody>
            {columns
              .filter((column) => column.value > 0)
              .map((column) => (
                <tr key={column.ts} className={cn('border-t border-border')}>
                  <td className="tabular py-1">{span(column)}</td>
                  <td className="tabular py-1 text-right">{format(column.value)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
