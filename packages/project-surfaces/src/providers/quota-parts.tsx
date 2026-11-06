/**
 * Quota card pieces shared by the side-panel section (`compact`) and the Plan
 * Quota page (`roomy`): a window row with its bar, reset and pace, a meter's
 * body, and the card around them.
 */

import { displayLocale, useAppTranslation } from '../lib/i18n';
import { cn } from '../lib/utils';
import {
  formatQuotaResetIn,
  type QuotaSnapshot,
  type QuotaWindow,
  quotaWindowLabel,
  useProviderQuotaStore,
} from './provider-quota-store';
import { cardSubtitle, cardTitle, type QuotaCard, quotaLevel } from './quota-model';

export type QuotaVariant = 'compact' | 'roomy';

const LEVEL_TONE = {
  critical: { bar: 'bg-destructive', text: 'text-destructive' },
  warn: { bar: 'bg-warning', text: 'text-warning' },
  // Healthy is green, not the brand accent: in the red theme a 5% bar in
  // `primary` read as an alarm.
  ok: { bar: 'bg-success', text: 'text-foreground/80' },
} as const;

export function quotaAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

function resetClock(resetsAt: number, language: string): string {
  try {
    return new Date(resetsAt * 1000).toLocaleString(language, {
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return new Date(resetsAt * 1000).toLocaleString(displayLocale());
  }
}

export function WindowRow({
  window,
  reached,
  variant = 'compact',
}: {
  window: QuotaWindow;
  reached: boolean;
  variant?: QuotaVariant | undefined;
}) {
  const { t, i18n } = useAppTranslation();
  const pct = Math.max(0, Math.min(100, window.usedPercent));
  const colors = LEVEL_TONE[quotaLevel(pct, reached)];
  const resetIn = formatQuotaResetIn(window);
  const fullIn =
    window.exhaustsAt === undefined
      ? undefined
      : formatQuotaResetIn({ ...window, resetsAt: window.exhaustsAt });
  const roomy = variant === 'roomy';
  const label = quotaWindowLabel(window);
  return (
    <div className={roomy ? 'space-y-1' : 'space-y-0.5'}>
      <div
        className={cn(
          'flex items-baseline justify-between gap-2',
          roomy ? 'text-xs' : 'text-[11px]',
        )}
      >
        <span className="min-w-0 truncate font-medium text-foreground/80" title={label}>
          {label}
        </span>
        <span className={cn('shrink-0 tabular-nums', colors.text)}>
          <span className={roomy ? 'text-sm font-semibold' : undefined}>{Math.round(pct)}%</span>
          <span className="text-muted-foreground/70">
            {' · '}
            {t('activity:quotaPanel.left', { pct: Math.round(100 - pct) })}
          </span>
        </span>
      </div>
      <div
        className={cn('w-full overflow-hidden rounded-full bg-muted', roomy ? 'h-2' : 'h-1.5')}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
        aria-label={label}
      >
        <div className={cn('h-full rounded-full', colors.bar)} style={{ width: `${pct}%` }} />
      </div>
      <div
        className={cn(
          'flex flex-wrap gap-x-2 text-muted-foreground/80',
          roomy ? 'text-[11px]' : 'text-[10px]',
        )}
      >
        {reached && <span className="text-destructive">{t('activity:quotaPanel.reached')}</span>}
        {resetIn && (
          <span>
            {t('activity:quotaPanel.resetsIn', { time: resetIn })}
            {roomy && window.resetsAt !== undefined && (
              <span className="text-muted-foreground/60">
                {' '}
                ({resetClock(window.resetsAt, i18n.language)})
              </span>
            )}
          </span>
        )}
        {fullIn && (
          <span className="text-warning">{t('activity:quotaPanel.fullIn', { time: fullIn })}</span>
        )}
      </div>
    </div>
  );
}

function MeterBody({
  meter,
  label,
  variant,
}: {
  meter: QuotaSnapshot;
  label?: string | undefined;
  variant: QuotaVariant;
}) {
  const { t } = useAppTranslation();
  return (
    <div className={variant === 'roomy' ? 'space-y-2' : 'space-y-1.5'}>
      {label && <div className="truncate text-[10px] text-muted-foreground">{label}</div>}
      {meter.windows.map((window) => (
        <WindowRow
          key={window.id}
          window={window}
          reached={meter.reachedWindowId === window.id}
          variant={variant}
        />
      ))}
      {meter.credits && (
        <div className="text-[11px] text-muted-foreground">
          {t('activity:quotaPanel.balance')}:{' '}
          <span
            className={cn(
              'tabular-nums text-foreground/80',
              variant === 'roomy' && 'text-sm font-semibold',
            )}
          >
            {meter.credits.unlimited ? '∞' : (meter.credits.balance ?? '—')}
          </span>
        </div>
      )}
      {meter.note && (
        <div className="text-[10px] leading-snug text-muted-foreground" title={meter.meterLabel}>
          {meter.note}
        </div>
      )}
    </div>
  );
}

export interface QuotaCardViewProps {
  card: QuotaCard;
  now: number;
  variant?: QuotaVariant | undefined;
  /** Replaces the brand title — a pool account card is titled by its account. */
  title?: string | undefined;
  /** Replaces the id subtitle. */
  subtitle?: string | undefined;
  /** Marks a card whose account is drawn on by a model in use. */
  inUse?: boolean | undefined;
}

export function QuotaCardView({
  card,
  now,
  variant = 'compact',
  title,
  subtitle,
  inUse,
}: QuotaCardViewProps) {
  const { t } = useAppTranslation();
  const refresh = useProviderQuotaStore((s) => s.refreshes[card.providerId]);
  const { meters } = card;
  // A gateway's pool accounts each have their own plan: named per meter.
  const pooled = meters.some((m) => m.via !== undefined);
  // A card titled by its account (the page's pool cards) already names it.
  const plan = pooled && !title ? undefined : meters.find((m) => m.planLabel)?.planLabel;
  const capturedAt = meters.reduce((max, m) => Math.max(max, m.capturedAt), 0);
  const hasReading = meters.some((m) => m.windows.length > 0 || m.note || m.credits);
  // A meter name is only worth a line when several meters carry bars.
  const windowedMeters = meters.filter((m) => m.windows.length > 0).length;
  const labelled = !title && ((meters.length > 1 && windowedMeters > 1) || pooled);
  const empty =
    card.vendor === 'chatgpt'
      ? t('activity:quotaPanel.chatgptUnavailable')
      : refresh && !refresh.ok
        ? t('activity:quotaPanel.readFailed')
        : t('activity:quotaPanel.reading');
  const roomy = variant === 'roomy';
  const sub = subtitle ?? cardSubtitle(card);

  return (
    <div
      className={cn(
        'rounded-lg border bg-card/65 shadow-sm',
        roomy ? 'space-y-3 p-3' : 'space-y-1.5 p-2',
        // Not `primary`: in the red palette a primary outline reads as an alarm.
        inUse ? 'border-info/60' : 'border-border/60',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className={cn('truncate font-semibold', roomy ? 'text-sm' : 'text-xs')}>
            {title ?? cardTitle(card)}
            {!roomy && sub && (
              <span className="ml-1 font-normal text-muted-foreground/70">{sub}</span>
            )}
          </div>
          {roomy && sub && (
            <div className="truncate text-[11px] text-muted-foreground/80">{sub}</div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5 text-[10px] text-muted-foreground/70">
          {inUse && roomy && (
            <span className="rounded bg-info/15 px-1.5 py-px font-medium text-info">
              {t('activity:quotaPage.inUseBadge')}
            </span>
          )}
          {plan && (
            <span className="max-w-[10rem] truncate rounded border border-border/60 px-1 py-px uppercase">
              {plan}
            </span>
          )}
          {capturedAt > 0 && (
            <span>{t('activity:quotaPanel.asOf', { time: quotaAge(now - capturedAt) })}</span>
          )}
        </div>
      </div>
      {!hasReading && meters.length > 0 && (
        <div className="text-[11px] text-muted-foreground">{empty}</div>
      )}
      {!hasReading && meters.length === 0 && !card.hiddenPoolAccounts && (
        <div className="text-[11px] text-muted-foreground">{empty}</div>
      )}
      {meters.map((meter) => (
        <MeterBody
          key={meter.meterId}
          meter={meter}
          variant={variant}
          label={
            labelled && meter.meterLabel
              ? `${meter.meterLabel}${pooled && meter.planLabel ? ` · ${meter.planLabel}` : ''}`
              : undefined
          }
        />
      ))}
      {card.vendor === 'chatgpt' && (
        <a
          href="https://chatgpt.com/settings/usage"
          target="_blank"
          rel="noopener noreferrer"
          className="block text-[11px] text-info hover:underline"
        >
          {t('activity:quotaPanel.chatgptUsage')}
        </a>
      )}
      {card.hiddenPoolAccounts ? (
        <div className="text-[10px] text-muted-foreground/80">
          {t(
            meters.length > 0 ? 'activity:quotaPanel.poolMore' : 'activity:quotaPanel.poolNoMatch',
            { count: card.hiddenPoolAccounts },
          )}
        </div>
      ) : null}
    </div>
  );
}
