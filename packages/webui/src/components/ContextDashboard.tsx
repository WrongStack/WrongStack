/**
 * ContextDashboard — a full-page context-window telemetry dashboard for the WebUI.
 *
 * Mirrors the TUI `/context window` panel: pressure bar, source breakdown,
 * threshold map, compaction engine, per-agent footprints, token metrics.
 *
 * Data sources:
 *   - session-store: lastInputTokens, maxContext, mode, model, uptime, iteration
 *   - fleet-store:  per-agent ctxPct/ctxTokens for per-agent footprint
 *   - context.debug WS: detailed breakdown (system prompt, tools, messages)
 */

import {
  AlertTriangle,
  ArrowLeft,
  BarChart3,
  Cpu,
  FileText,
  Gauge,
  HardDrive,
  Layers,
  MessageSquare,
  RefreshCw,
  Sparkles,
  Users,
  Wrench,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { ContextBar, ContextFillBar } from '@/components/ContextBar';
import { fmtTok } from '@/components/dashboard-primitives';
import { Button } from '@/components/ui/button';
import { useScrollPosition } from '@/hooks/useScrollPosition';
import { useAppTranslation } from '@/i18n';
import { agentBelongsToSession } from '@/lib/agent-session';
import { cn } from '@/lib/utils';
import { getWSClient } from '@/lib/ws-client';
import {
  type SubagentView,
  useActiveSessionId,
  useConfigStore,
  useFleetStore,
  useSessionStore,
  useUIStore,
} from '@/stores';
import { ContextMemoryMonitor } from './ContextMemoryMonitor';
import { MemoryLifecycleTrace } from './MemoryManager/MemoryLifecycleTrace';

// ── Types ────────────────────────────────────────────────────────────

interface ContextDebugPayload {
  total: number;
  mode?: string | undefined;
  policy?: unknown | undefined;
  systemPrompt: number;
  tools: {
    total: number;
    count: number;
    breakdown: Array<{ name: string; tokens: number }>;
  };
  messages: {
    total: number;
    count: number;
    breakdown: Array<{ index: number; role: string; tokens: number; preview: string }>;
  };
}

interface ZoneConfig {
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

const ZONES: ZoneConfig[] = [
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

function zoneFor(pct: number): ZoneConfig {
  if (pct > 95) return ZONES[3];
  if (pct > 85) return ZONES[2];
  if (pct > 60) return ZONES[1];
  return ZONES[0];
}

function fmtDuration(startedAt: number | null): string {
  if (!startedAt) return '—';
  const elapsed = Date.now() - startedAt;
  const hrs = Math.floor(elapsed / 3600000);
  const mins = Math.floor((elapsed % 3600000) / 60000);
  const secs = Math.floor((elapsed % 60000) / 1000);
  if (hrs > 0) return `${hrs}h ${mins}m`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

// ── Section components ────────────────────────────────────────────────

function SectionCard({
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
        'rounded-xl border bg-card/80 backdrop-blur-sm p-4 space-y-3',
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

function MetricRow({ label, value, color }: { label: string; value: string; color?: string }) {
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
function AnimatedDonutGauge({
  pct,
  size = 96,
  strokeWidth = 10,
}: {
  pct: number;
  size?: number;
  strokeWidth?: number;
}) {
  const clamped = Math.max(0, Math.min(100, pct));
  const r = (size - strokeWidth) / 2;
  const circ = 2 * Math.PI * r;
  const fillLen = (clamped / 100) * circ;
  const zone = zoneFor(clamped);
  const color = zone.cssColor;

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="drop-shadow-lg">
      <title>Context usage: {clamped.toFixed(0)}%</title>
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
function AnimatedCounter({
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
      {display.toLocaleString()}
      {suffix}
    </>
  );
}

function PressureSection({
  pct,
  tokens,
  maxTokens,
}: {
  pct: number;
  tokens: number;
  maxTokens: number;
}) {
  const { t } = useAppTranslation();
  const zone = zoneFor(pct);
  const accent = pct > 85 ? 'danger' : pct > 60 ? 'warning' : 'success';

  return (
    <SectionCard title={t('activity:ctxDash.contextPressure')} icon={Gauge} accent={accent}>
      <div className="flex flex-col sm:flex-row items-center gap-4">
        {/* Donut gauge */}
        <div
          className={cn(
            'shrink-0 transition-all duration-500',
            pct > 85 &&
              'animate-[pulse_2s_ease-in-out_infinite] drop-shadow-[0_0_12px_hsl(var(--destructive)/0.35)]',
          )}
        >
          <AnimatedDonutGauge pct={pct} size={96} strokeWidth={10} />
        </div>

        <div className="flex-1 min-w-0 space-y-2 w-full">
          {/* Iridescent bar */}
          <div className="flex items-center gap-3">
            <span className="text-xl">{zone.emoji}</span>
            <div className="flex-1">
              <ContextBar
                pct={Math.round(pct)}
                tokens={tokens}
                maxTokens={maxTokens}
                segments={10}
                variant="iridescent"
              />
            </div>
          </div>

          {/* Token counts with animation */}
          <div className="grid grid-cols-3 gap-1 text-[10px] font-mono tabular-nums">
            <div className="rounded bg-muted/30 px-2 py-1 text-center">
              <span className="text-muted-foreground block text-[9px]">
                {t('activity:ctxDash.used')}
              </span>
              <span className={cn('font-bold', zone.color)}>
                <AnimatedCounter value={tokens} />
              </span>
            </div>
            <div className="rounded bg-muted/30 px-2 py-1 text-center">
              <span className="text-muted-foreground block text-[9px]">
                {t('activity:ctxDash.free')}
              </span>
              <span className="font-bold text-muted-foreground/80">
                <AnimatedCounter value={Math.max(0, maxTokens - tokens)} />
              </span>
            </div>
            <div className="rounded bg-muted/30 px-2 py-1 text-center">
              <span className="text-muted-foreground block text-[9px]">
                {t('activity:ctxDash.capacity')}
              </span>
              <span className="font-bold text-muted-foreground/80">
                <AnimatedCounter value={maxTokens} />
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Threshold axis */}
      <div className="relative h-4 mt-1">
        <div className="absolute inset-x-0 top-0 h-2 rounded-full overflow-hidden flex">
          {ZONES.map((z) => {
            const width = ((z.to - z.from) / 100) * 100;
            return (
              <div
                key={t(z.labelKey)}
                className="h-full first:rounded-l-full last:rounded-r-full opacity-60"
                style={{ width: `${width}%`, backgroundColor: z.cssColor }}
              />
            );
          })}
        </div>
        <div className="absolute top-3 text-[10px] text-muted-foreground flex w-full">
          <span>0%</span>
          <span className="ml-[56%]">soft</span>
          <span className="ml-[12%]">hard</span>
          <span className="ml-[8%]">max</span>
          <span className="ml-auto">100%</span>
        </div>
      </div>

      {/* Current position marker */}
      <div className="relative h-5 mt-1">
        <div
          className="absolute top-0 -translate-x-1/2 flex flex-col items-center transition-all duration-500"
          style={{ left: `${Math.min(95, pct)}%` }}
        >
          <span
            className={cn(
              'text-[9px] font-mono px-1.5 py-0.5 rounded border transition-colors',
              zone.bg,
              zone.text,
              'border-current/30',
            )}
          >
            ◀ {pct.toFixed(0)}%
          </span>
        </div>
      </div>
    </SectionCard>
  );
}

function CompositionSection({
  data,
  loading,
}: {
  data: ContextDebugPayload | null;
  loading: boolean;
}) {
  const { t } = useAppTranslation();
  if (loading) {
    return (
      <SectionCard title={t('activity:ctxDash.contextComposition')} icon={Layers}>
        <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
          <RefreshCw className="h-3 w-3 animate-spin" />
          {t('activity:ctxDash.fetchingCompositionData')}
        </div>
      </SectionCard>
    );
  }
  if (!data || data.total <= 0) {
    return (
      <SectionCard title={t('activity:ctxDash.contextComposition')} icon={Layers}>
        <div className="text-xs text-muted-foreground py-1">
          {t('activity:ctxDash.noCompositionDataAvailableYetRun')}
        </div>
      </SectionCard>
    );
  }

  const items = [
    {
      icon: FileText,
      label: t('activity:ctxDash.systemPrompt'),
      value: data.systemPrompt,
      className: 'bg-info',
    },
    {
      icon: Wrench,
      label: t('activity:ctxDash.tools'),
      value: data.tools.total,
      className: 'bg-warning',
    },
    {
      icon: MessageSquare,
      label: t('activity:ctxDash.messages'),
      value: data.messages.total,
      className: 'bg-success',
    },
  ];

  return (
    <SectionCard title={t('activity:ctxDash.contextComposition')} icon={Layers}>
      {/* Visual bar */}
      <div className="h-3 w-full overflow-hidden rounded-full bg-muted flex">
        {items.map((item) => {
          const width = (item.value / data.total) * 100;
          if (width <= 0) return null;
          return (
            <span
              key={item.label}
              className={cn(
                'h-full first:rounded-l-full last:rounded-r-full transition-all',
                item.className,
              )}
              style={{ width: `${width}%` }}
            />
          );
        })}
      </div>

      {/* Legend */}
      <div className="space-y-1">
        {items.map((item) => {
          const pct = ((item.value / data.total) * 100).toFixed(1);
          return (
            <MetricRow
              key={item.label}
              label={`${item.label}`}
              value={`${fmtTok(item.value)} (${pct}%)`}
            />
          );
        })}
      </div>

      {/* Tool breakdown (top 5) */}
      {data.tools.breakdown.length > 0 && (
        <div className="pt-1 border-t border-border/50">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
            {t('activity:ctxDash.toolBreakdown')}
          </span>
          <div className="mt-1 space-y-0.5">
            {data.tools.breakdown.slice(0, 5).map((t) => (
              <div key={t.name} className="flex items-center justify-between text-xs py-0.5">
                <span className="font-mono text-muted-foreground">{t.name}</span>
                <span className="tabular-nums text-muted-foreground">{fmtTok(t.tokens)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </SectionCard>
  );
}

function ThresholdSection({ pct }: { pct: number }) {
  const { t } = useAppTranslation();
  return (
    <SectionCard title={t('activity:ctxDash.thresholdMap')} icon={AlertTriangle}>
      {/* Zone strip */}
      <div className="flex h-2 rounded-full overflow-hidden">
        {ZONES.map((z) => (
          <div
            key={t(z.labelKey)}
            className="h-full first:rounded-l-full last:rounded-r-full opacity-80"
            style={{
              width: `${((z.to - z.from) / 100) * 100}%`,
              backgroundColor: z.cssColor,
            }}
          />
        ))}
      </div>

      {/* Zone table */}
      <div className="space-y-0.5 text-xs">
        {ZONES.map((z) => {
          const active = pct >= z.from && pct < z.to;
          return (
            <div
              key={t(z.labelKey)}
              className={cn('flex items-center px-2 py-1 rounded', active ? z.bg : '')}
            >
              <span className="w-5">{z.emoji}</span>
              <span className={cn('w-20 font-medium', active ? z.text : 'text-muted-foreground')}>
                {t(z.labelKey)}
              </span>
              <span className="w-16 text-muted-foreground">
                {z.from}%–{z.to}%
              </span>
              <span className="flex-1 text-muted-foreground">{t(z.descKey)}</span>
              {active && <span className="text-xs font-mono">◀</span>}
            </div>
          );
        })}
      </div>

      <MetricRow
        label={t('activity:ctxDash.currentPosition')}
        value={`${pct.toFixed(1)}% → ${zoneFor(pct).emoji} ${t(zoneFor(pct).labelKey)}`}
        color={zoneFor(pct).color}
      />
      <MetricRow label={t('activity:ctxDash.compactTrigger')} value="85%" />
      <MetricRow label={t('activity:ctxDash.hardLimit')} value="100%" />
    </SectionCard>
  );
}

function CompactionSection({ pct, maxTokens }: { pct: number; maxTokens: number }) {
  const { t } = useAppTranslation();
  const recoveryEst = Math.round(maxTokens * 0.18);
  const triggerAt = Math.round(maxTokens * 0.85);
  const needsCompact = pct > 65;
  const compactPct = maxTokens > 0 ? pct / 100 : 0;

  return (
    <SectionCard
      title={t('activity:ctxDash.compactionEngine')}
      icon={HardDrive}
      accent={needsCompact ? 'warning' : 'success'}
    >
      <div className="space-y-2 text-xs">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">{t('activity:ctxDash.strategy')}</span>
          <span className="font-semibold text-foreground/90">hybrid</span>
          <span className="text-success bg-success/10 px-1.5 rounded text-[9px] font-semibold">
            {t('activity:ctxDash.auto')}
          </span>
        </div>

        {/* Visual trigger meter */}
        <div className="space-y-0.5">
          <div className="flex justify-between text-[9px] text-muted-foreground">
            <span>{t('activity:ctxDash.current')}</span>
            <span>Trigger ({fmtTok(triggerAt)})</span>
          </div>
          <div className="relative h-2 w-full overflow-hidden rounded-full bg-muted/50 ring-1 ring-inset ring-border/20">
            <span
              className={cn(
                'absolute inset-y-0 left-0 rounded-full transition-all duration-700',
                needsCompact ? 'bg-warning' : 'bg-success',
              )}
              style={{ width: `${Math.max(2, compactPct * 100)}%` }}
            />
            {/* Trigger marker */}
            <span
              className="absolute top-0 bottom-0 w-0.5 bg-destructive/60"
              style={{ left: '85%' }}
            />
          </div>
          <div className="flex justify-between text-[9px] text-foreground/70">
            <span>{fmtTok(Math.round(maxTokens * compactPct))}</span>
            <span className="text-destructive/70">{fmtTok(triggerAt)}</span>
          </div>
        </div>

        <MetricRow label={t('activity:ctxDash.nextTrigger')} value={`${fmtTok(triggerAt)} (85%)`} />
        <div className="flex items-center justify-between text-xs py-0.5">
          <span className="text-muted-foreground">{t('activity:ctxDash.estRecovery')}</span>
          <span className="tabular-nums font-mono font-semibold px-1.5 py-0.5 rounded text-success bg-success/10">
            ~{fmtTok(recoveryEst)}
          </span>
        </div>
        <MetricRow
          label={t('activity:ctxDash.recommendation')}
          value={needsCompact ? '⚠️ Compact now' : '✅ No compaction needed'}
          color={needsCompact ? 'text-warning' : 'text-success'}
        />
        {needsCompact && (
          <div className="bg-warning/5 border border-warning/20 rounded p-2 text-[10px] text-warning/90 mt-1">
            Context at {pct.toFixed(1)}% — compacting recovers ~{fmtTok(recoveryEst)} tokens.
          </div>
        )}
      </div>
    </SectionCard>
  );
}

function AgentFootprintSection({ agents }: { agents: SubagentView[] }) {
  const { t } = useAppTranslation();
  const agentsWithCtx = agents.filter((a) => a.ctxPct != null && a.ctxPct > 0);
  // Agent footprints are bounded (active agents), show all without pagination.
  if (agentsWithCtx.length === 0) return null;

  return (
    <SectionCard title={t('activity:ctxDash.perAgentFootprint')} icon={Users}>
      <div className="space-y-2">
        {agentsWithCtx.map((agent) => {
          const zone = zoneFor(agent.ctxPct);
          const label = agent.name || agent.id;
          const isLeader = agent.id === '__leader__';
          return (
            <div key={agent.id} className="flex items-center gap-2 text-xs">
              <span className="w-4">{isLeader ? '👑' : '  '}</span>
              <span className="w-24 truncate font-mono text-muted-foreground" title={label}>
                {label}
              </span>
              <div className="flex-1 max-w-[200px]">
                <ContextFillBar
                  pct={Math.round(agent.ctxPct)}
                  tokens={agent.ctxTokens}
                  maxTokens={agent.maxContext}
                  showTokens={false}
                />
              </div>
              <span className={cn('tabular-nums w-10 text-right', zone.color)}>
                {Math.round(agent.ctxPct)}%
              </span>
            </div>
          );
        })}
      </div>
    </SectionCard>
  );
}

function MetricsSection({
  tokens,
  maxTokens,
  pct,
  model,
  provider,
  mode,
  uptime,
  iteration,
  contextMode,
}: {
  tokens: number;
  maxTokens: number;
  pct: number;
  model: string;
  provider: string;
  mode: string;
  uptime: string;
  iteration: string;
  contextMode: string;
}) {
  const { t } = useAppTranslation();
  const free = maxTokens - tokens;
  const freePct = maxTokens > 0 ? ((free / maxTokens) * 100).toFixed(1) : '0.0';

  return (
    <SectionCard title={t('activity:ctxDash.tokenMetrics')} icon={BarChart3}>
      <div className="space-y-1 text-xs">
        <MetricRow label={t('activity:ctxDash.used')} value={fmtTok(tokens)} />
        <MetricRow label={t('activity:ctxDash.free')} value={`${fmtTok(free)} (${freePct}%)`} />
        <MetricRow label={t('activity:ctxDash.capacity')} value={fmtTok(maxTokens)} />
        <div className="flex items-center gap-2 pt-1">
          <span className="text-muted-foreground text-xs">{t('activity:ctxDash.utilization')}</span>
          <div className="flex-1 max-w-[200px]">
            <ContextFillBar pct={Math.round(pct)} tokens={tokens} maxTokens={maxTokens} />
          </div>
        </div>
        <div className="border-t border-border/50 pt-1 mt-1" />
        <MetricRow label={t('activity:ctxDash.model')} value={`${model} · ${provider}`} />
        <MetricRow label={t('activity:ctxDash.mode')} value={mode} />
        <MetricRow label={t('activity:ctxDash.contextMode')} value={contextMode} />
        <MetricRow label={t('activity:ctxDash.iteration')} value={iteration} />
        <MetricRow label={t('activity:ctxDash.uptime')} value={uptime} />
      </div>
    </SectionCard>
  );
}

function SessionSection({
  model,
  provider,
  mode,
  uptime,
  projectName,
  cwd,
  contextMode,
}: {
  model: string;
  provider: string;
  mode: string;
  uptime: string;
  projectName: string;
  cwd: string;
  contextMode: string;
}) {
  const { t } = useAppTranslation();
  return (
    <SectionCard title={t('activity:ctxDash.session')} icon={Cpu}>
      <div className="space-y-1 text-xs">
        <MetricRow label={t('activity:ctxDash.provider')} value={provider} />
        <MetricRow label={t('activity:ctxDash.model')} value={model} />
        <MetricRow label={t('activity:ctxDash.mode')} value={mode} />
        <MetricRow label={t('activity:ctxDash.contextMode')} value={contextMode} />
        <MetricRow label={t('activity:ctxDash.project')} value={projectName || cwd} />
        <MetricRow label={t('activity:ctxDash.uptime')} value={uptime} />
      </div>
    </SectionCard>
  );
}

// ── Main component ────────────────────────────────────────────────────

export function ContextDashboard() {
  const { t } = useAppTranslation();
  const setCurrentView = useUIStore((s) => s.setCurrentView);

  // Session data
  const {
    lastInputTokens,
    maxContext,
    mode,
    contextMode,
    startTime,
    session,
    iteration,
    projectName,
    cwd,
  } = useSessionStore(
    useShallow((s) => ({
      lastInputTokens: s.lastInputTokens,
      maxContext: s.maxContext,
      mode: s.mode,
      contextMode: s.contextMode,
      startTime: s.startTime,
      session: s.session,
      iteration: s.iteration,
      projectName: s.projectName,
      cwd: s.cwd,
    })),
  );

  // Fleet data — useShallow stabilizes derived array reference
  // Session-scoped: this dashboard describes THIS tab's context window, so
  // the footprint must not count other tabs' agents — their tokens and cost
  // belong to their own sessions' dashboards.
  const activeSessionId = useActiveSessionId();
  const fleetAgents = useFleetStore(
    useShallow((s) =>
      [...s.agents.values()].filter((a) => agentBelongsToSession(a.sessionId, activeSessionId)),
    ),
  );

  // Debug data from context.debug WS
  const wsUrl = useConfigStore((s) => s.wsUrl);
  const [debugData, setDebugData] = useState<ContextDebugPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [debugError, setDebugError] = useState<string | null>(null);
  const debugGenRef = useRef(0);
  const debugUnsubRef = useRef<(() => void) | null>(null);

  const fetchDebug = () => {
    // Clean up any previous in-flight request to prevent listener leaks
    // when the user clicks refresh multiple times in rapid succession.
    debugUnsubRef.current?.();
    debugUnsubRef.current = null;

    const ws = getWSClient(wsUrl);
    if (!ws?.send) {
      setDebugError('WebSocket not connected');
      return;
    }
    const gen = ++debugGenRef.current;
    setLoading(true);
    setDebugError(null);

    // Addressed at the tab on screen. Unaddressed, the server answers from
    // whichever session it is pointing at, so this panel showed another tab's
    // breakdown — and a reply meant for another tab overwrote it.
    const askedFor = ws.withSession({}).sessionId;
    ws.send({ type: 'context.debug', payload: ws.withSession({}) }, { echoToChat: false });
    // Cancelled flag prevents the timeout from overwriting a successful response
    // and the response handler from acting on a stale timeout. The first
    // completion (response or timeout) sets it; the other becomes a no-op.
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const handler = (msg: { type: string; payload?: unknown }) => {
      if (cancelled) return;
      if (msg.type !== 'context.debug') return;
      if (debugGenRef.current !== gen) return;
      const replyFor = (msg.payload as { sessionId?: string } | undefined)?.sessionId;
      if (askedFor !== undefined && replyFor !== undefined && replyFor !== askedFor) return;
      cancelled = true;
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      setDebugData(msg.payload as ContextDebugPayload);
      setLoading(false);
      unsub();
    };
    const unsub = ws.on('context.debug', handler);
    debugUnsubRef.current = unsub;

    timeoutId = setTimeout(() => {
      if (cancelled) return;
      cancelled = true;
      if (debugGenRef.current === gen) {
        setLoading(false);
        setDebugError('No response from server');
        unsub();
      }
    }, 5000);
  };

  // Refetch when the foreground moves, not only when the socket changes: the
  // panel is not unmounted between tabs, so without this it kept showing the
  // previous tab's breakdown until the user pressed refresh.
  const debugSessionId = activeSessionId;
  useEffect(() => {
    setDebugData(null);
    fetchDebug();
    return () => {
      // Invalidate any in-flight request and clean up the WS listener
      // so stale state mutations cannot reach unmounted components.
      debugGenRef.current++;
      debugUnsubRef.current?.();
      debugUnsubRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsUrl, debugSessionId]);

  // Derived values
  const model = session?.model ?? '—';
  const provider = session?.provider ?? '—';
  const pct = maxContext > 0 ? Math.min(100, (lastInputTokens / maxContext) * 100) : 0;
  const uptime = fmtDuration(startTime);
  const iterText = iteration ? `${iteration.index} / ${iteration.max}` : '—';
  const zone = zoneFor(pct);

  // Stagger entrance animation indices for section cards
  const staggerDelay = (i: number) => ({
    animation: `fadeInUp 0.4s ease-out ${i * 0.08}s both`,
  });

  return (
    <div
      ref={useScrollPosition('context')}
      className="flex-1 min-h-0 overflow-y-auto overscroll-contain"
    >
      {/* Inject fadeInUp keyframes once */}
      <style>{`
        @keyframes fadeInUp {
          from { opacity: 0; transform: translateY(12px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
      {/* Header bar */}
      <div className={cn('sticky top-0 z-10 flex items-center gap-3 px-4 py-2 border-b', zone.bg)}>
        <Button
          variant="ghost"
          size="icon"
          className="shrink-0"
          onClick={() => setCurrentView('chat')}
          aria-label={t('common:action.back')}
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-lg">{zone.emoji}</span>
          <Sparkles className="h-3.5 w-3.5 text-primary/60" />
          <h1 className="text-sm font-semibold">{t('activity:ctxDash.contextDashboard')}</h1>
          <span
            className={cn('text-[10px] font-mono px-1.5 py-0.5 rounded-full', zone.bg, zone.text)}
          >
            {t(zone.labelKey)}
          </span>
        </div>
        <div className="flex-1" />
        <button
          type="button"
          onClick={fetchDebug}
          className="p-1 rounded hover:bg-accent transition-colors"
          title={t('activity:ctxDash.refreshDebugData')}
        >
          <RefreshCw
            className={cn('h-3.5 w-3.5 text-muted-foreground', loading && 'animate-spin')}
          />
        </button>
      </div>

      {/* Dashboard grid */}
      <div className="p-4 space-y-4">
        {/* Top row: session + pressure */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4" style={staggerDelay(0)}>
          <div className="lg:col-span-2">
            <PressureSection pct={pct} tokens={lastInputTokens} maxTokens={maxContext} />
          </div>
          <div style={staggerDelay(1)}>
            <SessionSection
              model={model}
              provider={provider}
              mode={mode}
              uptime={uptime}
              projectName={projectName ?? ''}
              cwd={cwd ?? ''}
              contextMode={contextMode}
            />
          </div>
        </div>

        {/* Middle row: composition + threshold + compaction */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4" style={staggerDelay(2)}>
          <CompositionSection data={debugData} loading={loading} />
          <ThresholdSection pct={pct} />
          <CompactionSection pct={pct} maxTokens={maxContext || 200_000} />
        </div>

        {/* Fleet footprint */}
        <div style={staggerDelay(3)}>
          <AgentFootprintSection agents={fleetAgents} />
        </div>

        <div style={staggerDelay(4)}>
          <ContextMemoryMonitor />
        </div>
        <div style={staggerDelay(5)}>
          <MemoryLifecycleTrace />
        </div>

        {/* Bottom row: metrics */}
        <div style={staggerDelay(6)}>
          <MetricsSection
            tokens={lastInputTokens}
            maxTokens={maxContext || 200_000}
            pct={pct}
            model={model}
            provider={provider}
            mode={mode}
            uptime={uptime}
            iteration={iterText}
            contextMode={contextMode}
          />
        </div>

        {/* Error banner */}
        {debugError && (
          <div
            className="rounded-md bg-destructive/10 border border-destructive/20 p-3 text-xs text-destructive"
            style={staggerDelay(7)}
          >
            {debugError}
          </div>
        )}
      </div>
    </div>
  );
}
