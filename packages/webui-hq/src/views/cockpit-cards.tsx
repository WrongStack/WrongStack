/** Cockpit building blocks: the jump-to card frame, hero metrics and the small read-out cards. */
import type { HqCommandLatencySummary, HqSnapshot } from '@wrongstack/hq';
import { ArrowUpRight, type LucideIcon } from 'lucide-react';
import type * as React from 'react';
import { EmptyState, Mono, StatTile } from '../components/hq/primitives.js';
import type { BadgeTone } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '../components/ui/card.js';
import { type HqViewId, useHqStore } from '../data/store/index.js';
import type { HqTone } from '../domain/status-tone.js';
import { cn } from '../lib/utils.js';

export function alertTone(severity: string): BadgeTone {
  if (severity === 'critical' || severity === 'error' || severity === 'high') return 'error';
  if (severity === 'warn' || severity === 'warning' || severity === 'medium') return 'warn';
  if (severity === 'info' || severity === 'low') return 'info';
  return 'idle';
}

/**
 * W4 #7/#19 — render a latency percentile at the precision an operator can act
 * on. `undefined` means "no acked sample carried both timestamps", which is not
 * the same as 0 ms and must not read as a healthy zero.
 */
function formatLatencyMs(ms: number | undefined): string {
  if (ms === undefined) return '—';
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`;
}

/**
 * W4 #7/#19 — the command-plane `dispatched -> acknowledged` percentile
 * read-out.
 *
 * Extracted from the Cockpit grid so it can be tested without mounting the
 * whole dashboard, and so the "no samples" case has exactly one rendering: an
 * unacked command has no latency, and showing `0 ms` for it would read as a
 * perfectly healthy round-trip. `sampleCount === 0` therefore renders the empty
 * state, not a zeroed row.
 */
export function CommandLatencyCard({
  latency,
}: {
  latency: HqCommandLatencySummary | undefined;
}): React.ReactElement {
  if (latency === undefined || latency.sampleCount === 0) {
    return (
      <EmptyState
        title="No acknowledged commands yet"
        hint="Latency appears once a dispatched command is acknowledged."
      />
    );
  }
  return (
    <div className="space-y-2">
      <div className="flex items-baseline gap-3 text-xs">
        <span className="text-muted-foreground">p50</span>
        <Mono className="tabular font-semibold">{formatLatencyMs(latency.p50Ms)}</Mono>
        <span className="text-muted-foreground">p95</span>
        <Mono className="tabular font-semibold">{formatLatencyMs(latency.p95Ms)}</Mono>
        <span className="text-muted-foreground">p99</span>
        <Mono className="tabular font-semibold">{formatLatencyMs(latency.p99Ms)}</Mono>
      </div>
      <div className="flex gap-3 text-[10px] text-muted-foreground">
        <span>{latency.sampleCount} acked</span>
        <span>max {formatLatencyMs(latency.maxMs)}</span>
      </div>
    </div>
  );
}

export function CockpitCard({
  icon: Icon,
  title,
  cta,
  view,
  tone,
  className,
  children,
}: {
  icon: LucideIcon;
  title: string;
  cta: string;
  view: HqViewId;
  tone?: 'attention' | 'positive';
  className?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <Card
      data-testid="cockpit-card"
      data-tone={tone}
      className={cn(tone === 'attention' && 'border-warning/50', className)}
    >
      <CardHeader>
        <Icon />
        <CardTitle>{title}</CardTitle>
        <CardAction>
          <Button
            variant="ghost"
            size="sm"
            className="text-[11px] text-muted-foreground"
            onClick={() => useHqStore.getState().setActiveView(view)}
          >
            {cta}
            <ArrowUpRight className="size-3" />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

export function HeroMetric({
  icon: Icon,
  label,
  value,
  detail,
  tone = 'idle',
}: {
  icon: LucideIcon;
  label: string;
  value: string | number;
  detail: string;
  tone?: HqTone;
}): React.ReactElement {
  return (
    <div className="flex min-w-32 flex-col gap-0.5">
      <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.09em] text-muted-foreground">
        <Icon className="size-3" />
        {label}
      </span>
      <span
        className={cn(
          'tabular font-display text-2xl leading-none',
          tone === 'error'
            ? 'text-destructive'
            : tone === 'warn'
              ? 'text-warning'
              : tone === 'active'
                ? 'text-success'
                : 'text-foreground',
        )}
      >
        {value}
      </span>
      <span className="text-[10px] text-muted-foreground">{detail}</span>
    </div>
  );
}

export function TokenStats({
  tokenStats,
}: {
  tokenStats: NonNullable<HqSnapshot['totals']['tokenStats']> | undefined;
}): React.ReactElement {
  // Absent on older snapshots — an additive field. Show a placeholder rather
  // than zeros, so "no data yet" is distinguishable from "zero tokens issued".
  if (tokenStats === undefined) {
    return <EmptyState title="Token stats unavailable on this HQ version" />;
  }
  const { browserTotal, clientTotal, expired, expiringSoon } = tokenStats;
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-3">
      <StatTile label="browser" value={browserTotal} />
      <StatTile label="client" value={clientTotal} />
      <StatTile label="total" value={browserTotal + clientTotal} />
      <StatTile label="expired" value={expired} tone={expired > 0 ? 'error' : 'idle'} />
      <StatTile
        label="expiring soon"
        value={expiringSoon}
        tone={expiringSoon > 0 ? 'warn' : 'idle'}
      />
    </div>
  );
}
