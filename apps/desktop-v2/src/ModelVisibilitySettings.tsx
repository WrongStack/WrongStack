import { useEffect, useRef, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import { entries, record } from './engine-values';
import { Modal } from './Modal';
import {
  disableModelPatch,
  modelListed,
  modelReferences,
  modelRefMatches,
  providerDisabled,
} from './model-visibility';
import { ProviderVisibilityControl } from './ProviderVisibilityControl';
import './model-visibility.css';

export function ModelVisibilitySettings({
  draft,
  change,
  command,
  defaultProvider,
}: {
  draft: Record<string, unknown>;
  change: (key: string, value: unknown) => void;
  command: EngineCommand;
  defaultProvider: string;
}) {
  const { t } = useDesktopText();
  const [providers, setProviders] = useState<Record<string, unknown>[]>([]),
    [provider, setProvider] = useState('');
  const [models, setModels] = useState<Record<string, unknown>[]>([]),
    [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all'),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [reload, setReload] = useState(0),
    [review, setReview] = useState<{ model: string; hide: boolean } | null>(null);
  const version = useRef(0);
  useEffect(() => {
    let active = true;
    void command('providers.saved', {}, ['providers.saved'])
      .then((reply) => {
        if (!active) return;
        const values = entries(reply['providers']);
        setProviders(values);
        setProvider((current) =>
          values.some((item) => item['id'] === current) ? current : String(values[0]?.['id'] ?? ''),
        );
      })
      .catch((error) => {
        if (active) setError(String(error));
      });
    return () => {
      active = false;
    };
  }, [command, reload]);
  useEffect(() => {
    const current = ++version.current;
    setModels([]);
    setError('');
    if (!provider) {
      setBusy(false);
      return;
    }
    setBusy(true);
    void command('provider.models', { providerId: provider, includeDisabled: true }, [
      'provider.models',
    ])
      .then((reply) => {
        if (current !== version.current) return;
        if (reply['provider'] !== provider) throw Error(t('modelVisibility.otherProvider'));
        setModels(entries(reply['models']));
      })
      .catch((error) => {
        if (current === version.current) setError(String(error));
      })
      .finally(() => {
        if (current === version.current) setBusy(false);
      });
    return () => {
      version.current++;
    };
  }, [command, provider, reload, t]);
  const hidden = modelReferences(draft['disabledModels']);
  const providerOff = providerDisabled(draft['disabledProviders'], provider);
  const visible = models.filter((model) => {
    const id = String(model['id']);
    return (
      `${id} ${model['name'] ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()) &&
      (filter === 'all' ||
        (filter === 'hidden'
          ? providerOff || modelListed(hidden, provider, id)
          : filter === 'favorites'
            ? modelListed(draft['favoriteModels'], provider, id)
            : !providerOff && !modelListed(hidden, provider, id)))
    );
  });
  const patch = review?.hide
    ? disableModelPatch(draft, provider, review.model, defaultProvider)
    : null;
  const removed = patch
    ? {
        favorites: modelReferences(draft['favoriteModels']).filter(
          (ref) => !patch.favoriteModels.includes(ref),
        ),
        fallback: modelReferences(draft['fallbackModels']).filter(
          (ref) => !patch.fallbackModels.includes(ref),
        ),
        profiles: Object.entries(record(draft['fallbackProfiles'])).flatMap(([name, refs]) =>
          modelReferences(refs)
            .filter((ref) => !patch.fallbackProfiles[name]?.includes(ref))
            .map((ref) => `${name}: ${ref}`),
        ),
      }
    : null;
  return (
    <section className="model-visibility" aria-label={t('modelVisibility.label')}>
      <div className="model-visibility-toolbar">
        <label>
          {t('modelVisibility.savedProvider')}
          <select
            aria-label={t('modelVisibility.providerSelect')}
            value={provider}
            disabled={busy || !!review}
            onChange={(event) => setProvider(event.target.value)}
          >
            {providers.map((item) => (
              <option key={String(item['id'])} value={String(item['id'])}>
                {String(item['id'])}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('modelVisibility.search')}
          <input
            aria-label={t('modelVisibility.searchLabel')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('modelVisibility.searchPlaceholder')}
          />
        </label>
        <label>
          {t('modelVisibility.show')}
          <select
            aria-label={t('modelVisibility.filter')}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          >
            <option value="all">{t('modelVisibility.allModels')}</option>
            <option value="enabled">{t('modelVisibility.enabled')}</option>
            <option value="hidden">{t('modelVisibility.disabled')}</option>
            <option value="favorites">{t('modelVisibility.favorites')}</option>
          </select>
        </label>
        <button
          type="button"
          className="button secondary"
          disabled={busy || !!review}
          onClick={() => setReload((value) => value + 1)}
        >
          {t('modelVisibility.refresh')}
        </button>
      </div>
      <p className="field-help">{t('modelVisibility.draftNote')}</p>
      <ProviderVisibilityControl key={provider} provider={provider} draft={draft} change={change} />
      {error && (
        <p role="alert" className="session-error">
          {error}
        </p>
      )}
      {busy && <p role="status">{t('modelVisibility.reading')}</p>}
      <p>
        {t('modelVisibility.counts', {
          matching: visible.length,
          disabled: models.filter((model) => modelListed(hidden, provider, String(model['id'])))
            .length,
        })}
      </p>
      <div className="model-visibility-list">
        {visible.map((model) => {
          const id = String(model['id']),
            off = modelListed(hidden, provider, id),
            favorite = modelListed(draft['favoriteModels'], provider, id);
          return (
            <article key={id} aria-label={t('modelVisibility.item', { id })}>
              <div>
                <strong>{String(model['name'] ?? id)}</strong>
                <code>{id}</code>
                <span>
                  {off
                    ? t('modelVisibility.state.disabled')
                    : providerOff
                      ? t('modelVisibility.state.providerDisabled')
                      : t('modelVisibility.state.enabled')}
                </span>
              </div>
              <button
                type="button"
                className="button secondary small"
                disabled={providerOff || off}
                aria-pressed={favorite}
                onClick={() =>
                  change(
                    'favoriteModels',
                    favorite
                      ? modelReferences(draft['favoriteModels']).filter(
                          (ref) => !modelRefMatches(ref, provider, id),
                        )
                      : [...modelReferences(draft['favoriteModels']), `${provider}/${id}`],
                  )
                }
              >
                {favorite ? t('modelVisibility.removeFavorite') : t('modelVisibility.addFavorite')}
              </button>
              <button
                type="button"
                className="button secondary small"
                disabled={providerOff}
                onClick={() => setReview({ model: id, hide: !off })}
              >
                {off ? t('modelVisibility.enableModel') : t('modelVisibility.disableModel')}
              </button>
            </article>
          );
        })}
      </div>
      {!busy && !visible.length && <p className="quiet-state">{t('modelVisibility.noMatch')}</p>}
      <details>
        <summary>{t('modelVisibility.modelRules', { number: hidden.length })}</summary>
        <p className="field-help">{t('modelVisibility.modelRulesNote')}</p>
        {hidden.map((ref, index) => (
          <div className="model-visibility-rule" key={`${index}:${ref}`}>
            <code>{ref}</code>
            <button
              type="button"
              className="button secondary small"
              aria-label={t('modelVisibility.removeRuleLabel', { ref })}
              onClick={() =>
                change(
                  'disabledModels',
                  hidden.filter((_, i) => i !== index),
                )
              }
            >
              {t('modelVisibility.removeRule')}
            </button>
          </div>
        ))}
      </details>
      <details>
        <summary>
          {t('modelVisibility.providerRules', {
            number: modelReferences(draft['disabledProviders']).length,
          })}
        </summary>
        <p className="field-help">{t('modelVisibility.providerRulesNote')}</p>
        {modelReferences(draft['disabledProviders']).map((id, index) => (
          <div className="model-visibility-rule" key={`${index}:${id}`}>
            <code>{id}</code>
            <button
              type="button"
              className="button secondary small"
              aria-label={t('modelVisibility.removeProviderRuleLabel', { id })}
              onClick={() =>
                change(
                  'disabledProviders',
                  modelReferences(draft['disabledProviders']).filter(
                    (item) => item.trim().toLowerCase() !== id.trim().toLowerCase(),
                  ),
                )
              }
            >
              {t('modelVisibility.removeProviderRule')}
            </button>
          </div>
        ))}
      </details>
      {review && (
        <Modal onClose={() => setReview(null)}>
          <h2 id="dialog-title">
            {review.hide ? t('modelVisibility.reviewExclusion') : t('modelVisibility.enableThis')}
          </h2>
          <p>
            <strong>
              {provider} / {review.model}
            </strong>
          </p>
          {removed ? (
            <>
              <p>{t('modelVisibility.removesRefs')}</p>
              <ul>
                <li>
                  {t('modelVisibility.favoritesList', {
                    list: removed.favorites.join(', ') || t('modelVisibility.none'),
                  })}
                </li>
                <li>
                  {t('modelVisibility.fallbackList', {
                    list: removed.fallback.join(', ') || t('modelVisibility.none'),
                  })}
                </li>
                <li>
                  {t('modelVisibility.profilesList', {
                    list: removed.profiles.join(', ') || t('modelVisibility.none'),
                  })}
                </li>
              </ul>
              <p className="field-help">{t('modelVisibility.overridesKept')}</p>
            </>
          ) : (
            <>
              <p>{t('modelVisibility.removeRules')}</p>
              <ul>
                {hidden
                  .filter((ref) => modelRefMatches(ref, provider, review.model))
                  .map((ref, index) => (
                    <li key={`${index}:${ref}`}>{ref}</li>
                  ))}
              </ul>
              <p className="field-help">{t('modelVisibility.bareRuleNote')}</p>
              <p className="field-help">{t('modelVisibility.staysRemoved')}</p>
            </>
          )}
          <div className="modal-actions">
            <button type="button" className="button secondary" onClick={() => setReview(null)}>
              {t('modelVisibility.keep')}
            </button>
            <button
              type="button"
              className="button primary"
              onClick={() => {
                if (patch) for (const [key, value] of Object.entries(patch)) change(key, value);
                else
                  change(
                    'disabledModels',
                    hidden.filter((ref) => !modelRefMatches(ref, provider, review.model)),
                  );
                setReview(null);
              }}
            >
              {t('modelVisibility.apply')}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
