import { useCallback, useEffect, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import type { EngineHttp } from './engine-http';
import { entries, record } from './engine-values';
import { techPlanKey, techPlanSelectionIsCurrent } from './techstack-model';
import { techWord } from './techstack-text';

export function TechStackRemediation({
  http,
  snapshotId,
  onChanged,
}: {
  http: EngineHttp;
  snapshotId: string;
  onChanged: () => void;
}) {
  const { t } = useDesktopText();
  const [plan, setPlan] = useState<Record<string, unknown> | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const load = useCallback(async () => {
    setError('');
    setPlan(null);
    setSelected([]);
    setReview(false);
    try {
      const response = record(await http('/api/techstack/remediation'));
      setPlan(record(response['plan']));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [http]);
  useEffect(() => {
    void load();
  }, [load, snapshotId]);
  const apply = async () => {
    if (!plan || busy || !selected.length) return;
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const latest = record(record(await http('/api/techstack/remediation'))['plan']);
      if (!techPlanSelectionIsCurrent(plan, latest, selected)) {
        setPlan(latest);
        setSelected([]);
        setReview(false);
        throw Error(t('techRemedy.planChanged'));
      }
      const response = record(
        await http('/api/techstack/remediation/apply', 'POST', {
          approvedItems: selected,
          expectedSnapshotId: plan['snapshotId'],
          expectedItems: entries(plan['items']).filter((item) =>
            selected.includes(techPlanKey(item)),
          ),
        }),
      );
      setResult(record(response['result']));
      setSelected([]);
      setReview(false);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const items = entries(plan?.['items']);
  return (
    <section className="tech-remediation" aria-label={t('techRemedy.label')}>
      <header className="tech-section-heading">
        <div>
          <h2>{t('techRemedy.title')}</h2>
          <p>{t('techRemedy.intro')}</p>
        </div>
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={() => void load()}
        >
          {t('techRemedy.refresh')}
        </button>
      </header>
      {error && (
        <p className="composer-error" role="alert">
          {error}
        </p>
      )}
      {!plan ? (
        !error && <p role="status">{t('techRemedy.building')}</p>
      ) : (
        <>
          <p className="field-help">
            {t('techRemedy.generated', { at: String(plan['generatedAt']) })}
          </p>
          {items.length ? (
            items.map((item, index) => {
              const key = techPlanKey(item);
              return (
                <article className="tech-plan-item" key={`${key}:${index}`}>
                  <label>
                    <input
                      type="checkbox"
                      aria-label={t('techRemedy.select', {
                        name: String(item['dependencyName']),
                        workspace: String(item['workspaceId']),
                      })}
                      checked={selected.includes(key)}
                      disabled={busy || review}
                      onChange={(e) =>
                        setSelected((old) =>
                          e.target.checked ? [...old, key] : old.filter((value) => value !== key),
                        )
                      }
                    />
                    <strong>{String(item['dependencyName'])}</strong>
                    <span>
                      {techWord(item['severity'], t)} · {techWord(item['action'], t)}
                    </span>
                  </label>
                  <small>
                    {String(item['ecosystem'])} ·{' '}
                    {t('techRemedy.workspace', { id: String(item['workspaceId']) })}
                  </small>
                  <p>
                    {String(item['currentVersion'] ?? t('techRemedy.notReported'))} →{' '}
                    {String(item['targetVersion'] ?? t('techRemedy.noTarget'))}
                  </p>
                  <p>{String(item['rationale'] ?? '')}</p>
                  {typeof item['breakingRisk'] === 'string' && (
                    <p className="tech-breaking-risk">{item['breakingRisk']}</p>
                  )}
                  {typeof item['suggestedCommand'] === 'string' && (
                    <details>
                      <summary>{t('techRemedy.command')}</summary>
                      <code>{item['suggestedCommand']}</code>
                    </details>
                  )}
                </article>
              );
            })
          ) : (
            <p>{t('techRemedy.noActions')}</p>
          )}
          {review ? (
            <div className="tech-plan-confirm">
              <h3>{t('techRemedy.confirmTitle', { number: selected.length })}</h3>
              <p>{t('techRemedy.confirmBody')}</p>
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => setReview(false)}
              >
                {t('techRemedy.keepReviewing')}
              </button>
              <button
                type="button"
                className="button primary"
                disabled={busy}
                onClick={() => void apply()}
              >
                {busy ? t('techRemedy.waiting') : t('techRemedy.execute')}
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="button primary"
              disabled={busy || !selected.length}
              onClick={() => setReview(true)}
            >
              {t('techRemedy.review', { number: selected.length })}
            </button>
          )}
        </>
      )}
      {result && (
        <section role="status">
          <h3>{result['dryRun'] === true ? t('techRemedy.preview') : t('techRemedy.results')}</h3>
          {entries(result['items']).map((item, index) => (
            <article className="tech-plan-item" key={index}>
              <strong>
                {String(item['dependencyName'])} · {techWord(item['status'], t)}
              </strong>
              {typeof item['detail'] === 'string' && <p>{item['detail']}</p>}
            </article>
          ))}
        </section>
      )}
    </section>
  );
}
