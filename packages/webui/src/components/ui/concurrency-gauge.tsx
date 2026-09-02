/**
 * ConcurrencyGauge — fleet concurrency visualization.
 *
 * Renders a visual bar: [████████░░░░] 3/4
 * Matches the TUI's fleet concurrency gauge for quick at-a-glance status.
 */

interface ConcurrencyGaugeProps {
  /** Current active concurrency (running agents). */
  current: number;
  /** Maximum allowed concurrency slots. */
  max: number;
  /** Optional CSS class for the wrapper. */
  className?: string;
  /** Show numeric label "current/max" next to bar. */
  showLabel?: boolean;
}

export function ConcurrencyGauge({
  current,
  max,
  className,
  showLabel = true,
}: ConcurrencyGaugeProps) {
  const filled = Math.min(current, max);
  const empty = Math.max(0, max - filled);
  const pct = max > 0 ? (filled / max) * 100 : 0;

  const barColor = pct >= 90 ? 'text-destructive' : pct >= 70 ? 'text-warning' : 'text-success';

  return (
    <span className={className} title={`Fleet concurrency: ${current}/${max}`}>
      <span aria-hidden="true" className="font-mono text-[10px] tracking-tight">
        [<span className={barColor}>{'█'.repeat(filled)}</span>
        <span className="text-[hsl(var(--muted))]">{'░'.repeat(empty)}</span>]
      </span>
      {showLabel && (
        <span className="ml-1.5 tabular-nums text-[10px] text-muted-foreground font-mono">
          {current}/{max}
        </span>
      )}
    </span>
  );
}
