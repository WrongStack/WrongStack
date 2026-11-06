import { Users } from 'lucide-react';
import { type DelegationRecord, delegationTotals } from './delegations';
import { useDesktopText } from './desktop-i18n';
import { displayDecimal } from './display-dates';

const usd = (value: number) =>
  `$${value < 0.01 ? displayDecimal(value, 4) : displayDecimal(value, 2)}`;

/**
 * Worker agents this conversation delegated to, as the engine reported each one when it
 * finished, with the engine's own cost estimate where it had one.
 */
export function SessionDelegations({ delegations }: { delegations: DelegationRecord[] }) {
  const { t } = useDesktopText();
  if (!delegations.length) return null;
  const seconds = (ms: number) =>
    ms >= 60_000
      ? t('delegationsView.minutes', { count: Math.round(ms / 60_000) })
      : t('delegationsView.seconds', { count: Math.round(ms / 1000) });
  const totals = delegationTotals(delegations);
  const summary = [
    t('delegationsView.finished', { count: totals.count }),
    t('delegationsView.notSuccessful', { count: totals.failed }),
    t('delegationsView.toolCalls', { count: totals.toolCalls }),
    seconds(totals.durationMs),
    ...(totals.costUsd === null
      ? []
      : [t('delegationsView.estimated', { value: usd(totals.costUsd) })]),
    ...(totals.unpriced ? [t('delegationsView.unpriced', { count: totals.unpriced })] : []),
  ];
  return (
    <section className="session-delegations" aria-label={t('delegationsView.label')}>
      <header>
        <Users size={15} />
        <h3>{t('delegationsView.label')}</h3>
      </header>
      <p className="settings-defaults-note">
        {summary.join(' · ')}. {t('delegationsView.note')}
      </p>
      <ol aria-label={t('delegationsView.list')}>
        {delegations
          .slice()
          .reverse()
          .map((item) => (
            <li key={item.id} className={item.ok ? '' : 'failed'}>
              <strong>{item.target}</strong>
              <span>
                {[
                  item.ok
                    ? t('delegationsView.succeeded')
                    : item.status
                      ? t('delegationsView.failedStatus', { status: item.status })
                      : t('delegationsView.failed'),
                  t('delegationsView.turns', { count: item.iterations }),
                  t('delegationsView.toolCalls', { count: item.toolCalls }),
                  seconds(item.durationMs),
                  ...(item.costUsd === null ? [] : [usd(item.costUsd)]),
                ].join(' · ')}
              </span>
              {item.summary && <small>{item.summary}</small>}
            </li>
          ))}
      </ol>
    </section>
  );
}
