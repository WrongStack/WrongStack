import type { ContextBreakdown } from '@wrongstack/core/agent';
import type { ReactElement } from 'react';
import { useCallback, useMemo, useState } from 'react';
import { fmtTok } from '@/components/ChatView/utils';
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import type { PriceCliffSummary } from '@/types';

/**
 * The Context X-Ray — item-by-item occupancy of the context window.
 *
 * Fed by core's canonical accounting (`getContextBreakdown`), the same numbers
 * the CLI `/context` report and the TUI bar render, so no surface disagrees
 * about what is costing tokens. The bar shows where the long-context PRICE CLIFF
 * sits and, more importantly, where compaction actually fires —
 * `min(threshold x window, cliff)` — which is the money the cliff cap saves.
 *
 * Section names (`skills`, `project-instructions`, `mcp:<server>`) are data
 * labels from the prompt builder and the tool registry, shown as-is like the
 * terminal report does; the chrome around them is translated.
 */

interface ContextXRayProps {
  xray?: ContextBreakdown | undefined;
  cliff?: PriceCliffSummary | undefined;
  /** Active model window; falls back to the snapshot's own denominator. */
  maxContext?: number | undefined;
  className?: string | undefined;
}

type SectionId = 'system' | 'tools' | 'history' | 'volatile';

interface Row {
  label: string;
  tokens: number;
}

interface Section {
  id: SectionId;
  label: string;
  tokens: number;
  rows: Row[];
  count?: string | undefined;
}

const SECTION_COLORS: Record<SectionId, string> = {
  system: 'hsl(var(--info))',
  tools: 'hsl(var(--warning))',
  history: 'hsl(var(--success))',
  volatile: 'hsl(var(--destructive))',
};

function num(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** `project-instructions` → `project instructions`; keeps unknown ids verbatim. */
function humanize(id: string): string {
  return id.replace(/[-_]/g, ' ').trim();
}

export function ContextXRay({
  xray,
  cliff,
  maxContext,
  className,
}: ContextXRayProps): ReactElement | null {
  const { t } = useAppTranslation();
  const [open, setOpen] = useState<SectionId | null>(null);
  const toggle = useCallback((id: SectionId) => {
    setOpen((current) => (current === id ? null : id));
  }, []);

  const window = num(xray?.effectiveMaxContext) || num(maxContext);

  const sections = useMemo<Section[]>(() => {
    if (!xray) return [];
    const positive = (rows: Row[]): Row[] => rows.filter((r) => r.tokens > 0);

    const systemRows = positive(
      Object.entries(xray.system.bySource ?? {}).map(([source, tokens]) => ({
        label: humanize(source),
        tokens: num(tokens),
      })),
    );
    const toolRows = positive([
      { label: t('activity:ctxXray.builtin'), tokens: num(xray.tools.builtin) },
      { label: t('activity:ctxXray.mcpServers'), tokens: num(xray.tools.mcp) },
      ...Object.entries(xray.tools.mcpByServer ?? {}).map(([server, tokens]) => ({
        label: `mcp:${server}`,
        tokens: num(tokens),
      })),
    ]);
    const historyRows = positive([
      { label: t('activity:ctxXray.text'), tokens: num(xray.history.text) },
      { label: t('activity:ctxXray.toolInputs'), tokens: num(xray.history.toolInputs) },
      { label: t('activity:ctxXray.fileOutputs'), tokens: num(xray.history.toolResults) },
      { label: t('activity:ctxXray.thinking'), tokens: num(xray.history.thinking) },
      { label: t('activity:ctxXray.other'), tokens: num(xray.history.other) },
    ]);
    const volatileRows = positive([
      { label: t('activity:ctxXray.ledger'), tokens: num(xray.volatile.ledger) },
      { label: t('activity:ctxXray.nextSteps'), tokens: num(xray.volatile.nextsteps) },
      { label: t('activity:ctxXray.continuity'), tokens: num(xray.volatile.continuity) },
      { label: t('activity:ctxXray.memory'), tokens: num(xray.volatile.memoryEvidence) },
    ]);

    return (
      [
        {
          id: 'system' as const,
          label: t('activity:ctxDash.systemPrompt'),
          tokens: num(xray.system.total),
          rows: systemRows,
        },
        {
          id: 'tools' as const,
          label: t('activity:ctxDash.tools'),
          tokens: num(xray.tools.total),
          rows: toolRows,
          count: `${xray.tools.count}`,
        },
        {
          id: 'history' as const,
          label: t('activity:ctxDash.messages'),
          tokens: num(xray.history.total),
          rows: historyRows,
          count: `${xray.history.messageCount}`,
        },
        {
          id: 'volatile' as const,
          label: t('activity:ctxXray.volatile'),
          tokens: num(xray.volatile.total),
          rows: volatileRows,
        },
      ] satisfies Section[]
    ).filter((s) => s.tokens > 0);
  }, [xray, t]);

  if (!xray || window <= 0 || sections.length === 0) return null;

  const total = num(xray.total);
  const pct = (tokens: number): string => `${((tokens / window) * 100).toFixed(1)}%`;

  // The unaccounted remainder is the output + safety reserve the budget keeps
  // back; drawing it makes the bar reach the full window honestly instead of
  // silently under-reporting it.
  const accounted = sections.reduce((sum, s) => sum + s.tokens, 0);
  const remainder = Math.max(0, window - accounted);

  return (
    <section className={cn('space-y-2', className)}>
      <div className="flex items-center gap-2">
        <span className="text-xs font-bold uppercase tracking-wider text-foreground/80">
          {t('activity:ctxXray.title')}
        </span>
        <span className="ml-auto font-mono text-[10px] tabular-nums text-muted-foreground">
          {fmtTok(total)} / {fmtTok(window)} · {pct(total)}
        </span>
      </div>

      {/* Stacked occupancy bar with the cliff and the capped trigger. */}
      <div
        className="relative h-4 w-full overflow-hidden rounded-full bg-muted/50 ring-1 ring-inset ring-border/20"
        role="img"
        aria-label={t('activity:ctxXray.barAria', { used: fmtTok(total), window: fmtTok(window) })}
      >
        <div className="flex h-full w-full">
          {sections.map((s) => (
            <div
              key={s.id}
              className="h-full transition-[width,opacity] duration-700 ease-out"
              style={{
                width: `${Math.max(0.5, (s.tokens / window) * 100)}%`,
                backgroundColor: SECTION_COLORS[s.id],
                opacity: open && open !== s.id ? 0.35 : 1,
              }}
              title={`${s.label} · ${fmtTok(s.tokens)}`}
            />
          ))}
          <div
            className="h-full transition-[width] duration-700 ease-out bg-muted"
            style={{ width: `${(remainder / window) * 100}%` }}
            title={`${t('activity:ctxDash.free')} · ${fmtTok(remainder)}`}
          />
        </div>
        {cliff && (
          <span
            className="absolute inset-y-0 w-px bg-foreground/70"
            style={{ left: `${Math.min(100, (cliff.triggerTokens / window) * 100)}%` }}
            aria-hidden
          />
        )}
        {cliff && (
          <span
            className="absolute inset-y-0 w-0.5 bg-destructive"
            style={{ left: `${Math.min(100, (cliff.cliffTokens / window) * 100)}%` }}
            aria-hidden
          />
        )}
      </div>

      {cliff && (
        <p className="text-[10px] leading-relaxed text-muted-foreground">
          <span className="mr-1 inline-block h-2 w-0.5 bg-destructive align-middle" aria-hidden />
          {t('activity:ctxXray.cliff', { cliff: fmtTok(cliff.cliffTokens) })}
          {typeof cliff.multiplier === 'number' && cliff.multiplier > 1
            ? ` · ${cliff.multiplier.toFixed(2)}x ${cliff.field ?? 'input'}`
            : ''}
          <br />
          <span className="mr-1 inline-block h-2 w-px bg-foreground/70 align-middle" aria-hidden />
          {t('activity:ctxXray.firesAt', {
            trigger: fmtTok(cliff.triggerTokens),
            uncapped: fmtTok(cliff.uncappedTriggerTokens),
          })}
        </p>
      )}

      {/* Item-by-item rows: click a section to see what inside it costs tokens. */}
      <ul className="space-y-1">
        {sections.map((s) => (
          <li key={s.id}>
            <button
              type="button"
              onClick={() => toggle(s.id)}
              aria-expanded={open === s.id}
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[11px]',
                'transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                open === s.id && 'bg-muted/60',
              )}
            >
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-sm"
                style={{ backgroundColor: SECTION_COLORS[s.id] }}
                aria-hidden
              />
              <span className="font-medium text-foreground/90">{s.label}</span>
              {s.count && <span className="text-[10px] text-muted-foreground">({s.count})</span>}
              <span className="ml-auto font-mono text-muted-foreground tabular-nums">
                {fmtTok(s.tokens)} · {pct(s.tokens)}
              </span>
            </button>
            {open === s.id && s.rows.length > 0 && (
              <ul className="mt-0.5 space-y-0.5 pl-6">
                {s.rows.map((row) => (
                  <li
                    key={`${s.id}-${row.label}`}
                    className="flex items-center gap-2 text-[10px] text-muted-foreground"
                  >
                    <span className="truncate">{row.label}</span>
                    <span className="ml-auto shrink-0 font-mono tabular-nums">
                      {fmtTok(row.tokens)} · {pct(row.tokens)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
