import { useEffect, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import { entries } from './engine-state';

/** The worker model an SDD run starts with; empty means the project engine's default. */
export interface SddRunModel {
  provider: string;
  model: string;
}

/** Saved providers of the profile and the catalog models of the chosen one. */
function useModelChoices(command: EngineCommand | undefined, provider: string) {
  const [providers, setProviders] = useState<string[]>([]);
  const [models, setModels] = useState<string[]>([]);
  useEffect(() => {
    if (!command) return;
    let current = true;
    void command('providers.saved', {}, ['providers.saved', 'key.operation_result'])
      .then((reply) => {
        if (current)
          setProviders(
            entries(reply['providers']).flatMap((row) =>
              typeof row['id'] === 'string' ? [row['id']] : [],
            ),
          );
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [command]);
  useEffect(() => {
    setModels([]);
    if (!command || !provider) return;
    let current = true;
    void command('provider.models', { providerId: provider }, [
      'provider.models',
      'key.operation_result',
    ])
      .then((reply) => {
        if (current)
          setModels(
            entries(reply['models']).flatMap((row) =>
              typeof row['id'] === 'string' ? [row['id']] : [],
            ),
          );
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [command, provider]);
  return { providers, models };
}

export function RunOptions({
  slots,
  setSlots,
  isolate,
  setIsolate,
  decompose,
  setDecompose,
  model,
  setModel,
  command,
}: {
  slots: number;
  setSlots: (n: number) => void;
  isolate: boolean;
  setIsolate: (v: boolean) => void;
  decompose: boolean;
  setDecompose: (v: boolean) => void;
  model: SddRunModel;
  setModel: (next: SddRunModel) => void;
  /** Reads the profile's providers and catalog models; without it the default model is used. */
  command?: EngineCommand | undefined;
}) {
  const { t } = useDesktopText();
  const { providers, models } = useModelChoices(command, model.provider);
  return (
    <div className="sdd-options">
      <label>
        {t('sddView.options.workers')}
        <input
          type="number"
          min={1}
          max={16}
          value={slots}
          onChange={(e) => setSlots(Math.max(1, Math.min(16, Number(e.target.value) || 1)))}
        />
      </label>
      {command && (
        <label>
          {t('sddView.options.model')}
          <select
            aria-label={t('sddView.options.providerLabel')}
            value={model.provider}
            onChange={(e) => setModel({ provider: e.target.value, model: '' })}
          >
            <option value="">{t('sddView.options.default')}</option>
            {[...new Set([...providers, ...(model.provider ? [model.provider] : [])])].map((id) => (
              <option key={id}>{id}</option>
            ))}
          </select>
          {model.provider && (
            <select
              aria-label={t('sddView.options.model')}
              value={model.model}
              onChange={(e) => setModel({ ...model, model: e.target.value })}
            >
              <option value="">{t('sddView.options.chooseModel')}</option>
              {[...new Set([...models, ...(model.model ? [model.model] : [])])].map((id) => (
                <option key={id}>{id}</option>
              ))}
            </select>
          )}
        </label>
      )}
      <label>
        <input type="checkbox" checked={isolate} onChange={(e) => setIsolate(e.target.checked)} />{' '}
        {t('sddView.options.isolate')}
      </label>
      <label>
        <input
          type="checkbox"
          checked={decompose}
          onChange={(e) => setDecompose(e.target.checked)}
        />{' '}
        {t('sddView.options.decompose')}
      </label>
    </div>
  );
}

/** The run payload's model fields: both or neither (a provider alone does not pick a model). */
export function runModelPayload(model: SddRunModel): Record<string, string> {
  return model.provider && model.model ? { provider: model.provider, model: model.model } : {};
}
