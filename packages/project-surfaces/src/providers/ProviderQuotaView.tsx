import { EmptyState } from '../ui/empty-state';
import { PageMotif } from '../ui/PageMotif';
/**
 * Plan Quota — every metered account on one wide page.
 *
 * The chat side panel shows only the quota the running work draws on; this is
 * the whole picture: subscription plans (ChatGPT/Codex, MiniMax, Z.AI, Kimi
 * Code, OpenCode Go, OpenRouter, any configured `quotaEndpoint`), every
 * account in an OmniRoute gateway's pool as its own card, and the prepaid
 * balances (DeepSeek, Moonshot, SiliconFlow). What the open sessions and
 * running subagents draw on is lifted to the top and marked.
 *
 * Readings come from the shared quota feed — account reads, never model
 * calls — refreshed on open, every few minutes while open, and on demand.
 */

import { AlertTriangle, ArrowLeft, Clock, Gauge, Layers, RefreshCw, Search } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import { useAppTranslation } from '../lib/i18n';
import { cn } from '../lib/utils';
import { Button } from '../ui/button';
import { useProviderHost } from './feed';
import { formatQuotaResetIn } from './provider-quota-store';
import { type QuotaPageEntry, quotaPageSections } from './quota-model';
import { QuotaCardView } from './quota-parts';
import { useQuotaFeed } from './use-quota-feed';

function SummaryTile({
  icon,
  label,
  value,
  hint,
  tone,
}: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  hint?: string | undefined;
  tone?: 'warn' | 'critical' | undefined;
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-card/65 px-3 py-2.5 shadow-sm">
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        {icon}
        {label}
      </div>
      <div
        className={cn(
          'mt-1 text-xl font-semibold tabular-nums',
          tone === 'critical' && 'text-destructive',
          tone === 'warn' && 'text-warning',
        )}
      >
        {value}
      </div>
      {hint && <div className="truncate text-[11px] text-muted-foreground/80">{hint}</div>}
    </div>
  );
}

function Section({
  title,
  hint,
  entries,
  now,
}: {
  title: string;
  hint?: string | undefined;
  entries: QuotaPageEntry[];
  now: number;
}) {
  if (entries.length === 0) return null;
  return (
    <section className="space-y-2" aria-label={title}>
      <div className="flex items-baseline gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        <span className="text-xs tabular-nums text-muted-foreground">{entries.length}</span>
      </div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {entries.map((entry) => (
          <QuotaCardView
            key={entry.key}
            card={entry.card}
            now={now}
            variant="roomy"
            title={entry.title}
            subtitle={entry.subtitle}
            inUse={entry.inUse}
          />
        ))}
      </div>
    </section>
  );
}

export function ProviderQuotaView() {
  const { t } = useAppTranslation();
  const { cards, now, refreshing, refresh, wsConnected } = useQuotaFeed();
  const host = useProviderHost();
  const inUse = host.useModelsInUse();
  const [query, setQuery] = useState('');
  const [attentionOnly, setAttentionOnly] = useState(false);
  const sections = useMemo(
    () => quotaPageSections(cards, inUse, { query, attentionOnly }),
    [cards, inUse, query, attentionOnly],
  );
  const { summary } = sections;
  const shown =
    sections.inUse.length + sections.plans.length + sections.pool.length + sections.balances.length;
  const relief = summary.nextRelief;
  const reliefIn = relief
    ? formatQuotaResetIn({ id: '', usedPercent: 0, resetsAt: relief.resetsAt }, now)
    : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="ws-page-header flex shrink-0 items-center gap-3 border-b border-border/70">
        <PageMotif kind="chart" />
        <span className="ws-page-icon flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Gauge className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="">{t('activity:quotaPage.title')}</h1>
          <p className="truncate text-xs text-muted-foreground">
            {t('activity:quotaPage.subtitle')}
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={refresh}
          disabled={!wsConnected || refreshing}
          title={t('activity:quotaPanel.refreshTitle')}
          aria-label={t('activity:quotaPanel.refresh')}
        >
          <RefreshCw className={cn('h-4 w-4 sm:mr-1.5', refreshing && 'animate-spin')} />
          <span className="hidden sm:inline">{t('activity:quotaPanel.refresh')}</span>
        </Button>
        {host.back && (
          <Button
            variant="ghost"
            size="icon"
            onClick={host.back}
            aria-label={t('activity:quotaPage.close')}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-7xl space-y-6 p-4 sm:p-6">
          {cards.length === 0 ? (
            <EmptyState
              icon={<Gauge />}
              title={t('activity:quotaPanel.none')}
              panel={false}
              className="min-h-60 rounded-2xl border border-dashed border-border/70"
            />
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <SummaryTile
                  icon={<Layers className="h-3.5 w-3.5" />}
                  label={t('activity:quotaPage.summary.accounts')}
                  value={summary.accounts}
                />
                <SummaryTile
                  icon={<AlertTriangle className="h-3.5 w-3.5" />}
                  label={t('activity:quotaPage.summary.warn')}
                  value={summary.warn}
                  tone={summary.warn > 0 ? 'warn' : undefined}
                />
                <SummaryTile
                  icon={<AlertTriangle className="h-3.5 w-3.5" />}
                  label={t('activity:quotaPage.summary.critical')}
                  value={summary.critical}
                  tone={summary.critical > 0 ? 'critical' : undefined}
                />
                <SummaryTile
                  icon={<Clock className="h-3.5 w-3.5" />}
                  label={t('activity:quotaPage.summary.nextRelief')}
                  value={reliefIn ?? '—'}
                  hint={
                    relief
                      ? (relief.entry.title ?? relief.entry.card.aliases.join(', '))
                      : undefined
                  }
                />
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <div className="relative min-w-[12rem] flex-1 sm:max-w-sm">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                  <input
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={t('activity:quotaPage.search')}
                    aria-label={t('activity:quotaPage.search')}
                    className="h-8 w-full rounded-md border border-border/70 bg-background pl-8 pr-2 text-xs outline-none focus:border-primary/60"
                  />
                </div>
                <button
                  type="button"
                  aria-pressed={attentionOnly}
                  onClick={() => setAttentionOnly((v) => !v)}
                  className={cn(
                    'h-8 rounded-md border px-3 text-xs',
                    attentionOnly
                      ? 'border-warning/60 bg-warning/10 text-warning'
                      : 'border-border/70 text-muted-foreground hover:text-foreground',
                  )}
                >
                  {t('activity:quotaPage.attentionOnly')}
                </button>
              </div>

              {shown === 0 ? (
                <div className="rounded-lg border border-dashed border-border/70 p-6 text-center text-sm text-muted-foreground">
                  {t('activity:quotaPage.noMatch')}
                </div>
              ) : (
                <>
                  <Section
                    title={t('activity:quotaPage.sections.inUse')}
                    hint={t('activity:quotaPage.sections.inUseHint')}
                    entries={sections.inUse}
                    now={now}
                  />
                  <Section
                    title={t('activity:quotaPage.sections.plans')}
                    entries={sections.plans}
                    now={now}
                  />
                  <Section
                    title={t('activity:quotaPage.sections.pool')}
                    hint={t('activity:quotaPage.sections.poolHint')}
                    entries={sections.pool}
                    now={now}
                  />
                  <Section
                    title={t('activity:quotaPage.sections.balances')}
                    entries={sections.balances}
                    now={now}
                  />
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
