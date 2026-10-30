import type { HistoryRetention, RequestResidency } from '@wrongstack/core/utils/residency-labels';
import {
  AlertTriangle,
  BarChart3,
  Cpu,
  FileText,
  Gauge,
  HardDrive,
  Layers,
  MessageSquare,
  RefreshCw,
  Users,
  Wrench,
} from 'lucide-react';
import { ContextBar, ContextFillBar } from '@/components/ContextBar';
import { fmtTok } from '@/components/dashboard-primitives';
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import type { SubagentView } from '@/stores';
import {
  AnimatedCounter,
  AnimatedDonutGauge,
  MetricRow,
  SectionCard,
  ZONES,
  zoneFor,
} from './context-dashboard-primitives.js';

export { fmtDuration, zoneFor } from './context-dashboard-primitives.js';

// ── Types ────────────────────────────────────────────────────────────

export interface ContextDebugPayload {
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
  residency?: RequestResidency | undefined;
  retention?: HistoryRetention | undefined;
}

// ── Section components ────────────────────────────────────────────────

export function PressureSection({
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
      <div className="relative h-8 mt-1">
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
        <div className="absolute top-3 flex w-full justify-between gap-1 text-[10px] text-muted-foreground">
          <span>0%</span>
          <span>soft</span>
          <span>hard</span>
          <span>max</span>
          <span>100%</span>
        </div>
      </div>

      {/* Current position marker */}
      <div className="relative h-5 mt-1">
        <div
          className="absolute top-0 -translate-x-1/2 flex flex-col items-center transition-all duration-500"
          style={{ left: `${Math.max(5, Math.min(95, pct))}%` }}
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

export function CompositionSection({
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

export function ThresholdSection({ pct }: { pct: number }) {
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

export function CompactionSection({ pct, maxTokens }: { pct: number; maxTokens: number }) {
  const { t } = useAppTranslation();
  const recoveryEst = Math.round(maxTokens * 0.18);
  const triggerAt = Math.round(maxTokens * 0.85);
  const needsCompact = pct > 65;
  const compactPct = maxTokens > 0 ? pct / 100 : 0;
  // 0 = the window is unknown; show that instead of numbers derived from it.
  const fmtCap = (n: number): string => (maxTokens > 0 ? fmtTok(n) : '—');

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
            <span>Trigger ({fmtCap(triggerAt)})</span>
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
            <span>{fmtCap(Math.round(maxTokens * compactPct))}</span>
            <span className="text-destructive/70">{fmtCap(triggerAt)}</span>
          </div>
        </div>

        <MetricRow
          label={t('activity:ctxDash.nextTrigger')}
          value={maxTokens > 0 ? `${fmtTok(triggerAt)} (85%)` : '—'}
        />
        <div className="flex items-center justify-between text-xs py-0.5">
          <span className="text-muted-foreground">{t('activity:ctxDash.estRecovery')}</span>
          <span className="tabular-nums font-mono font-semibold px-1.5 py-0.5 rounded text-success bg-success/10">
            {maxTokens > 0 ? `~${fmtTok(recoveryEst)}` : '—'}
          </span>
        </div>
        <MetricRow
          label={t('activity:ctxDash.recommendation')}
          value={needsCompact ? '⚠️ Compact now' : '✅ No compaction needed'}
          color={needsCompact ? 'text-warning' : 'text-success'}
        />
        {needsCompact && (
          <div className="bg-warning/5 border border-warning/20 rounded p-2 text-[10px] text-warning/90 mt-1">
            Context at {pct.toFixed(1)}% — compacting recovers ~{fmtCap(recoveryEst)} tokens.
          </div>
        )}
      </div>
    </SectionCard>
  );
}

export function AgentFootprintSection({ agents }: { agents: SubagentView[] }) {
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

export function MetricsSection({
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
  const free = maxTokens > 0 ? maxTokens - tokens : 0;
  const freePct = maxTokens > 0 ? ((free / maxTokens) * 100).toFixed(1) : '0.0';

  return (
    <SectionCard title={t('activity:ctxDash.tokenMetrics')} icon={BarChart3}>
      <div className="space-y-1 text-xs">
        <MetricRow label={t('activity:ctxDash.used')} value={fmtTok(tokens)} />
        <MetricRow
          label={t('activity:ctxDash.free')}
          value={maxTokens > 0 ? `${fmtTok(free)} (${freePct}%)` : '—'}
        />
        <MetricRow
          label={t('activity:ctxDash.capacity')}
          value={maxTokens > 0 ? fmtTok(maxTokens) : '—'}
        />
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

export function SessionSection({
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
