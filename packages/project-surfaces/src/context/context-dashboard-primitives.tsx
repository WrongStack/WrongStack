import { useEffect, useRef, useState } from 'react';
import { displayLocale, useAppTranslation } from '../lib/i18n';
import { cn } from '../lib/utils';

export interface ZoneConfig {
  labelKey: string;
  emoji: string;
  color: string;
  bg: string;
  text: string;
  cssColor: string;
  from: number;
  to: number;
  descKey: string;
}

/** Safe, warning, critical and danger, lowest first. */
export const ZONES: readonly [ZoneConfig, ZoneConfig, ZoneConfig, ZoneConfig] = [
  {
    labelKey: 'activity:ctxDash.zoneSafe',
    emoji: '🟢',
    color: 'text-success',
    bg: 'bg-success/10',
    text: 'text-success',
    cssColor: 'hsl(var(--success))',
    from: 0,
    to: 60,
    descKey: 'activity:ctxDash.zoneSafeDesc',
  },
  {
    labelKey: 'activity:ctxDash.zoneWarning',
    emoji: '🟡',
    color: 'text-warning',
    bg: 'bg-warning/10',
    text: 'text-warning',
    cssColor: 'hsl(var(--warning))',
    from: 60,
    to: 85,
    descKey: 'activity:ctxDash.zoneWarningDesc',
  },
  {
    labelKey: 'activity:ctxDash.zoneCritical',
    emoji: '🔴',
    color: 'text-destructive',
    bg: 'bg-destructive/10',
    text: 'text-destructive',
    cssColor: 'hsl(var(--destructive))',
    from: 85,
    to: 95,
    descKey: 'activity:ctxDash.zoneCriticalDesc',
  },
  {
    labelKey: 'activity:ctxDash.zoneDanger',
    emoji: '⚫',
    color: 'text-brand-orange',
    bg: 'bg-brand-orange/15',
    text: 'text-brand-orange',
    cssColor: 'hsl(var(--brand-orange))',
    from: 95,
    to: 100,
    descKey: 'activity:ctxDash.zoneDangerDesc',
  },
];

// ── Helpers ───────────────────────────────────────────────────────────

export function zoneFor(pct: number): ZoneConfig {
  if (pct > 95) return ZONES[3];
  if (pct > 85) return ZONES[2];
  if (pct > 60) return ZONES[1];
  return ZONES[0];
}

export function fmtDuration(startedAt: number | null): string {
  if (!startedAt) return '—';
  const elapsed = Date.now() - startedAt;
  const hrs = Math.floor(elapsed / 3600000);
  const mins = Math.floor((elapsed % 3600000) / 60000);
  const secs = Math.floor((elapsed % 60000) / 1000);
  if (hrs > 0) return `${hrs}h ${mins}m`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}
export function SectionCard({
  title,
  icon: Icon,
  children,
  className,
  accent,
}: {
  title: string;
  icon: React.ElementType;
  children: React.ReactNode;
  className?: string;
  accent?: 'default' | 'danger' | 'warning' | 'success';
}) {
  const accentColor =
    accent === 'danger'
      ? 'text-destructive'
      : accent === 'warning'
        ? 'text-warning'
        : accent === 'success'
          ? 'text-success'
          : 'text-muted-foreground';
  const accentBg =
    accent === 'danger'
      ? 'bg-destructive/5'
      : accent === 'warning'
        ? 'bg-warning/5'
        : accent === 'success'
          ? 'bg-success/5'
          : '';
  return (
    <div
      className={cn(
        'ws-panel rounded-xl border bg-card/80 backdrop-blur-sm p-4 space-y-3',
        'shadow-sm transition-shadow hover:shadow-md',
        'ring-1 ring-border/40',
        accentBg,
        className,
      )}
    >
      <div className="flex items-center gap-2 text-sm font-bold tracking-tight text-foreground">
        <span
          className={cn(
            'flex items-center justify-center h-6 w-6 rounded-lg',
            accentBg,
            accent !== 'default' && 'ring-1 ring-inset',
          )}
        >
          <Icon className={cn('h-3.5 w-3.5', accentColor)} />
        </span>
        {title}
      </div>
      {children}
    </div>
  );
}

export function MetricRow({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <div className="flex items-center justify-between text-xs py-0.5">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={cn(
          'tabular-nums font-mono font-semibold px-1.5 py-0.5 rounded',
          color ?? 'text-foreground',
        )}
      >
        {value}
      </span>
    </div>
  );
}

/** SVG donut gauge — animated ring with centered percentage. */
export function AnimatedDonutGauge({
  pct,
  size = 96,
  strokeWidth = 10,
}: {
  pct: number;
  size?: number;
  strokeWidth?: number;
}) {
  const { t } = useAppTranslation();
  const clamped = Math.max(0, Math.min(100, pct));
  const r = (size - strokeWidth) / 2;
  const circ = 2 * Math.PI * r;
  const fillLen = (clamped / 100) * circ;
  const zone = zoneFor(clamped);
  const color = zone.cssColor;

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="drop-shadow-lg">
      <title>{t('activity:contextText.usageTitle', { pct: clamped.toFixed(0) })}</title>
      {/* Background track */}
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="hsl(var(--muted))"
        strokeWidth={strokeWidth}
        opacity={0.3}
      />
      {/* Filled arc */}
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeDasharray={`${fillLen} ${circ - fillLen}`}
        strokeDashoffset={0}
        className="transition-all duration-1000 ease-out"
        style={{ transformOrigin: 'center', transform: 'rotate(-90deg)' }}
      />
      {/* Center percentage */}
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r - strokeWidth / 2 + 2}
        fill="hsl(var(--card))"
        className="drop-shadow-sm"
      />
      <text
        x={size / 2}
        y={size / 2}
        textAnchor="middle"
        dominantBaseline="central"
        fill={color}
        className="text-lg font-bold font-mono tabular-nums"
        style={{ fontSize: size * 0.16 }}
      >
        {clamped.toFixed(0)}%
      </text>
    </svg>
  );
}

/** Animated counter — counts from 0 to target on mount/change. */
export function AnimatedCounter({
  value,
  suffix = '',
  duration = 800,
}: {
  value: number;
  suffix?: string;
  duration?: number;
}) {
  const [display, setDisplay] = useState(0);
  const prevRef = useRef(0);
  const rafRef = useRef<ReturnType<typeof requestAnimationFrame> | undefined>(undefined);

  useEffect(() => {
    const start = prevRef.current;
    const startTime = performance.now();
    const diff = value - start;

    if (Math.abs(diff) < 1) {
      setDisplay(value);
      prevRef.current = value;
      return;
    }

    const animate = (now: number) => {
      const elapsed = now - startTime;
      const progress = Math.min(1, elapsed / duration);
      // Ease-out cubic
      const eased = 1 - (1 - progress) ** 3;
      setDisplay(Math.round(start + diff * eased));
      if (progress < 1) {
        rafRef.current = requestAnimationFrame(animate);
      } else {
        prevRef.current = value;
      }
    };
    rafRef.current = requestAnimationFrame(animate);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [value, duration]);

  return (
    <>
      {display.toLocaleString(displayLocale())}
      {suffix}
    </>
  );
}
