import { cn } from '@/lib/utils';
import { useAppTranslation } from '@/i18n';
import { fmtTok } from '@/components/ChatView/utils';
import { AlertTriangle, Gauge, Zap } from 'lucide-react';

/**
 * ContextBar — visual context-window fill indicator matching TUI's
 * sub-cell-precise bar (Unicode 1/8 block characters rendered as CSS).
 *
 * Color coding (matches TUI):
 * - green  (< 60%) — healthy
 * - yellow (60–75%) — warning
 * - red    (≥ 75%)  — critical
 *
 * The bar uses 10 segments with 3 sub-segments each (matching the TUI's
 * 1/8-block precision: ▏▎▍▌▋▊▉█). Each segment is 3.33% of the bar.
 */
interface ContextBarProps {
  /** Context fill percentage 0–100. Values above 100 are displayed as 100. */
  pct: number;
  /** Current token count (raw number). */
  tokens?: number | undefined;
  /** Max context window tokens. */
  maxTokens?: number | undefined;
  /**
   * Live prompt-cache snapshot. When supplied AND the cache has
   * activity (`readTokens + writeTokens > 0`), a compact cache-hit
   * sub-line renders next to the bar showing the hit ratio and the
   * cached prefix of the current prompt. Hidden when `null` so cold
   * sessions stay visually quiet.
   */
  cache?: {
    readTokens: number;
    writeTokens: number;
    hitRatio: number;
    coverageTokens: number;
  } | null;
  /** Number of visual segments (default 10, matches TUI). */
  segments?: number | undefined;
  /** Whether to show the token numbers (default true). */
  showTokens?: boolean | undefined;
  /** Additional class name. */
  className?: string | undefined;
  /** Click handler — use to show a breakdown modal. */
  onClick?: (() => void) | undefined;
  /**
   * Visual variant for the filled segments.
   * - `solid` (default) — single zone color per segment (green/yellow/red).
   * - `iridescent` — per-segment hue gradient across the full spectrum:
   *   each segment's color is derived from its position along the fill
   *   (green → cyan → amber → orange → red → magenta), producing a
   *   smooth rainbow transition instead of flat zone colors.
   */
  variant?: 'solid' | 'iridescent' | undefined;
}

const SEGMENT_FILL: Record<number, string> = {
  0: '',
  1: '▏',
  2: '▎',
  3: '▍',
  4: '▌',
  5: '▋',
  6: '▊',
  7: '▉',
  8: '█',
};

function getColor(pct: number): string {
  if (pct >= 85) return 'bg-destructive';
  if (pct >= 60) return 'bg-warning';
  return 'bg-success';
}

function getTextColor(pct: number): string {
  if (pct >= 85) return 'text-destructive';
  if (pct >= 60) return 'text-warning';
  return 'text-success';
}

function getGlow(pct: number): string {
  if (pct >= 85)
    return 'shadow-[0_0_8px_-1px_hsl(var(--destructive)/0.5)] ring-1 ring-destructive/30';
  if (pct >= 60) return 'shadow-[0_0_6px_-2px_hsl(var(--warning)/0.4)]';
  return '';
}

function getZoneIcon(pct: number) {
  if (pct >= 85) return AlertTriangle;
  if (pct >= 60) return Zap;
  return Gauge;
}

/**
 * Iridescent color function — returns an HSL hue for a given position
 * along the fill bar. The spectrum follows a monotonic descent so there
 * are no hue-wrap artifacts: green → yellow-green → yellow → orange →
 * red → magenta.
 *
 * Design notes:
 * - Safe zone (0–45%) stays predominantly green (hue ~140–125) with only
 *   a subtle warm drift, so a healthy bar reads as "green" not "rainbow".
 * - Warning zone (60–85%) transitions through yellow/orange.
 * - Critical/danger (85–100%) goes red → magenta. Magenta is expressed
 *   as hue −40 rather than 320 so the linear interpolation takes the
 *   SHORT path (red → pink → magenta) instead of wrapping through
 *   green/cyan/blue. CSS normalizes hsl(−40) → hsl(320) → magenta.
 *
 * Mapping (raw hue, before CSS normalization):
 *   0%   → 142 (green)
 *   45%  → 125 (green, subtly warmer)
 *   60%  → 78  (yellow — warning boundary)
 *   72%  → 35  (orange)
 *   85%  → 0   (red — critical boundary)
 *   100% → −40 (magenta — danger)
 */
function iridescentHue(positionPct: number): number {
  const p = clampPct(positionPct);
  const stops: Array<[number, number]> = [
    [0, 142],
    [45, 125],
    [60, 78],
    [72, 35],
    [85, 0],
    [100, -40],
  ];
  for (let i = 0; i < stops.length - 1; i++) {
    const [p0, h0] = stops[i]!;
    const [p1, h1] = stops[i + 1]!;
    if (p <= p1) {
      const t = (p - p0) / (p1 - p0 || 1);
      return Math.round(h0 + t * (h1 - h0));
    }
  }
  return -40;
}

/** Build a CSS `hsl()` color string for an iridescent position. */
function iridescentColor(positionPct: number, lightness = 55, saturation = 75): string {
  return `hsl(${iridescentHue(positionPct)}, ${saturation}%, ${lightness}%)`;
}

function clampPct(pct: number): number {
  if (!Number.isFinite(pct)) return 0;
  return Math.max(0, Math.min(100, pct));
}

export function ContextBar({
  pct,
  tokens,
  maxTokens,
  cache,
  segments = 10,
  showTokens = true,
  className,
  onClick,
  variant = 'solid',
}: ContextBarProps): React.ReactElement {
  const { t } = useAppTranslation();
  const clamped = clampPct(pct);
  const eighths = Math.round((clamped / 100) * segments * 8);
  const isCritical = clamped >= 85;
  const isWarning = clamped >= 60 && clamped < 85;
  const ZoneIcon = getZoneIcon(clamped);
  const isIridescent = variant === 'iridescent';
  const cacheActive = !!cache && cache.readTokens + cache.writeTokens > 0;

  // Build bar segments
  const bars: Array<{ fill: number; positionPct: number }> = [];
  let remaining = eighths;
  for (let i = 0; i < segments; i++) {
    const segFill = Math.min(8, remaining);
    // The position of this segment's CENTER along the 0-100 fill axis.
    const positionPct = ((i + 0.5) / segments) * 100;
    bars.push({ fill: segFill, positionPct });
    remaining -= segFill;
  }

  const pctText = `${Math.round(clamped)}%`;
  const tokenText =
    showTokens && tokens !== undefined && maxTokens !== undefined && maxTokens > 0
      ? ` ${fmtTok(tokens)}/${fmtTok(maxTokens)}`
      : '';

  const Element = onClick ? 'button' : 'span';

  return (
    <Element
      role="progressbar"
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuetext={`${Math.round(clamped)}%`}
      className={cn(
        'inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-[11px] font-mono font-medium shrink-0 transition-all duration-300',
        onClick && 'cursor-pointer hover:scale-[1.02] hover:ring-1 hover:ring-ring',
        getTextColor(clamped),
        isCritical ? 'bg-destructive/10' : isWarning ? 'bg-warning/10' : 'bg-success/10',
        getGlow(clamped),
        isCritical && 'animate-pulse',
        className,
      )}
      title={
        (tokens !== undefined && maxTokens !== undefined
          ? t('activity:context.barWithTokens', {
              tokens: tokens.toLocaleString(),
              max: maxTokens.toLocaleString(),
              pct: pctText,
            })
          : t('activity:context.barPct', { pct: pctText })) +
        (onClick ? t('activity:context.barClick') : '')
      }
      onClick={
        onClick
          ? (e: React.MouseEvent) => {
              e.stopPropagation();
              onClick();
            }
          : undefined
      }
      type={onClick ? 'button' : undefined}
    >
      {/* Zone icon — changes by severity */}
      <ZoneIcon className={cn('h-3 w-3 shrink-0', getTextColor(clamped))} />

      {/* Unicode block segments */}
      <span className="inline-flex font-mono text-[10px] leading-none tracking-tight">
        {bars.map((b, i) => (
          <span
            key={i}
            className={cn(
              'tabular-nums w-[0.55em] text-center transition-colors duration-300',
              !isIridescent && (b.fill > 0 ? getTextColor(clamped) : 'text-muted-foreground/40'),
            )}
            style={
              isIridescent && b.fill > 0
                ? { color: iridescentColor(b.positionPct, 58, 80) }
                : isIridescent
                  ? { color: 'hsl(var(--muted-foreground) / 0.4)' }
                  : undefined
            }
          >
            {SEGMENT_FILL[b.fill] ?? ' '}
          </span>
        ))}
      </span>
      <span className="font-bold tracking-tight">{pctText}</span>
      {tokenText && <span className="tabular-nums opacity-80">{tokenText}</span>}
      {cacheActive && cache ? (
        <span
          className="ml-1 inline-flex items-center gap-1 text-[10px] font-mono tabular-nums text-success"
          title={
            cache.coverageTokens > 0 && maxTokens !== undefined && maxTokens > 0
              ? `Cache covers ${cache.coverageTokens.toLocaleString()} of ${maxTokens.toLocaleString()} tokens`
              : `Prompt cache: ${(cache.hitRatio * 100).toFixed(1)}% hit`
          }
        >
          · {(cache.hitRatio * 100).toFixed(1)}% hit
          {cache.coverageTokens > 0 && maxTokens !== undefined && maxTokens > 0
            ? ` · covers ${fmtTok(cache.coverageTokens)}`
            : ''}
        </span>
      ) : null}
    </Element>
  );
}

/**
 * Horizontal CSS-based context fill bar — a smooth, gradient-filled
 * progress indicator with glow effects and animated stripes.
 */
export function ContextFillBar({
  pct,
  tokens,
  maxTokens,
  cache,
  showTokens = true,
  className,
  onClick,
}: Omit<ContextBarProps, 'segments'>): React.ReactElement {
  const { t } = useAppTranslation();
  const clamped = clampPct(pct);
  const pctText = `${Math.round(clamped)}%`;
  const tokenText =
    showTokens && tokens !== undefined && maxTokens !== undefined && maxTokens > 0
      ? ` ${fmtTok(tokens)}/${fmtTok(maxTokens)}`
      : '';
  const cacheActive = !!cache && cache.readTokens + cache.writeTokens > 0;

  const isCritical = clamped >= 85;
  const isWarning = clamped >= 60 && clamped < 85;
  const ZoneIcon = getZoneIcon(clamped);

  const Element = onClick ? 'button' : 'span';

  return (
    <Element
      role="progressbar"
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuetext={`${Math.round(clamped)}%`}
      className={cn(
        'inline-flex items-center gap-2 group',
        onClick && 'cursor-pointer hover:opacity-90 transition-opacity',
        className,
      )}
      title={
        (tokens !== undefined && maxTokens !== undefined
          ? t('activity:context.barWithTokens', {
              tokens: tokens.toLocaleString(),
              max: maxTokens.toLocaleString(),
              pct: pctText,
            })
          : t('activity:context.barPct', { pct: pctText })) +
        (onClick ? t('activity:context.barClick') : '')
      }
      onClick={
        onClick
          ? (e: React.MouseEvent) => {
              e.stopPropagation();
              onClick();
            }
          : undefined
      }
      type={onClick ? 'button' : undefined}
    >
      {/* Gradient bar with rounded track */}
      <span
        className={cn(
          'relative h-2 w-20 overflow-hidden rounded-full shrink-0 transition-shadow duration-300',
          'bg-muted/60 ring-1 ring-inset ring-border/30',
          isCritical && 'ring-destructive/30',
        )}
      >
        <span
          className={cn(
            'h-full rounded-full transition-all duration-500 ease-out',
            getColor(clamped),
            isCritical && 'animate-pulse',
          )}
          style={{
            width: `${Math.max(3, clamped)}%`,
            background: isCritical
              ? 'linear-gradient(90deg, hsl(var(--destructive)) 0%, hsl(var(--destructive) / 0.72) 100%)'
              : isWarning
                ? 'linear-gradient(90deg, hsl(var(--warning)) 0%, hsl(var(--warning) / 0.72) 100%)'
                : 'linear-gradient(90deg, hsl(var(--success)) 0%, hsl(var(--success) / 0.72) 100%)',
          }}
        >
          {/* Shimmer overlay for visual life */}
          <span
            className={cn(
              'absolute inset-0 opacity-30 bg-gradient-to-r from-transparent via-white/40 to-transparent',
              'animate-[shimmer_2s_ease-in-out_infinite]',
            )}
          />
        </span>
      </span>

      {/* Zone icon */}
      <ZoneIcon className={cn('h-3 w-3 shrink-0 transition-colors', getTextColor(clamped))} />

      <span
        className={cn(
          'text-[11px] font-mono tabular-nums font-bold tracking-tight transition-colors',
          getTextColor(clamped),
        )}
      >
        {pctText}
      </span>
      {tokenText && (
        <span className="text-[10px] text-muted-foreground tabular-nums">{tokenText}</span>
      )}
      {cacheActive && cache ? (
        <span
          className="text-[10px] font-mono tabular-nums text-success"
          title={
            cache.coverageTokens > 0 && maxTokens !== undefined && maxTokens > 0
              ? `Cache covers ${cache.coverageTokens.toLocaleString()} of ${maxTokens.toLocaleString()} tokens`
              : `Prompt cache: ${(cache.hitRatio * 100).toFixed(1)}% hit`
          }
        >
          · {(cache.hitRatio * 100).toFixed(1)}% hit
          {cache.coverageTokens > 0 && maxTokens !== undefined && maxTokens > 0
            ? ` · covers ${fmtTok(cache.coverageTokens)}`
            : ''}
        </span>
      ) : null}
    </Element>
  );
}
