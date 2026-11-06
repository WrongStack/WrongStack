import type { BrainMessage } from './brain-message';
import { useDesktopText } from './desktop-i18n';

/** Fields whose values are engine codes with catalog names; the rest are free text. */
const NAMED = new Set<string>(['risk', 'tier', 'decisionType', 'source']);

export function BrainMessageCard({ decision }: { decision: BrainMessage }) {
  const { t } = useDesktopText();
  const fields = [
    'question',
    'source',
    'risk',
    'tier',
    'decisionType',
    'optionId',
    'text',
    'rationale',
    'reason',
  ] as const;
  return (
    <section aria-label={t('brainMessage.title')} data-brain-decision={decision.id}>
      <strong>
        {t('brainMessage.title')} ·{' '}
        {t(`brainMessage.kind.${decision.kind}`, { defaultValue: decision.kind })}
      </strong>
      {decision.pending !== undefined && (
        <p role="status">{t(decision.pending ? 'brainMessage.waiting' : 'brainMessage.closed')}</p>
      )}
      <dl>
        {fields.map((field) =>
          decision[field] ? (
            <div key={field}>
              <dt>{t(`brainMessage.${field}`)}</dt>
              <dd>
                {NAMED.has(field)
                  ? t(`brainMessage.value.${field}.${decision[field]}`, {
                      defaultValue: decision[field],
                    })
                  : decision[field]}
              </dd>
            </div>
          ) : null,
        )}
        {decision.confidence !== undefined && (
          <div>
            <dt>{t('brainMessage.confidence')}</dt>
            <dd>{Math.round(decision.confidence * 100)}%</dd>
          </div>
        )}
      </dl>
    </section>
  );
}
