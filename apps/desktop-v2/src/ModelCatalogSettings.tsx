import { Check, Plus, RefreshCw, Search, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Trans } from 'react-i18next';
import { CatalogModelSearch } from './CatalogModelSearch';
import { localizedText, useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import { entries, record } from './engine-values';
import { LegacyModelDraftNotice } from './LegacyModelDraftNotice';
import { Modal } from './Modal';
import { ModelAdvancedFields } from './ModelAdvancedFields';
import {
  type ModelProfileIdentity,
  useModelProfile,
  verifyModelProfile,
} from './ModelCatalogProfile';
import { ModelDraftAdministration } from './ModelDraftAdministration';
import { ModelDraftNotice } from './ModelDraftNotice';
import { ModelPriceTiers, SavedModelPriceTiers } from './ModelPriceTiers';
import { modelAdvancedDraft } from './model-advanced-editor';
import {
  buildModelDefinition,
  containsModelDefinition,
  modelDefinition,
  modelEditorDraft,
  modelFlags,
  modelNumberFields,
  modelTextFields,
  savedModelProvider,
} from './model-catalog-editor';
import type { ModelEditorState } from './model-editor-draft';
import { sameSetting } from './settings-save-model';
import { surfaceI18n } from './surface-i18n';
import { useModelEditorDraft } from './useModelEditorDraft';
import './model-catalog.css';

type Editor = ModelEditorState;
function makeEditor(id: string, initial?: Record<string, unknown>, name = ''): Editor {
  const draft = modelEditorDraft(id, initial ?? { name });
  return { originalId: id, initial, draft, baseline: draft };
}
export function ModelCatalogSettings({ command }: { command: EngineCommand }) {
  const { t } = useDesktopText();
  const context = useModelProfile(command);
  if (!context.profile)
    return (
      <section aria-label={t('modelCatalog.label')}>
        <p role={context.error ? 'alert' : 'status'}>
          {context.error || t('modelCatalog.identifying')}
        </p>
        {context.error && (
          <button type="button" className="button secondary" onClick={context.retry}>
            {t('modelCatalog.reconnect')}
          </button>
        )}
      </section>
    );
  return (
    <ProfileModelCatalogSettings
      key={context.profile.id}
      command={command}
      profile={context.profile}
    />
  );
}
function ProfileModelCatalogSettings({
  command,
  profile,
}: {
  command: EngineCommand;
  profile: ModelProfileIdentity;
}) {
  const { t } = useDesktopText();
  const [providers, setProviders] = useState<Record<string, unknown>[]>([]);
  const [providerId, setProviderId] = useState('');
  const [provider, setProvider] = useState<Record<string, unknown>>({});
  const [models, setModels] = useState<Record<string, unknown>[]>([]);
  const [selected, setSelected] = useState('');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editor, setEditorValue] = useState<Editor | null>(null);
  const modelDraft = useModelEditorDraft(providerId, profile.id, profile.name);
  const setEditor = (value: Editor) => {
    modelDraft.controller.edit(value);
    setEditorValue(value);
  };
  const blockedDraft = !modelDraft.state.ready || (!editor && !!modelDraft.state.value);
  const [discard, setDiscard] = useState(false);
  const [remove, setRemove] = useState(false);
  const [registrySearch, setRegistrySearch] = useState(false);
  const sequence = useRef(0);
  const busyRef = useRef(false);
  useEffect(() => {
    let active = true;
    void command('providers.saved', {}, ['providers.saved'])
      .then((result) => {
        if (!active) return;
        const values = entries(result['providers']);
        setProviders(values);
        setProviderId((current) => current || String(values[0]?.['id'] ?? ''));
      })
      .catch((error) => {
        if (active) setError(String(error));
      });
    return () => {
      active = false;
    };
  }, [command]);
  const load = useCallback(async () => {
    if (!providerId) return;
    const seq = ++sequence.current;
    setLoading(true);
    setError('');
    try {
      await verifyModelProfile(command, profile);
      const [saved, catalog] = await Promise.all([
        command('providers.saved', {}, ['providers.saved']),
        command('provider.models', { providerId, includeDisabled: true }, ['provider.models']),
      ]);
      if (seq !== sequence.current) return;
      if (catalog['provider'] !== providerId) throw Error(t('modelCatalog.otherCatalog'));
      const current = savedModelProvider(saved, providerId);
      if (!current) throw Error(t('modelCatalog.notSaved'));
      setProvider(current);
      setProviders(entries(saved['providers']));
      setModels(entries(catalog['models']));
    } catch (error) {
      if (seq === sequence.current) setError(String(error));
    } finally {
      if (seq === sequence.current) setLoading(false);
    }
  }, [command, providerId, profile]);
  useEffect(() => {
    setProvider({});
    setModels([]);
    setSelected('');
    setNotice('');
    void load();
    return () => {
      sequence.current++;
    };
  }, [load]);
  const providerIds = useMemo(() => providers.map((item) => String(item['id'])), [providers]);
  const definitions = record(provider['customModels']);
  const rows: Array<Record<string, unknown> & { id: string; name: string }> = [
    ...new Set([...models.map((item) => String(item['id'])), ...Object.keys(definitions)]),
  ].map((id) => {
    const descriptor = models.find((item) => item['id'] === id) ?? {};
    const definition = modelDefinition(provider, id);
    const md = record(definition?.['modelsDev']);
    return {
      ...descriptor,
      id,
      name: String(md['name'] ?? definition?.['name'] ?? descriptor['name'] ?? id),
    };
  });
  const current = rows.find((item) => item.id === selected);
  const definition = modelDefinition(provider, selected);
  const md = record(definition?.['modelsDev']);
  const caps = record(definition?.['capabilities']);
  const limit = record(md['limit']);
  const cost = record(md['cost']);
  const editorCost = record(record(editor?.initial?.['modelsDev'])['cost']);
  const advancedModel = modelAdvancedDraft(md);
  const metric = (value: unknown, price = false) =>
    typeof value === 'number'
      ? price
        ? `$${value.toLocaleString(undefined, { maximumFractionDigits: 8 })}`
        : value.toLocaleString()
      : t('modelCatalog.notReported');
  const closeEditor = () => {
    if (busyRef.current) return;
    if (editor && !sameSetting(editor.draft, editor.baseline)) setDiscard(true);
    else void dismissEditor();
  };
  const dismissEditor = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await modelDraft.controller.clear();
      setEditorValue(null);
      setDiscard(false);
      setError('');
    } catch (error) {
      setError(String(error));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const mutate = async (action: 'save' | 'remove') => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await verifyModelProfile(command, profile);
      if (action === 'save') await modelDraft.controller.prepare(editor ?? undefined);
      const input =
        action === 'save' && editor
          ? buildModelDefinition(editor.draft, editor.initial ?? {})
          : null;
      const id = input?.id ?? selected;
      const expected = action === 'save' ? editor?.initial : definition;
      const saved = await command('providers.saved', {}, ['providers.saved']);
      if (!savedModelProvider(saved, providerId)) throw Error(t('modelCatalog.notSaved'));
      if (!sameSetting(modelDefinition(savedModelProvider(saved, providerId), id), expected))
        throw Error(t('modelCatalog.changed'));
      await command(
        `provider.custom_models.${action === 'save' ? 'set' : 'remove'}`,
        { providerId, modelId: id, ...(input ? { customModel: input.definition } : {}) },
        ['key.operation_result'],
      );
      const verified = savedModelProvider(
        await command('providers.saved', {}, ['providers.saved']),
        providerId,
      );
      const actualDefinition = modelDefinition(verified, id);
      if (
        action === 'save'
          ? !containsModelDefinition(actualDefinition, input!.definition)
          : actualDefinition !== undefined
      )
        throw Error(t('modelCatalog.unverified'));
      if (
        action === 'save' &&
        editor?.draft.pricing.changed &&
        !sameSetting(
          record(record(actualDefinition?.['modelsDev'])['cost'])['tiers'],
          record(record(input!.definition['modelsDev'])['cost'])['tiers'],
        )
      )
        throw Error(t('modelCatalog.tiersMismatch'));
      if (action === 'save') await modelDraft.controller.clear();
      setEditorValue(null);
      setRemove(false);
      setDiscard(false);
      setSelected(action === 'save' ? id : '');
      await load();
      setNotice(
        action === 'save' ? t('modelCatalog.savedNotice') : t('modelCatalog.removedNotice'),
      );
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  return (
    <section className="model-catalog-settings" aria-label={t('modelCatalog.label')}>
      <header className="settings-section-heading">
        <div>
          <span className="eyebrow">{t('modelCatalog.eyebrow')}</span>
          <h2>{t('modelCatalog.title')}</h2>
          <p>{t('modelCatalog.intro')}</p>
        </div>
      </header>
      {!providers.length && <p>{t('modelCatalog.noProviders')}</p>}
      <div className="model-catalog-toolbar">
        <label>
          {t('modelCatalog.savedProvider')}
          <select
            aria-label={t('modelCatalog.providerLabel')}
            value={providerId}
            disabled={busy || !!editor || remove}
            onChange={(event) => {
              setProviderId(event.target.value);
              setQuery('');
            }}
          >
            {providers.map((item) => (
              <option key={String(item['id'])}>{String(item['id'])}</option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="button secondary"
          disabled={loading || busy || !!editor || remove}
          onClick={() => {
            void command('providers.saved', {}, ['providers.saved'])
              .then((result) => {
                const values = entries(result['providers']);
                setProviders(values);
                if (!values.some((item) => item['id'] === providerId))
                  setProviderId(String(values[0]?.['id'] ?? ''));
                else void load();
              })
              .catch((error) => setError(String(error)));
          }}
        >
          <RefreshCw size={14} />
          {t('modelCatalog.refresh')}
        </button>
        <button
          type="button"
          className="button primary"
          disabled={loading || busy || !!editor || remove || !provider['id'] || blockedDraft}
          onClick={() => {
            setError('');
            setEditor(makeEditor(''));
          }}
        >
          <Plus size={14} />
          {t('modelCatalog.add')}
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={loading || busy || !!editor || remove || !provider['id'] || blockedDraft}
          onClick={() => setRegistrySearch((value) => !value)}
        >
          {t('modelCatalog.registry')}
        </button>
        <ModelDraftAdministration
          profile={profile}
          savedProviders={providerIds}
          disabled={busy || !!editor || remove}
          onOpenProvider={(id) => {
            setProviderId(id);
            setQuery('');
          }}
        />
      </div>
      {providerId && !editor && (
        <ModelDraftNotice
          state={modelDraft.state}
          controller={modelDraft.controller}
          editing={false}
          busy={busy}
          onResume={() => setEditorValue(modelDraft.state.value)}
          onResolved={() => {}}
          onDiscard={() => {
            void dismissEditor();
          }}
        />
      )}
      {providerId && !editor && (
        <LegacyModelDraftNotice
          key={providerId}
          providerId={providerId}
          profileName={profile.name}
          controller={modelDraft.controller}
          onCopied={() => {
            setEditorValue(modelDraft.controller.snapshot().value);
            setError('');
          }}
        />
      )}
      {registrySearch && (
        <CatalogModelSearch
          key={providerId}
          providerId={providerId}
          command={command}
          existing={Object.keys(definitions)}
          onClose={() => setRegistrySearch(false)}
          onSelect={(id, seed) => {
            const draft = modelEditorDraft(id, seed);
            setError('');
            setEditor({ originalId: id, initial: undefined, draft, baseline: draft });
            setRegistrySearch(false);
          }}
        />
      )}
      {error && !editor && (
        <p className="session-error" role="alert">
          {localizedText(error, 'settingsMessage', t)}
        </p>
      )}
      {notice && (
        <p className="studio-notice" role="status">
          <Check size={14} />
          {notice}
        </p>
      )}
      {loading ? (
        <p role="status">{t('modelCatalog.loading')}</p>
      ) : (
        providerId && (
          <div className="model-catalog-layout">
            <aside className="model-catalog-list">
              <label>
                <Search size={14} />
                {t('modelCatalog.search')}
                <input
                  aria-label={t('modelCatalog.searchLabel')}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
              <small>
                {t('modelCatalog.counts', {
                  models: rows.length,
                  definitions: Object.keys(definitions).length,
                })}
              </small>
              {rows
                .filter((item) =>
                  `${item.id} ${item.name}`.toLowerCase().includes(query.toLowerCase()),
                )
                .map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    aria-pressed={selected === item.id}
                    disabled={busy || remove || blockedDraft}
                    onClick={() => {
                      setSelected(item.id);
                      setError('');
                    }}
                  >
                    <strong>{item.name}</strong>
                    <span>{item.id}</span>
                    <small>
                      {Object.hasOwn(definitions, item.id)
                        ? t('modelCatalog.savedDefinition')
                        : t('modelCatalog.providerCatalog')}
                    </small>
                  </button>
                ))}
              {!rows.length && <p>{t('modelCatalog.noModels')}</p>}
            </aside>
            <article className="model-catalog-detail">
              {current ? (
                <>
                  <span className="eyebrow">
                    {definition ? t('modelCatalog.savedEyebrow') : t('modelCatalog.catalogEyebrow')}
                  </span>
                  <h3>{current.name}</h3>
                  <code>{current.id}</code>
                  {typeof md['description'] === 'string' && <p>{md['description']}</p>}
                  <dl className="model-metrics">
                    {[
                      [
                        'limit.context',
                        limit['context'] ?? caps['maxContext'] ?? current['contextWindow'],
                      ],
                      [
                        'limit.output',
                        limit['output'] ?? definition?.['maxOutput'] ?? current['maxOutput'],
                      ],
                      ['limit.input', limit['input']],
                      ['cost.input', cost['input'] ?? current['inputCost'], true],
                      ['cost.output', cost['output'] ?? current['outputCost'], true],
                      ['cost.cache_read', cost['cache_read'], true],
                    ].map(([key, value, price]) => (
                      <div key={String(key)}>
                        <dt>{t(`modelCatalog.number.${String(key)}`)}</dt>
                        <dd>{metric(value, price === true)}</dd>
                      </div>
                    ))}
                  </dl>
                  <SavedModelPriceTiers cost={cost} />
                  {definition && (
                    <details className="model-advanced-fields">
                      <summary>{t('modelCatalog.advanced')}</summary>
                      <dl className="model-info">
                        <div>
                          <dt>{t('modelCatalog.reasoningPolicy')}</dt>
                          <dd>
                            {advancedModel.runtimePolicy === 'preserve'
                              ? t('modelCatalog.explicitPolicy')
                              : t('modelCatalog.catalogControls')}
                          </dd>
                        </div>
                        <div>
                          <dt>{t('modelCatalog.reasoningControls')}</dt>
                          <dd>
                            {advancedModel.options.length
                              ? advancedModel.options
                                  .map((option) =>
                                    option.type === 'effort'
                                      ? t('modelCatalog.effort', {
                                          values:
                                            option.values.join(', ') ||
                                            t('modelCatalog.providerVocabulary'),
                                        })
                                      : option.type === 'budget_tokens'
                                        ? t('modelCatalog.tokenBudget', {
                                            min: option.min || t('modelCatalog.providerMin'),
                                            max: option.max || t('modelCatalog.providerMax'),
                                          })
                                        : t('modelCatalog.toggle'),
                                  )
                                  .join(' · ')
                              : t('modelCatalog.inheritCatalog')}
                          </dd>
                        </div>
                        {advancedModel.runtimePolicy === 'preserve' && (
                          <>
                            <div>
                              <dt>{t('modelCatalog.runtimeDefault')}</dt>
                              <dd>{advancedModel.runtime.default.replaceAll('_', ' ')}</dd>
                            </div>
                            <div>
                              <dt>{t('modelCatalog.disableReasoning')}</dt>
                              <dd>
                                {advancedModel.runtime.disableSupported
                                  ? t('modelCatalog.supported')
                                  : t('modelCatalog.notSupported')}
                              </dd>
                            </div>
                            <div>
                              <dt>{t('modelCatalog.effortSupport')}</dt>
                              <dd>
                                {advancedModel.runtime.effortSupported === 'true'
                                  ? advancedModel.runtime.effortLevels.join(', ') ||
                                    t('modelCatalog.noLevels')
                                  : advancedModel.runtime.effortSupported === 'false'
                                    ? t('modelCatalog.notSupported')
                                    : t('modelCatalog.undocumented')}
                              </dd>
                            </div>
                            <div>
                              <dt>{t('modelCatalog.thinkingRetention')}</dt>
                              <dd>{advancedModel.runtime.preserveThinking.replaceAll('_', ' ')}</dd>
                            </div>
                          </>
                        )}
                        <div>
                          <dt>{t('modelCatalog.interleaved')}</dt>
                          <dd>
                            {advancedModel.interleaved === 'field'
                              ? t('modelCatalog.replay', {
                                  field:
                                    advancedModel.field || t('modelCatalog.providerDefaultField'),
                                })
                              : advancedModel.interleaved === 'inherit'
                                ? t('modelCatalog.inheritCatalog')
                                : advancedModel.interleaved === 'true'
                                  ? t('modelCatalog.supported')
                                  : t('modelCatalog.notSupported')}
                          </dd>
                        </div>
                        <div>
                          <dt>{t('modelCatalog.lifecycle')}</dt>
                          <dd>
                            {advancedModel.status || t('modelCatalog.inheritCatalog')}
                            {advancedModel.experimental === 'true'
                              ? ` · ${t('modelCatalog.experimental')}`
                              : advancedModel.experimental === 'false'
                                ? ` · ${t('modelCatalog.notExperimental')}`
                                : ''}
                          </dd>
                        </div>
                        <div>
                          <dt>{t('modelCatalog.sdk')}</dt>
                          <dd>{advancedModel.npm || t('modelCatalog.inheritProvider')}</dd>
                        </div>
                        <div>
                          <dt>{t('modelCatalog.api')}</dt>
                          <dd>{advancedModel.api || t('modelCatalog.inheritProvider')}</dd>
                        </div>
                        {modelNumberFields
                          .filter(
                            ([group, key]) =>
                              group === 'cost' && !['input', 'output', 'cache_read'].includes(key),
                          )
                          .map(
                            ([group, key, label]) =>
                              typeof cost[key] === 'number' && (
                                <div key={key}>
                                  <dt>
                                    {t(`modelCatalog.number.${group}.${key}`, {
                                      defaultValue: label,
                                    })}
                                  </dt>
                                  <dd>{metric(cost[key], true)}</dd>
                                </div>
                              ),
                          )}
                      </dl>
                    </details>
                  )}
                  <h4>{t('modelCatalog.capabilities')}</h4>
                  <div className="model-capabilities">
                    {(Array.isArray(current['capabilities']) ? current['capabilities'] : []).map(
                      (cap) => (
                        <span key={String(cap)}>{String(cap)}</span>
                      ),
                    )}
                  </div>
                  <dl className="model-info">
                    {modelFlags.map(([key, label]) => (
                      <div key={key}>
                        <dt>{t(`modelCatalog.flag.${key}`, { defaultValue: label })}</dt>
                        <dd>
                          {typeof md[key] === 'boolean'
                            ? md[key]
                              ? t('modelCatalog.supported')
                              : t('modelCatalog.notSupported')
                            : t('modelCatalog.notSpecified')}
                        </dd>
                      </div>
                    ))}
                    <div>
                      <dt>{t('modelCatalog.effortLevels')}</dt>
                      <dd>
                        {Array.isArray(current['reasoningEffortLevels'])
                          ? current['reasoningEffortLevels'].join(', ')
                          : current['effortSupported'] === false
                            ? t('modelCatalog.notSupported')
                            : t('modelCatalog.notReported')}
                      </dd>
                    </div>
                    {['input', 'output'].map((direction) => (
                      <div key={direction}>
                        <dt>
                          {direction === 'input'
                            ? t('modelCatalog.inputModalities')
                            : t('modelCatalog.outputModalities')}
                        </dt>
                        <dd>
                          {Array.isArray(record(md['modalities'])[direction])
                            ? (record(md['modalities'])[direction] as string[]).join(', ')
                            : t('modelCatalog.notReported')}
                        </dd>
                      </div>
                    ))}
                    {modelTextFields.slice(2).map(([key, label]) => (
                      <div key={key}>
                        <dt>{t(`modelCatalog.field.${key}`, { defaultValue: label })}</dt>
                        <dd>
                          {String(
                            md[key] ??
                              current[key === 'release_date' ? 'releaseDate' : key] ??
                              t('modelCatalog.notReported'),
                          )}
                        </dd>
                      </div>
                    ))}
                  </dl>
                  <div className="sdd-actions">
                    <button
                      type="button"
                      className="button secondary"
                      disabled={busy || remove || blockedDraft}
                      onClick={() => {
                        setError('');
                        setEditor(makeEditor(selected, definition, current.name));
                      }}
                    >
                      {t('modelCatalog.edit')}
                    </button>
                    {definition && (
                      <button
                        type="button"
                        className="button secondary danger"
                        disabled={busy}
                        onClick={() => setRemove(true)}
                      >
                        {t('modelCatalog.removeCustom')}
                      </button>
                    )}
                  </div>
                  {remove && (
                    <div className="model-remove-confirm">
                      <p>
                        <Trans
                          i18n={surfaceI18n}
                          ns="desktop"
                          i18nKey="modelCatalog.removeAsk"
                          values={{ id: selected }}
                          components={{ strong: <strong /> }}
                        />
                      </p>
                      <button
                        type="button"
                        className="button secondary"
                        disabled={busy}
                        onClick={() => setRemove(false)}
                      >
                        {t('modelCatalog.keep')}
                      </button>
                      <button
                        type="button"
                        className="button primary"
                        disabled={busy}
                        onClick={() => void mutate('remove')}
                      >
                        {t('modelCatalog.confirmRemove')}
                      </button>
                    </div>
                  )}
                </>
              ) : (
                <p>{t('modelCatalog.selectHint')}</p>
              )}
            </article>
          </div>
        )
      )}
      {editor && (
        <Modal onClose={closeEditor}>
          <header>
            <div>
              <span className="eyebrow">
                {profile.name} · {providerId}
              </span>
              <h2 id="dialog-title">
                {editor.draft.id ? t('modelCatalog.editorTitle') : t('modelCatalog.add')}
              </h2>
            </div>
            <button
              type="button"
              className="icon-button"
              aria-label={t('modelCatalog.close')}
              disabled={busy}
              onClick={closeEditor}
            >
              <X size={16} />
            </button>
          </header>
          <form
            className="model-editor"
            onSubmit={(event) => {
              event.preventDefault();
              void mutate('save');
            }}
          >
            <p>{t('modelCatalog.blankHint')}</p>
            <ModelDraftNotice
              state={modelDraft.state}
              controller={modelDraft.controller}
              editing
              busy={busy}
              onResume={() => {}}
              onDiscard={() => {
                void dismissEditor();
              }}
              onResolved={() => setEditorValue(modelDraft.controller.snapshot().value)}
            />
            <fieldset disabled={busy}>
              <label>
                {t('modelCatalog.modelId')}
                <input
                  aria-label={t('modelCatalog.modelIdLabel')}
                  required
                  value={editor.draft.id}
                  disabled={!!editor.originalId}
                  onChange={(event) =>
                    setEditor({ ...editor, draft: { ...editor.draft, id: event.target.value } })
                  }
                />
              </label>
              <div className="model-editor-grid">
                {modelTextFields.map(([key, label]) => (
                  <label key={key}>
                    {t(`modelCatalog.field.${key}`, { defaultValue: label })}
                    <input
                      aria-label={t(`modelCatalog.fieldLabel.${key}`, {
                        defaultValue: `Model ${label.toLowerCase()}`,
                      })}
                      required={key === 'name'}
                      value={editor.draft.text[key] ?? ''}
                      onChange={(event) =>
                        setEditor({
                          ...editor,
                          draft: {
                            ...editor.draft,
                            text: { ...editor.draft.text, [key]: event.target.value },
                          },
                        })
                      }
                    />
                  </label>
                ))}
              </div>
              <h3>{t('modelCatalog.limitsPricing')}</h3>
              <div className="model-editor-grid">
                {modelNumberFields.map(([group, key, label]) => (
                  <label key={`${group}.${key}`}>
                    {t(`modelCatalog.number.${group}.${key}`, { defaultValue: label })}
                    <input
                      aria-label={t(`modelCatalog.number.${group}.${key}`, { defaultValue: label })}
                      type="number"
                      min={0}
                      step={group === 'limit' ? 1 : 'any'}
                      disabled={
                        group === 'cost' && !!editorCost[key] && typeof editorCost[key] === 'object'
                      }
                      placeholder={
                        group === 'cost' && typeof editorCost[key] === 'object'
                          ? t('modelCatalog.structured')
                          : undefined
                      }
                      value={editor.draft.numbers[`${group}.${key}`] ?? ''}
                      onChange={(event) =>
                        setEditor({
                          ...editor,
                          draft: {
                            ...editor.draft,
                            numbers: {
                              ...editor.draft.numbers,
                              [`${group}.${key}`]: event.target.value,
                            },
                          },
                        })
                      }
                    />
                  </label>
                ))}
              </div>
              <ModelPriceTiers
                value={editor.draft.pricing}
                legacySchedule={editorCost['context_over_200k']}
                onChange={(pricing) =>
                  setEditor({ ...editor, draft: { ...editor.draft, pricing } })
                }
              />
              <h3>{t('modelCatalog.capabilities')}</h3>
              <div className="model-editor-grid">
                {modelFlags.map(([key, label]) => (
                  <label key={key}>
                    {t(`modelCatalog.flag.${key}`, { defaultValue: label })}
                    <select
                      aria-label={t(`modelCatalog.flagLabel.${key}`, {
                        defaultValue: `Model ${label.toLowerCase()}`,
                      })}
                      value={editor.draft.flags[key]}
                      onChange={(event) =>
                        setEditor({
                          ...editor,
                          draft: {
                            ...editor.draft,
                            flags: { ...editor.draft.flags, [key]: event.target.value },
                          },
                        })
                      }
                    >
                      <option value="inherit">{t('modelCatalog.inheritUnspecified')}</option>
                      <option value="true">{t('modelCatalog.supported')}</option>
                      <option value="false">{t('modelCatalog.notSupported')}</option>
                    </select>
                  </label>
                ))}
              </div>
              <h3>{t('modelCatalog.modalities')}</h3>
              <p>{t('modelCatalog.modalitiesHelp')}</p>
              <div className="model-editor-grid">
                {(['input', 'output'] as const).map((key) => (
                  <label key={key}>
                    {key === 'input'
                      ? t('modelCatalog.inputModalities')
                      : t('modelCatalog.outputModalities')}
                    <input
                      aria-label={
                        key === 'input'
                          ? t('modelCatalog.inputModalitiesLabel')
                          : t('modelCatalog.outputModalitiesLabel')
                      }
                      value={editor.draft[key]}
                      onChange={(event) =>
                        setEditor({
                          ...editor,
                          draft: { ...editor.draft, [key]: event.target.value },
                        })
                      }
                    />
                  </label>
                ))}
              </div>
              <ModelAdvancedFields
                value={editor.draft.advanced}
                onChange={(advanced) =>
                  setEditor({ ...editor, draft: { ...editor.draft, advanced } })
                }
              />
            </fieldset>
            {error && (
              <p className="session-error" role="alert">
                {error}
              </p>
            )}
            {discard ? (
              <div>
                <p>{t('modelCatalog.discardAsk')}</p>
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => setDiscard(false)}
                >
                  {t('modelCatalog.keepEditing')}
                </button>
                <button
                  type="button"
                  className="button secondary danger"
                  disabled={busy}
                  onClick={() => {
                    void dismissEditor();
                  }}
                >
                  {t('modelCatalog.discard')}
                </button>
              </div>
            ) : (
              <footer>
                <button
                  type="button"
                  className="button secondary"
                  disabled={busy}
                  onClick={closeEditor}
                >
                  {t('modelCatalog.cancel')}
                </button>
                <button
                  type="submit"
                  className="button primary"
                  disabled={
                    busy ||
                    !modelDraft.state.ready ||
                    !!modelDraft.state.review ||
                    !!modelDraft.state.error
                  }
                >
                  {busy ? t('modelCatalog.saving') : t('modelCatalog.save')}
                </button>
              </footer>
            )}
          </form>
        </Modal>
      )}
    </section>
  );
}
