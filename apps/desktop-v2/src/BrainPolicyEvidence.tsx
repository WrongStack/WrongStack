import { Trans } from 'react-i18next';
import { useDesktopText } from './desktop-i18n';
import { entries, record } from './engine-values';
import { surfaceI18n } from './surface-i18n';

function reference(value: unknown, inherit: string): string {
  if (typeof value === 'string') return value;
  const entry = record(value);
  return [entry['provider'], entry['model']].filter(Boolean).join('/') || inherit;
}
/** English source for rule conditions; the page words them through `brainEvidence.condition.*`. */
const conditionLabels: Record<string, string> = {
  source: 'Request source',
  risk: 'Risk',
  minRisk: 'Minimum risk',
  maxRisk: 'Maximum risk',
  fallback: 'Caller fallback',
  hasOptions: 'Requires choices',
  offersOption: 'Required choice',
  question: 'Question pattern',
  context: 'Context pattern',
  notQuestion: 'Excluded question pattern',
  notContext: 'Excluded context pattern',
};
export function BrainPolicyEvidence({ snapshot }: { snapshot: Record<string, unknown> }) {
  const { t } = useDesktopText();
  const inherit = t('brainEvidence.inheritModel');
  const veto = (value: unknown, unset: string) =>
    value === true
      ? t('brainEvidence.veto.on')
      : value === false
        ? t('brainEvidence.veto.off')
        : t(unset);
  const council = record(snapshot['council']),
    ledger = record(snapshot['ledger']),
    trace = record(snapshot['trace']);
  return (
    <>
      <section className="brain-policy-card" aria-label={t('brainEvidence.models.label')}>
        <h3>{t('brainEvidence.models.title')}</h3>
        <p>{t('brainEvidence.models.help')}</p>
        <h4>{t('brainEvidence.configuredPool')}</h4>
        {entries(snapshot['models']).length ? (
          <ol>
            {entries(snapshot['models']).map((model, index) => (
              <li key={index}>{reference(model, inherit)}</li>
            ))}
          </ol>
        ) : (
          <p>{t('brainEvidence.inheritPool')}</p>
        )}
        <h4>{t('brainEvidence.resolvedPool')}</h4>
        <p>
          {Array.isArray(snapshot['poolLabels']) && snapshot['poolLabels'].length
            ? snapshot['poolLabels'].map(String).join(' · ')
            : t('brainEvidence.noResolvedPool')}
        </p>
        <h4>{t('brainEvidence.configuredVoters')}</h4>
        {entries(council['voters']).length ? (
          <ol>
            {entries(council['voters']).map((voter, index) => (
              <li key={index}>
                <strong>{reference(voter, inherit)}</strong>
                <p>
                  {[
                    String(voter['persona'] ?? t('brainEvidence.defaultLens')),
                    t('brainEvidence.weight', { n: String(voter['weight'] ?? 1) }),
                    veto(voter['veto'], 'brainEvidence.veto.inherit'),
                  ].join(' · ')}
                </p>
              </li>
            ))}
          </ol>
        ) : (
          <p>{t('brainEvidence.derivedSeats')}</p>
        )}
        <h4>{t('brainEvidence.configuredSeats')}</h4>
        {entries(council['seats']).length ? (
          <ol>
            {entries(council['seats']).map((seat, index) => (
              <li key={index}>
                {String(seat['persona'])} · {veto(seat['veto'], 'brainEvidence.veto.lens')}
              </li>
            ))}
          </ol>
        ) : (
          <p>{t('brainTargets.seats.builtIn')}</p>
        )}
        <h4>{t('brainEvidence.effectiveSeats')}</h4>
        <p>
          {Array.isArray(snapshot['councilLabels']) && snapshot['councilLabels'].length
            ? snapshot['councilLabels'].map(String).join(' · ')
            : t('brainEvidence.noSeats')}
        </p>
        <p>
          {t('brainEvidence.configuredJudge', {
            judge: council['judge']
              ? reference(council['judge'], inherit)
              : t('brainEvidence.derivedJudge'),
          })}
        </p>
        <p>
          {t('brainEvidence.effectiveJudge', {
            judge: String(snapshot['judgeLabel'] ?? t('brainEvidence.noJudge')),
          })}
          {snapshot['judgeIsVoter'] === true ? ` · ${t('brainEvidence.alsoVoter')}` : ''}
        </p>
      </section>
      <section className="brain-policy-card" aria-label={t('brainEvidence.rules.label')}>
        <h3>{t('brainPolicy.rules.title')}</h3>
        <p>{t('brainEvidence.rules.help')}</p>
        {entries(snapshot['rules']).length ? (
          <ol className="brain-rules">
            {entries(snapshot['rules']).map((rule, index) => {
              const action = record(rule['then']);
              return (
                <li key={index}>
                  <h4>
                    {String(rule['id'] ?? t('brainEvidence.rules.rule', { n: index + 1 }))} ·{' '}
                    {rule['enabled'] === false
                      ? t('brainPolicy.disabled')
                      : t('brainPolicy.enabled')}
                  </h4>
                  {typeof rule['description'] === 'string' && <p>{rule['description']}</p>}
                  <dl>
                    {Object.entries(record(rule['when'])).map(([key, value]) => (
                      <div key={key}>
                        <dt>
                          {t(`brainEvidence.condition.${key}`, {
                            defaultValue: conditionLabels[key] ?? key,
                          })}
                        </dt>
                        <dd>
                          {Array.isArray(value) ? value.map(String).join(', ') : String(value)}
                        </dd>
                      </div>
                    ))}
                  </dl>
                  <p>
                    <Trans
                      i18n={surfaceI18n}
                      ns="desktop"
                      i18nKey="brainEvidence.decision"
                      values={{
                        action: String(action['action'] ?? t('brainEvidence.notReported')),
                      }}
                      components={{ strong: <strong /> }}
                    />
                  </p>
                  {['optionId', 'text', 'rationale', 'reason', 'prompt']
                    .filter((key) => typeof action[key] === 'string')
                    .map((key) => (
                      <p key={key}>
                        {t(`brainEvidence.action.${key}`)}: {String(action[key])}
                      </p>
                    ))}
                  {rule['maxHits'] !== undefined && (
                    <p>
                      {t('brainEvidence.maxHits', {
                        n: String(rule['maxHits']),
                        ms: String(rule['windowMs'] ?? 60000),
                      })}
                    </p>
                  )}
                </li>
              );
            })}
          </ol>
        ) : (
          <p>{t('brainEvidence.noRules')}</p>
        )}
        {Array.isArray(snapshot['ruleErrors']) &&
          snapshot['ruleErrors'].map((error, index) => (
            <p key={index} className="session-error">
              {String(error)}
            </p>
          ))}
      </section>
      <section className="brain-policy-card" aria-label={t('brainEvidence.locations.label')}>
        <h3>{t('brainEvidence.locations.title')}</h3>
        <dl>
          <dt>{t('brainEvidence.locations.ledger')}</dt>
          <dd>{String(ledger['path'] ?? t('brainEvidence.locations.none'))}</dd>
          <dt>{t('brainEvidence.locations.trace')}</dt>
          <dd>{String(trace['path'] ?? t('brainEvidence.locations.none'))}</dd>
        </dl>
        <p>{t('brainEvidence.locations.help')}</p>
      </section>
    </>
  );
}
