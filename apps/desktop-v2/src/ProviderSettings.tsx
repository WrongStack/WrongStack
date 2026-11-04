import { Check, KeyRound, LoaderCircle, Plus, RefreshCw, Server } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand, EngineSend } from './engine-operations';
import type { EngineState } from './engine-state';
import { entries } from './engine-values';
import { ProviderCloudSettings } from './ProviderCloudSettings';
import { ProviderConnectionWiring } from './ProviderConnectionWiring';
import { ProviderOAuth } from './ProviderOAuth';
import { ProviderProbe } from './ProviderProbe';
import { buildProviderSave, providerChoices, providerModels } from './provider-settings-model';
import './provider-management.css';

export function ProviderSettings({
  state,
  send,
  command,
  onError,
  onConfigured,
}: {
  state: EngineState;
  send: EngineSend;
  command: EngineCommand;
  onError: (error: unknown) => void;
  onConfigured: (provider: string, model: string) => void;
}) {
  const { t } = useDesktopText();
  const [selected, setSelected] = useState(state.needsSetup ? '' : state.provider);
  const [model, setModel] = useState(state.needsSetup ? '' : state.model);
  const selectionEdited = useRef(false);
  useEffect(() => {
    if (selectionEdited.current || state.needsSetup || !state.provider) return;
    setSelected(state.provider);
    setModel(state.model);
  }, [state.provider, state.model, state.needsSetup]);
  const [mode, setMode] = useState<'preset' | 'custom'>('preset');
  const [preset, setPreset] = useState('');
  const [id, setId] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [customModel, setCustomModel] = useState('');
  const [tools, setTools] = useState(false);
  const [vision, setVision] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [label, setLabel] = useState('desktop');
  const [pending, setPending] = useState(false);
  const managementBusy = useRef(false);
  const [confirmation, setConfirmation] = useState<{ providerId: string; label?: string } | null>(
    null,
  );
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const providers = providerChoices(state);
  const models = providerModels(state, selected);
  const refresh = () => {
    void Promise.all([send('providers.list'), send('providers.saved')]).catch(onError);
  };
  useEffect(() => {
    if (state.connected)
      void Promise.all([send('providers.list'), send('providers.saved')]).catch(onError);
  }, [state.connected, send, onError]);
  useEffect(() => {
    if (state.connected && selected)
      void send('provider.models', { providerId: selected }).catch(onError);
  }, [selected, state.connected, send, onError]);
  const useModel = async (provider: string, modelId: string) => {
    await command('model.switch', { provider, model: modelId }, ['model.switch_result']);
    onConfigured(provider, modelId);
  };
  const activate = async () => {
    if (!selected || !model.trim()) return;
    setPending(true);
    setStatus(null);
    try {
      await useModel(selected, model.trim());
    } catch (error) {
      setStatus({ ok: false, text: error instanceof Error ? error.message : String(error) });
    } finally {
      setPending(false);
    }
  };
  const save = async () => {
    setStatus(null);
    let message: ReturnType<typeof buildProviderSave>;
    try {
      message = buildProviderSave(
        {
          mode,
          id: mode === 'preset' ? preset : id,
          apiKey,
          label,
          baseUrl,
          model: customModel,
          supportsTools: tools,
          supportsVision: vision,
        },
        {
          id: t('providerSettings.error.id'),
          keyAndLabel: t('providerSettings.error.keyAndLabel'),
          url: t('providerSettings.error.url'),
          credentials: t('providerSettings.error.credentials'),
          model: t('providerSettings.error.model'),
        },
      );
    } catch (error) {
      setStatus({ ok: false, text: error instanceof Error ? error.message : String(error) });
      return;
    }
    setApiKey('');
    setPending(true);
    try {
      const reply = await command(message.type, message.payload, ['key.operation_result']);
      const providerId = mode === 'preset' ? preset : id.trim();
      selectionEdited.current = true;
      setSelected(providerId);
      setStatus({ ok: true, text: String(reply['message'] ?? t('providerSettings.saved')) });
      refresh();
      if (mode === 'custom') {
        setModel(customModel.trim());
        await useModel(providerId, customModel.trim());
      }
    } catch (error) {
      setStatus({ ok: false, text: error instanceof Error ? error.message : String(error) });
    } finally {
      setPending(false);
    }
  };
  const manage = async (
    type: 'key.set_active' | 'key.delete' | 'provider.remove',
    providerId: string,
    keyLabel?: string,
  ) => {
    if (managementBusy.current || pending) return;
    managementBusy.current = true;
    setPending(true);
    setStatus(null);
    try {
      await command(type, { providerId, ...(keyLabel ? { label: keyLabel } : {}) }, [
        'key.operation_result',
      ]);
      const saved = await command('providers.saved', {}, ['providers.saved']);
      const provider = entries(saved['providers']).find((item) => item['id'] === providerId);
      const keys = entries(provider?.['apiKeys']);
      const verified =
        type === 'provider.remove'
          ? !provider
          : type === 'key.delete'
            ? !!provider && !keys.some((item) => item['label'] === keyLabel)
            : keys.some((item) => item['label'] === keyLabel && item['isActive'] === true);
      if (!verified) throw Error(t('providerSettings.unverified'));
      setConfirmation(null);
      if (type === 'provider.remove' && selected === providerId) {
        selectionEdited.current = true;
        setSelected('');
        setModel('');
      }
      setStatus({
        ok: true,
        text:
          type === 'key.set_active'
            ? t('providerSettings.activeChanged')
            : type === 'key.delete'
              ? t('providerSettings.keyDeleted')
              : t('providerSettings.removed'),
      });
    } catch (error) {
      setStatus({ ok: false, text: error instanceof Error ? error.message : String(error) });
    } finally {
      managementBusy.current = false;
      setPending(false);
    }
  };
  return (
    <section
      className="engine-data-view provider-settings"
      aria-label={t('providerSettings.label')}
    >
      <header className="provider-heading">
        <div>
          <span className="eyebrow">{t('providerSettings.eyebrow')}</span>
          <h2>
            {state.needsSetup ? t('providerSettings.firstTitle') : t('providerSettings.title')}
          </h2>
          <p>{t('providerSettings.intro')}</p>
        </div>
        <button
          type="button"
          className="icon-button"
          title={t('providerSettings.refresh')}
          onClick={refresh}
          disabled={!state.connected || pending}
        >
          <RefreshCw size={15} />
        </button>
      </header>
      {status && (
        <p
          role={status.ok ? 'status' : 'alert'}
          className={`provider-result ${status.ok ? 'saved' : 'failed'}`}
        >
          {status.ok && <Check size={14} />} {status.text}
        </p>
      )}
      <ProviderOAuth command={command} send={send} status={state.results['auth.oauth.status']} />
      <div className="provider-grid">
        <section className="provider-card">
          <div className="provider-card-title">
            <Server size={18} />
            <h3>{t('providerSettings.defaultModel')}</h3>
          </div>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void activate();
            }}
          >
            <label>
              {t('providerSettings.provider')}
              <select
                aria-label={t('providerSettings.defaultProvider')}
                required
                value={selected}
                onChange={(event) => {
                  selectionEdited.current = true;
                  setSelected(event.target.value);
                  setModel('');
                }}
                disabled={pending}
              >
                <option value="">{t('providerSettings.chooseProvider')}</option>
                {providers.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.name}
                    {provider.saved ? ` · ${t('providerSettings.savedTag')}` : ''}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t('providerSettings.model')}
              <input
                aria-label={t('providerSettings.defaultModel')}
                required
                list="native-model-catalog"
                value={model}
                onChange={(event) => {
                  selectionEdited.current = true;
                  setModel(event.target.value);
                }}
                placeholder={
                  selected
                    ? t('providerSettings.modelPlaceholder')
                    : t('providerSettings.providerFirst')
                }
                disabled={!selected || pending}
              />
              <datalist id="native-model-catalog">
                {models.map((entry) => (
                  <option value={entry.id} key={entry.id}>
                    {entry.name}
                  </option>
                ))}
              </datalist>
            </label>
            <p className="provider-hint">
              {selected
                ? t(
                    models.length === 1
                      ? 'providerSettings.modelsOne'
                      : 'providerSettings.modelsMany',
                    {
                      n: models.length,
                    },
                  )
                : t('providerSettings.catalogHint')}
            </p>
            <button
              type="submit"
              className="button primary"
              disabled={!state.connected || pending || !selected || !model.trim()}
            >
              {pending ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}
              {t('providerSettings.useModel')}
            </button>
          </form>
          {providers.some((provider) => provider.saved) && (
            <div className="saved-provider-list">
              <h4>{t('providerSettings.savedConnections')}</h4>
              {providers
                .filter((provider) => provider.saved)
                .map((provider) => (
                  <article key={provider.id}>
                    <button
                      type="button"
                      onClick={() => {
                        selectionEdited.current = true;
                        setSelected(provider.id);
                        setModel('');
                      }}
                      disabled={pending}
                    >
                      <strong>{provider.name}</strong>
                      <span className="saved-provider-family">{provider.family}</span>
                    </button>
                    {provider.keys.length ? (
                      provider.keys.map((key) => (
                        <div className="saved-key" key={key.label}>
                          <KeyRound size={11} />
                          <span>{key.label}</span>
                          {key.authMethod === 'oauth' && (
                            <small>{t('providerSettings.subscription')}</small>
                          )}
                          {key.expiresAt && (
                            <small>{t('providerSettings.expires', { date: key.expiresAt })}</small>
                          )}
                          <code>{key.maskedKey}</code>
                          {key.active && <small>{t('providerSettings.active')}</small>}
                          <div className="saved-key-actions">
                            {!key.active && (
                              <button
                                type="button"
                                className="button secondary small"
                                disabled={pending}
                                aria-label={t('providerSettings.useKeyLabel', {
                                  label: key.label,
                                  provider: provider.id,
                                })}
                                onClick={() =>
                                  void manage('key.set_active', provider.id, key.label)
                                }
                              >
                                {t('providerSettings.useKey')}
                              </button>
                            )}
                            <button
                              type="button"
                              className="button secondary small"
                              disabled={pending}
                              aria-label={t('providerSettings.deleteKeyLabel', {
                                label: key.label,
                                provider: provider.id,
                              })}
                              onClick={() =>
                                setConfirmation({ providerId: provider.id, label: key.label })
                              }
                            >
                              {key.authMethod === 'oauth'
                                ? t('providerSettings.removeSignIn')
                                : t('providerSettings.deleteKey')}
                            </button>
                          </div>
                        </div>
                      ))
                    ) : (
                      <p className="provider-hint">{t('providerSettings.noKey')}</p>
                    )}
                    <button
                      type="button"
                      className="provider-remove-button"
                      disabled={pending}
                      aria-label={t('providerSettings.removeConnectionLabel', {
                        provider: provider.id,
                      })}
                      onClick={() => setConfirmation({ providerId: provider.id })}
                    >
                      {t('providerSettings.removeConnection')}
                    </button>
                    {confirmation?.providerId === provider.id && (
                      <fieldset
                        className="provider-management-confirm"
                        aria-label={t('providerSettings.confirmLabel')}
                      >
                        <p>
                          {confirmation.label
                            ? t('providerSettings.deleteKeyAsk', {
                                label: confirmation.label,
                                provider: provider.id,
                              })
                            : t('providerSettings.removeAsk', { provider: provider.id })}
                        </p>
                        <div className="sdd-actions">
                          <button
                            type="button"
                            className="button secondary"
                            disabled={pending}
                            onClick={() => setConfirmation(null)}
                          >
                            {t('providerSettings.keepConnection')}
                          </button>
                          <button
                            type="button"
                            className="button secondary danger"
                            disabled={pending}
                            onClick={() =>
                              void manage(
                                confirmation.label ? 'key.delete' : 'provider.remove',
                                provider.id,
                                confirmation.label,
                              )
                            }
                          >
                            {confirmation.label
                              ? t('providerSettings.confirmDeleteKey')
                              : t('providerSettings.confirmRemove')}
                          </button>
                        </div>
                      </fieldset>
                    )}
                    <ProviderProbe providerId={provider.id} command={command} />
                    <ProviderConnectionWiring provider={provider} command={command} />
                    <ProviderCloudSettings provider={provider} command={command} />
                  </article>
                ))}
            </div>
          )}
        </section>
        <section className="provider-card">
          <div className="provider-card-title">
            <KeyRound size={18} />
            <h3>{t('providerSettings.addTitle')}</h3>
          </div>
          <div className="provider-mode">
            <button
              type="button"
              aria-pressed={mode === 'preset'}
              className={mode === 'preset' ? 'chosen-tab' : ''}
              onClick={() => {
                setMode('preset');
                setApiKey('');
                setStatus(null);
              }}
              disabled={pending}
            >
              {t('providerSettings.presetMode')}
            </button>
            <button
              type="button"
              aria-pressed={mode === 'custom'}
              className={mode === 'custom' ? 'chosen-tab' : ''}
              onClick={() => {
                setMode('custom');
                setApiKey('');
                setStatus(null);
              }}
              disabled={pending}
            >
              {t('providerSettings.customMode')}
            </button>
          </div>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            {mode === 'preset' ? (
              <label>
                {t('providerSettings.provider')}
                <select
                  aria-label={t('providerSettings.credentialProvider')}
                  required
                  value={preset}
                  onChange={(event) => {
                    setPreset(event.target.value);
                    setApiKey('');
                  }}
                  disabled={pending}
                >
                  <option value="">{t('providerSettings.chooseProvider')}</option>
                  {providers.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <>
                <label>
                  {t('providerSettings.providerId')}
                  <input
                    aria-label={t('providerSettings.providerIdLabel')}
                    required
                    value={id}
                    onChange={(event) => setId(event.target.value)}
                    placeholder="my-local-model"
                    disabled={pending}
                  />
                </label>
                <label>
                  {t('providerSettings.baseUrl')}
                  <input
                    aria-label={t('providerSettings.baseUrlLabel')}
                    type="url"
                    required
                    value={baseUrl}
                    onChange={(event) => setBaseUrl(event.target.value)}
                    placeholder="http://localhost:11434/v1"
                    disabled={pending}
                  />
                </label>
                <label>
                  {t('providerSettings.modelId')}
                  <input
                    aria-label={t('providerSettings.modelIdLabel')}
                    required
                    value={customModel}
                    onChange={(event) => setCustomModel(event.target.value)}
                    placeholder={t('providerSettings.modelIdPlaceholder')}
                    disabled={pending}
                  />
                </label>
                <label className="provider-checkbox">
                  <input
                    type="checkbox"
                    checked={tools}
                    onChange={(event) => setTools(event.target.checked)}
                    disabled={pending}
                  />
                  {t('providerSettings.tools')}
                </label>
                <label className="provider-checkbox">
                  <input
                    type="checkbox"
                    checked={vision}
                    onChange={(event) => setVision(event.target.checked)}
                    disabled={pending}
                  />
                  {t('providerSettings.vision')}
                </label>
                <p className="provider-hint">{t('providerSettings.customHint')}</p>
              </>
            )}
            <label>
              {t('providerSettings.apiKey')}{' '}
              {mode === 'custom' && (
                <span className="field-hint">{t('providerSettings.apiKeyOptional')}</span>
              )}
              <input
                aria-label={t('providerSettings.apiKeyLabel')}
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                required={mode === 'preset'}
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                disabled={pending}
                placeholder={t('providerSettings.apiKeyPlaceholder')}
              />
            </label>
            {mode === 'preset' && (
              <label>
                {t('providerSettings.keyLabel')}
                <input
                  aria-label={t('providerSettings.keyLabel')}
                  required
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                  disabled={pending}
                />
              </label>
            )}
            <button type="submit" className="button primary" disabled={!state.connected || pending}>
              {pending ? <LoaderCircle size={14} className="spin" /> : <Plus size={14} />}{' '}
              {mode === 'custom' ? t('providerSettings.saveAndUse') : t('providerSettings.saveKey')}
            </button>
          </form>
        </section>
      </div>
    </section>
  );
}
