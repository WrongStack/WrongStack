import { Columns3, LoaderCircle, RefreshCw, Search, Settings2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import { type EngineState, emptyEngineState } from './engine-state';
import { entries } from './engine-values';
import { type ComparedModel, ModelComparison } from './ModelComparison';
import { MAX_COMPARED_MODELS, toggleCompared } from './model-comparison';
import {
  MODEL_DETAIL_WORDS,
  type ModelDetailWords,
  modelDetailLine,
  type PickerModel,
  pickerModel,
} from './model-picker-details';
import {
  RECENT_MODELS_KEY,
  type RecentModel,
  readRecentModels,
  withRecentModel,
} from './model-recents';
import { modelListed, providerDisabled, selectableCatalogModels } from './model-visibility';
import { emptyModelPolicy, mergeModelPolicy, readProfileModelPolicy } from './profile-model-policy';
import { providerChoices } from './provider-settings-model';
import { RuntimeGate } from './RuntimeGate';
import { useProfileEngine } from './useEngine';
import './composer-dialog.css';
import { AgentRuntimeBadge } from '@wrongstack/project-surfaces/ui/AgentRuntimeBadge';

interface Props {
  session: EngineState;
  sessionCommand?: EngineCommand;
  onPick?: (provider: string, model: string) => void | Promise<void>;
  title?: string;
  description?: string;
  providerLabel?: string;
  searchLabel?: string;
  onClose: () => void;
  onSettings?: () => void;
  onBusy: (value: boolean) => void;
}
export function ProfileModelPicker(props: Props) {
  const { t } = useDesktopText();
  return (
    <RuntimeGate scope="profile" loadingTitle={t('modelPicker.loadingTitle')}>
      <LiveProfileModelPicker {...props} />
    </RuntimeGate>
  );
}
function LiveProfileModelPicker({
  session,
  sessionCommand,
  onPick,
  title,
  description,
  providerLabel,
  searchLabel,
  onClose,
  onSettings,
  onBusy,
}: Props) {
  const { t } = useDesktopText();
  const details: ModelDetailWords = {
    context: (value) => t('modelPicker.detail.context', { value }),
    output: (value) => t('modelPicker.detail.output', { value }),
    noPrice: () => t('modelPicker.detail.noPrice'),
    price: (input, output) => t('modelPicker.detail.price', { input, output }),
    capability: (id) =>
      t(`modelPicker.detail.${id}`, { defaultValue: MODEL_DETAIL_WORDS.capability(id) }),
  };
  const [error, setError] = useState('');
  const reportError = useCallback(
    (error: unknown) => setError(error instanceof Error ? error.message : String(error)),
    [],
  );
  const profile = useProfileEngine(reportError);
  const [policy, setPolicy] = useState(emptyModelPolicy),
    [ready, setReady] = useState(false);
  const policyRef = useRef(policy);
  policyRef.current = policy;
  const [catalog, setCatalog] = useState<Record<string, unknown>>({}),
    [saved, setSaved] = useState<Record<string, unknown>>({});
  const [provider, setProvider] = useState(session.provider),
    [query, setQuery] = useState('');
  const [models, setModels] = useState<PickerModel[]>([]),
    [loading, setLoading] = useState(false),
    [switching, setSwitching] = useState(false),
    [revision, setRevision] = useState(0);
  // Comparison mode: rows toggle membership instead of switching; the table shows them together.
  // Picks survive a provider change, so models of different providers can be compared.
  const [comparing, setComparing] = useState(false),
    [compared, setCompared] = useState<ComparedModel[]>([]),
    [comparisonOpen, setComparisonOpen] = useState(false);
  const mounted = useRef(true),
    sequence = useRef(0),
    refreshSequence = useRef(0),
    lastPrefs = useRef<Record<string, unknown> | undefined>(undefined),
    lastSaved = useRef<Record<string, unknown> | undefined>(undefined);
  const frames = useRef(profile.state.results);
  frames.current = profile.state.results;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      sequence.current++;
      refreshSequence.current++;
    };
  }, []);
  const refresh = useCallback(async () => {
    const version = ++refreshSequence.current;
    lastPrefs.current = frames.current['prefs.updated'];
    lastSaved.current = frames.current['providers.saved'];
    setReady(false);
    setError('');
    try {
      const [prefs, providers, registry] = await Promise.all([
        readProfileModelPolicy(profile.command),
        profile.command('providers.saved', {}, ['providers.saved']),
        profile.command('providers.list', {}, ['provider.catalog']),
      ]);
      if (!mounted.current || refreshSequence.current !== version) return;
      policyRef.current = prefs;
      setPolicy(prefs);
      lastSaved.current = providers;
      setSaved(providers);
      setCatalog(registry);
      setReady(true);
      setRevision((value) => value + 1);
    } catch (error) {
      if (mounted.current && refreshSequence.current === version) reportError(error);
    }
  }, [profile.command, reportError]);
  useEffect(() => {
    if (profile.state.connected && !profile.state.hydrating) void refresh();
  }, [profile.state.connected, profile.state.hydrating, refresh]);
  const prefsFrame = profile.state.results['prefs.updated'],
    savedFrame = profile.state.results['providers.saved'];
  useEffect(() => {
    if (!ready || !prefsFrame || lastPrefs.current === prefsFrame) return;
    lastPrefs.current = prefsFrame;
    try {
      const next = mergeModelPolicy(policyRef.current, prefsFrame);
      policyRef.current = next;
      setPolicy(next);
    } catch (error) {
      setReady(false);
      reportError(error);
    }
  }, [ready, prefsFrame, reportError]);
  useEffect(() => {
    if (ready && savedFrame && lastSaved.current !== savedFrame) {
      lastSaved.current = savedFrame;
      setSaved(savedFrame);
      setRevision((value) => value + 1);
    }
  }, [ready, savedFrame]);
  useEffect(() => {
    const version = ++sequence.current;
    setModels([]);
    if (!ready || !provider) return;
    setLoading(true);
    void profile
      .command('provider.models', { providerId: provider, includeDisabled: true }, [
        'provider.models',
      ])
      .then((reply) => {
        if (!mounted.current || sequence.current !== version) return;
        if (reply['provider'] !== provider) throw Error(t('modelPicker.otherCatalog'));
        setModels(entries(reply['models']).map(pickerModel));
      })
      .catch((error) => {
        if (mounted.current && sequence.current === version) reportError(error);
      })
      .finally(() => {
        if (mounted.current && sequence.current === version) setLoading(false);
      });
    return () => {
      sequence.current++;
    };
  }, [profile.command, provider, ready, revision, reportError]);
  const choices = providerChoices({
    ...emptyEngineState,
    results: { 'providers.saved': saved, 'provider.catalog': catalog },
  }).filter((item) => !providerDisabled(policy.disabledProviders, item.id));
  const available = selectableCatalogModels(models, provider, policy).filter((item) =>
    `${item.id} ${item.name}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  // Only picks whose provider is still offered and whose model the profile still allows.
  const comparedModels = compared.filter(
    (entry) =>
      choices.some((choice) => choice.id === entry.provider) &&
      selectableCatalogModels([{ id: entry.model.id }], entry.provider, policy).length > 0,
  );
  const comparedKey = (id: string) => `${provider}/${id}`;
  const toggle = (model: PickerModel) => {
    setError('');
    const key = comparedKey(model.id);
    try {
      const keys = toggleCompared(
        compared.map((entry) => entry.key),
        key,
      );
      setCompared(
        keys.map(
          (item) => compared.find((entry) => entry.key === item) ?? { key, provider, model },
        ),
      );
    } catch {
      setError(t('modelPicker.tooMany', { number: MAX_COMPARED_MODELS }));
    }
  };
  const [recents, setRecents] = useState<RecentModel[]>(() =>
    readRecentModels(() => localStorage.getItem(RECENT_MODELS_KEY)),
  );
  // Only recents whose provider is still offered and whose model the profile still allows.
  const quickRecents = recents.filter(
    (item) =>
      choices.some((choice) => choice.id === item.provider) &&
      selectableCatalogModels([{ id: item.model }], item.provider, policy).length > 0,
  );
  const choose = async (model: string, target = provider) => {
    if (switching || !ready) return;
    setSwitching(true);
    onBusy(true);
    setError('');
    try {
      const current = await readProfileModelPolicy(profile.command);
      if (!mounted.current) return;
      setPolicy(current);
      if (!selectableCatalogModels([{ id: model }], target, current).length)
        throw Error(t('modelPicker.disabled'));
      if (onPick) await onPick(target, model);
      else if (sessionCommand)
        await sessionCommand('model.switch', { provider: target, model }, ['model.switch_result']);
      else throw Error(t('modelPicker.noTarget'));
      const next = withRecentModel(recents, { provider: target, model });
      setRecents(next);
      try {
        localStorage.setItem(RECENT_MODELS_KEY, JSON.stringify(next));
      } catch {
        // Recents are a convenience; a full or blocked store leaves them unsaved.
      }
      if (mounted.current) onClose();
    } catch (error) {
      if (mounted.current) reportError(error);
    } finally {
      onBusy(false);
      if (mounted.current) setSwitching(false);
    }
  };
  return (
    <section className="composer-dialog" aria-label={t('modelPicker.label')}>
      <header>
        <div>
          <span className="eyebrow">{t('modelPicker.eyebrow')}</span>
          <h2 id="dialog-title">{title ?? t('modelPicker.title')}</h2>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label={t('modelPicker.close')}
          disabled={switching}
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </header>
      <p>{description ?? t('modelPicker.description')}</p>
      <label>
        {t('modelPicker.provider')}
        <select
          aria-label={providerLabel ?? t('modelPicker.providerLabel')}
          value={provider}
          disabled={!ready || switching}
          onChange={(event) => setProvider(event.target.value)}
        >
          {!choices.some((item) => item.id === provider) && (
            <option value={provider}>{t('modelPicker.unavailable', { provider })}</option>
          )}
          {choices.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
              {item.saved ? t('modelPicker.saved') : ''}
            </option>
          ))}
        </select>
      </label>
      {ready && quickRecents.length > 0 && (
        <fieldset className="composer-model-recents">
          <legend>{t('modelPicker.recent')}</legend>
          {quickRecents.map((item) => (
            <button
              type="button"
              key={`${item.provider}/${item.model}`}
              className="button secondary small"
              disabled={switching}
              aria-pressed={item.provider === session.provider && item.model === session.model}
              onClick={() => void choose(item.model, item.provider)}
            >
              {item.model}
              <small>{item.provider}</small>
            </button>
          ))}
        </fieldset>
      )}
      <label className="composer-model-search search-field">
        <Search size={15} />
        <input
          aria-label={searchLabel ?? t('modelPicker.searchLabel')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('modelPicker.placeholder')}
        />
      </label>
      {error && (
        <p role="alert" className="composer-error">
          {error}
        </p>
      )}
      {comparing && !comparisonOpen && (
        <div className="model-compare-bar" role="status">
          {comparedModels.length < 2
            ? comparedModels.length
              ? t('modelPicker.pickAnother')
              : t('modelPicker.pickTwo')
            : t('modelPicker.picked', {
                models: comparedModels.length,
                providers: new Set(comparedModels.map((entry) => entry.provider)).size,
              })}
          <button
            type="button"
            className="button small"
            disabled={comparedModels.length < 2}
            onClick={() => setComparisonOpen(true)}
          >
            {t('modelPicker.show')}
          </button>
        </div>
      )}
      {comparisonOpen ? (
        <ModelComparison
          models={comparedModels}
          disabled={switching || !ready}
          onUse={(id, target) => void choose(id, target)}
          onBack={() => setComparisonOpen(false)}
        />
      ) : (
        <div className="composer-model-list">
          {error && !ready ? (
            <p>{t('modelPicker.unavailableChoices')}</p>
          ) : !ready || loading ? (
            <p>
              <LoaderCircle className="spin" size={15} /> {t('modelPicker.loading')}
            </p>
          ) : available.length ? (
            available.map((model) => (
              <button
                type="button"
                key={model.id}
                disabled={switching}
                aria-pressed={
                  comparing
                    ? compared.some((entry) => entry.key === comparedKey(model.id))
                    : provider === session.provider && model.id === session.model
                }
                onClick={() => (comparing ? toggle(model) : void choose(model.id))}
              >
                <AgentRuntimeBadge
                  provider={provider}
                  model={model.id}
                  executionRole="agent"
                  showName={false}
                />
                <strong>{model.name}</strong>
                {comparing && compared.some((entry) => entry.key === comparedKey(model.id)) && (
                  <span>{t('modelPicker.comparing')}</span>
                )}
                {modelListed(policy.favoriteModels, provider, model.id) && (
                  <span>{t('modelPicker.favorite')}</span>
                )}
                <small>{model.id}</small>
                {modelDetailLine(model, details) && (
                  <small className="composer-model-details">
                    {modelDetailLine(model, details)}
                  </small>
                )}
              </button>
            ))
          ) : (
            <p>{t('modelPicker.none')}</p>
          )}
        </div>
      )}
      <footer>
        {/* The open comparison has its own way back; one exit, not two. */}
        {!comparisonOpen && (
          <button
            type="button"
            className="button secondary"
            disabled={switching || !ready}
            aria-pressed={comparing}
            onClick={() => {
              setComparing((value) => !value);
              setCompared([]);
              setComparisonOpen(false);
            }}
          >
            <Columns3 size={14} />
            {comparing ? t('modelPicker.doneComparing') : t('modelPicker.compare')}
          </button>
        )}
        <button
          type="button"
          className="button secondary"
          disabled={switching}
          onClick={() => void refresh()}
        >
          <RefreshCw size={14} />
          {t('modelPicker.refresh')}
        </button>
        {onSettings && (
          <button
            type="button"
            className="button secondary"
            disabled={switching}
            onClick={onSettings}
          >
            <Settings2 size={14} />
            {t('modelPicker.settings')}
          </button>
        )}
      </footer>
    </section>
  );
}
