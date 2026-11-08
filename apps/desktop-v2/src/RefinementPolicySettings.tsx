import { LoaderCircle, Sparkles } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { refinementText } from './composer-model';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import { entries, record } from './engine-values';
import { MarkdownContent } from './MarkdownContent';
import { readRefineCountdownMs, writeRefineCountdownMs } from './refine-countdown';
import { enhanceDelayField, refineCountdownField, refinerRoute } from './refinement-policy-model';
import { SettingRow } from './SettingRow';
import { sameSetting } from './settings-save-model';
import './refinement-policy.css';

export function RefinementPolicySettings({
  draft,
  saved,
  change,
  command,
}: {
  draft: Record<string, unknown>;
  saved: Record<string, unknown>;
  change: (key: string, value: unknown) => void;
  command: EngineCommand;
}) {
  const { t } = useDesktopText();
  const [countdown, setCountdown] = useState(readRefineCountdownMs);
  const [models, setModels] = useState<{ provider: string; model: string }[]>([]),
    [catalogError, setCatalogError] = useState('');
  const [sample, setSample] = useState(''),
    [result, setResult] = useState<Record<string, unknown> | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const generation = useRef(0),
    previewGeneration = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    previewGeneration.current++;
    setResult(null);
    setError('');
    setBusy(false);
    setModels([]);
    setCatalogError('');
    void command('providers.saved', {}, ['providers.saved', 'key.operation_result'])
      .then(async (reply) => {
        const results = await Promise.allSettled(
          entries(reply['providers']).map(async (provider) => {
            const id = String(provider['id']);
            const reply = await command('provider.models', { providerId: id }, [
              'provider.models',
              'key.operation_result',
            ]);
            return entries(reply['models']).map((row) => ({
              provider: id,
              model: String(row['id']),
            }));
          }),
        );
        if (current === generation.current) {
          setModels(results.flatMap((value) => (value.status === 'fulfilled' ? value.value : [])));
          if (results.some((value) => value.status === 'rejected'))
            setCatalogError(t('refinePolicy.catalogError'));
        }
      })
      .catch((error) => {
        if (current === generation.current)
          setCatalogError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      generation.current++;
      previewGeneration.current++;
    };
  }, [command, t]);
  const savedRouteKey = JSON.stringify([
    refinerRoute(saved),
    record(saved['fallbackProfiles'])[String(saved['refinerFallbackProfile'] ?? '')],
  ]);
  useEffect(() => {
    previewGeneration.current++;
    setResult(null);
    setError('');
    setBusy(false);
  }, [savedRouteKey]);
  const profiles = record(draft['fallbackProfiles']),
    selected = String(draft['refinerFallbackProfile'] ?? '');
  const pending =
    !sameSetting(refinerRoute(draft), refinerRoute(saved)) ||
    !sameSetting(profiles[selected], record(saved['fallbackProfiles'])[selected]);
  const preview = async () => {
    if (busy || pending || !sample.trim()) return;
    setBusy(true);
    setError('');
    setResult(null);
    const current = ++previewGeneration.current,
      context = generation.current;
    try {
      const reply = await command(
        'model.refine',
        { text: sample, timeoutMs: 90000 },
        ['model.refine_result'],
        { timeoutMs: 105000 },
      );
      refinementText(reply, 'refined', sample);
      if (current === previewGeneration.current && context === generation.current) setResult(reply);
    } catch (error) {
      if (current === previewGeneration.current && context === generation.current)
        setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (current === previewGeneration.current && context === generation.current) setBusy(false);
    }
  };
  return (
    <section className="refinement-policy" aria-label={t('refinePolicy.label')}>
      <article>
        <header>
          <Sparkles size={21} />
          <div>
            <span className="eyebrow">{t('refinePolicy.eyebrow')}</span>
            <h3>{t('refinePolicy.title')}</h3>
          </div>
        </header>
        <label className="refinement-policy-toggle">
          <span>
            <strong>{t('refinePolicy.reviewOnSubmit')}</strong>
            <small>{t('refinePolicy.reviewOnSubmitHelp')}</small>
          </span>
          <input
            type="checkbox"
            aria-label={t('refinePolicy.reviewOnSubmit')}
            checked={draft['enhanceEnabled'] === true}
            onChange={(event) => change('enhanceEnabled', event.target.checked)}
          />
        </label>
        <label>
          {t('refinePolicy.language')}
          <select
            aria-label={t('refinePolicy.language')}
            value={String(draft['enhanceLanguage'] ?? 'original')}
            onChange={(event) => change('enhanceLanguage', event.target.value)}
          >
            <option value="original">{t('refinePolicy.keepOriginal')}</option>
            <option value="english">{t('refinePolicy.english')}</option>
          </select>
        </label>
        <p>{t('refinePolicy.chooseNote')}</p>
        <SettingRow
          field={refineCountdownField}
          value={countdown}
          onChange={(value) => setCountdown(writeRefineCountdownMs(value))}
        />
        <SettingRow
          field={enhanceDelayField}
          value={draft['enhanceDelayMs']}
          onChange={(value) => change('enhanceDelayMs', value)}
        />
      </article>
      <article>
        <h3>{t('refinePolicy.routeTitle')}</h3>
        <p>{t('refinePolicy.routeIntro')}</p>
        <label>
          {t('refinePolicy.profile')}
          <select
            aria-label={t('refinePolicy.profile')}
            value={selected}
            onChange={(event) => change('refinerFallbackProfile', event.target.value)}
          >
            <option value="">{t('refinePolicy.noProfile')}</option>
            {Object.keys(profiles).map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
            {selected && !Object.hasOwn(profiles, selected) && (
              <option value={selected}>{t('refinePolicy.unavailable', { name: selected })}</option>
            )}
          </select>
        </label>
        {selected && (
          <p>
            {t('refinePolicy.candidates')}{' '}
            {Array.isArray(profiles[selected])
              ? (profiles[selected] as unknown[]).map(String).join(' → ') ||
                t('refinePolicy.emptyProfile')
              : t('refinePolicy.unavailableProfile')}
          </p>
        )}
        {catalogError && <p role="status">{catalogError}</p>}
        <label>
          {t('refinePolicy.savedModel')}
          <select
            aria-label={t('refinePolicy.savedModel')}
            value=""
            onChange={(event) => {
              const choice = models[Number(event.target.value)];
              if (choice) {
                change('refinerProvider', choice.provider);
                change('refinerModel', choice.model);
              }
            }}
          >
            <option value="">{t('refinePolicy.chooseSaved')}</option>
            {models.map((entry, index) => (
              <option value={index} key={index}>
                {entry.provider}/{entry.model}
              </option>
            ))}
          </select>
        </label>
        <div className="refinement-route-fields">
          <label>
            {t('refinePolicy.provider')}
            <input
              aria-label={t('refinePolicy.provider')}
              value={String(draft['refinerProvider'] ?? '')}
              placeholder={t('refinePolicy.inheritProvider')}
              onChange={(event) => change('refinerProvider', event.target.value)}
            />
          </label>
          <label>
            {t('refinePolicy.model')}
            <input
              aria-label={t('refinePolicy.model')}
              value={String(draft['refinerModel'] ?? '')}
              placeholder={t('refinePolicy.inheritModel')}
              onChange={(event) => change('refinerModel', event.target.value)}
            />
          </label>
        </div>
        <p>{t('refinePolicy.routeNote')}</p>
      </article>
      <article>
        <h3>{t('refinePolicy.tryTitle')}</h3>
        <p>{t('refinePolicy.tryIntro')}</p>
        <label>
          {t('refinePolicy.sample')}
          <textarea
            rows={3}
            aria-label={t('refinePolicy.sampleLabel')}
            value={sample}
            onChange={(event) => setSample(event.target.value)}
          />
        </label>
        {pending && <p>{t('refinePolicy.saveFirst')}</p>}
        <button
          type="button"
          className="button secondary"
          disabled={busy || pending || !sample.trim()}
          onClick={() => void preview()}
        >
          {busy ? <LoaderCircle size={14} className="spin" /> : <Sparkles size={14} />}
          {busy ? t('refinePolicy.refining') : t('refinePolicy.preview')}
        </button>
        {error && (
          <p role="alert" className="session-error">
            {error}
          </p>
        )}
        {result && (
          <section aria-label={t('refinePolicy.previewLabel')}>
            <p>
              {t('refinePolicy.used', {
                provider: String(
                  record(result['refinedWith'])['provider'] ?? t('refinePolicy.unreportedProvider'),
                ),
                model: String(
                  record(result['refinedWith'])['model'] ?? t('refinePolicy.unreportedModel'),
                ),
              })}
            </p>
            <div className="refinement-preview-columns">
              <div>
                <h4>{t('refinePolicy.originalRefinement')}</h4>
                <MarkdownContent text={String(result['refined'] ?? '')} />
              </div>
              <div>
                <h4>{t('refinePolicy.englishVersion')}</h4>
                <MarkdownContent text={String(result['english'] ?? '')} />
              </div>
            </div>
          </section>
        )}
      </article>
    </section>
  );
}
