/**
 * SparklineChart — 12-bin activity histogram.
 *
 * Renders a Unicode sparkline: ▁▃▅▇▆▄▂▁▃▅
 * Each bin represents a time bucket; height is normalized to 0-8 display chars.
 */

import { useAppTranslation } from '@/i18n';

const SPARKLINE_CHARS = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const;
const NUM_BINS = 12;

/** Map a raw count (0–N) to a display character height (0–8). */
function toHeight(count: number, maxCount: number): number {
  if (maxCount === 0) return 0;
  return Math.min(8, Math.round((count / maxCount) * 8));
}

interface SparklineChartProps {
  /** 12-element array of event counts per bucket. Index 0 = most recent. */
  bins: number[];
  /** Optional CSS class for the wrapper. */
  className?: string;
  /** Fixed width in chars (default 12). */
  width?: number;
}

export function SparklineChart({ bins, className }: SparklineChartProps) {
  const { t } = useAppTranslation();
  // Normalize to NUM_BINS by padding/truncating from the right (oldest bins)
  const padded = Array.from({ length: NUM_BINS }, (_, i) => bins.at(-(NUM_BINS - i)) ?? 0);
  const maxCount = Math.max(...padded, 1);
  const isEmpty = maxCount === 1 && padded.every((b) => b === 0);

  // Don't render anything for a truly idle agent — avoids "▁▁▁" sparkles
  if (isEmpty) {
    return (
      <span
        role="img"
        className={className}
        aria-label={t('common:sparkline.noActivity')}
        title={t('common:sparkline.noActivityYet')}
      >
        {'—'}
      </span>
    );
  }

  return (
    <span
      role="img"
      className={className}
      aria-label={t('common:sparkline.activityMax', { count: maxCount })}
      title={t('common:sparkline.activityPeak', { count: maxCount })}
    >
      {padded.map((count, i) => {
        const height = toHeight(count, maxCount);
        const char = SPARKLINE_CHARS[height];
        return (
          <span
            key={i}
            style={{
              // Green for high activity, muted for low — no aggressive primary mid-range
              color:
                height >= 7
                  ? 'hsl(var(--success))'
                  : height >= 3
                    ? 'hsl(var(--muted-foreground))'
                    : 'hsl(var(--muted-foreground))',
              opacity: height > 0 ? undefined : 0.3,
            }}
          >
            {char}
          </span>
        );
      })}
    </span>
  );
}
