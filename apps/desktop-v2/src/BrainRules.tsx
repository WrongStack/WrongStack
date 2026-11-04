import { useDesktopText } from './desktop-i18n';
import { entries, record } from './engine-values';

/**
 * The Brain's deterministic rules as the WebUI's settings list them: evaluated before any provider
 * call, first match wins, read-only here (they are edited in the global config file). Rules the
 * loader dropped are listed with the reason it gave.
 */
export function BrainRules({ snapshot }: { snapshot: Record<string, unknown> }) {
  const { t } = useDesktopText();
  const rules = entries(snapshot['rules']);
  const dropped = Array.isArray(snapshot['ruleErrors'])
    ? snapshot['ruleErrors'].filter((error): error is string => typeof error === 'string')
    : [];
  return (
    <article className="brain-policy-card brain-rules" aria-label={t('brainPolicy.rules.title')}>
      <header>
        <h3>{t('brainPolicy.rules.title')}</h3>
        <span className="sdd-chip">{t('brainPolicy.rules.count', { n: rules.length })}</span>
      </header>
      <p className="field-help">{t('brainPolicy.rules.help')}</p>
      {rules.length > 0 && (
        <ol>
          {rules.map((rule, index) => (
            <li key={`${String(rule['id'])}-${index}`}>
              <code>{String(rule['id'] ?? t('brainPolicy.rules.rule', { n: index + 1 }))}</code>
              <span className="sdd-chip">
                {String(record(rule['then'])['action'] ?? t('brainPolicy.rules.noAction'))}
              </span>
              {rule['enabled'] === false && (
                <span className="sdd-chip">{t('brainPolicy.rules.off')}</span>
              )}
            </li>
          ))}
        </ol>
      )}
      {dropped.length > 0 && (
        <div className="brain-rules-dropped" role="note">
          <strong>
            {t(
              dropped.length === 1
                ? 'brainPolicy.rules.droppedOne'
                : 'brainPolicy.rules.droppedMany',
              {
                n: dropped.length,
              },
            )}
          </strong>
          {dropped.map((error) => (
            <p key={error}>{error}</p>
          ))}
        </div>
      )}
    </article>
  );
}
