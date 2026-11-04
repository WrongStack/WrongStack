import { useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import { modelFlags, modelNumberFields, modelTextFields } from './model-catalog-editor';
import type { ModelEditorDraftStore, ModelEditorState } from './model-editor-draft';
import { tierPriceFields } from './model-price-tiers';
import './draft-conflict.css';

export function ModelDraftNotice({
  state,
  controller,
  editing,
  busy,
  onResume,
  onDiscard,
  onResolved,
}: {
  state: ReturnType<ModelEditorDraftStore['snapshot']>;
  controller: ModelEditorDraftStore;
  editing: boolean;
  busy: boolean;
  onResume: () => void;
  onDiscard: () => void;
  onResolved: () => void;
}) {
  const { t } = useDesktopText();
  const [working, setWorking] = useState(false);
  const resolve = async (choice: 'local' | 'saved') => {
    if (working) return;
    setWorking(true);
    try {
      if (await controller.resolve(choice)) onResolved();
    } finally {
      setWorking(false);
    }
  };
  if (!editing && state.ready && !state.value && !state.review && !state.error) return null;
  return (
    <section className="model-draft-notice" aria-label={t('modelDraft.label')}>
      <p role="status">
        {!state.ready
          ? t('modelDraft.loading')
          : state.saving
            ? t('modelDraft.saving')
            : state.dirty
              ? t('modelDraft.dirty')
              : editing
                ? t('modelDraft.savedEditing')
                : t('modelDraft.savedIdle', {
                    name:
                      state.value?.draft.text['name'] ||
                      state.value?.draft.id ||
                      t('modelDraft.newModel'),
                  })}
      </p>
      {!state.ready && (
        <button
          type="button"
          className="button secondary small"
          onClick={() => {
            void controller.load();
          }}
        >
          {t('modelDraft.retry')}
        </button>
      )}
      {!editing && state.value && !state.review && (
        <div className="model-tier-actions">
          <button
            type="button"
            className="button secondary small"
            disabled={busy || working}
            onClick={onResume}
          >
            {t('modelDraft.continue')}
          </button>
          <button
            type="button"
            className="button secondary small"
            disabled={busy || working || state.saving}
            onClick={onDiscard}
          >
            {t('modelDraft.discard')}
          </button>
        </div>
      )}
      {state.error && (
        <p role="alert" className="session-error">
          {state.error}
        </p>
      )}
      {state.ready && state.error && !state.review && (
        <button
          type="button"
          className="button secondary small"
          disabled={busy || working || state.saving}
          onClick={() => {
            void controller.compare();
          }}
        >
          {t('modelDraft.compare')}
        </button>
      )}
      {state.review && (
        <>
          <p>{t('modelDraft.differ')}</p>
          <div className="model-draft-comparison">
            <div>
              <h4>{t('modelDraft.thisWindow')}</h4>
              <ModelDraftSummary value={state.value} />
            </div>
            <div>
              <h4>{t('modelDraft.savedDraft')}</h4>
              <ModelDraftSummary value={state.review.value} />
            </div>
          </div>
          <div className="model-tier-actions">
            <button
              type="button"
              className="button secondary small"
              disabled={busy || working || state.saving}
              onClick={() => {
                void resolve('saved');
              }}
            >
              {t('modelDraft.useSaved')}
            </button>
            <button
              type="button"
              className="button secondary small"
              disabled={busy || working || state.saving}
              onClick={() => {
                void resolve('local');
              }}
            >
              {t('modelDraft.keep')}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
export function ModelDraftSummary({ value }: { value: ModelEditorState | null }) {
  const { t } = useDesktopText();
  if (!value) return <p>{t('modelDraft.noDraft')}</p>;
  const draft = value.draft;
  return (
    <details>
      <summary>
        {t('modelDraft.summary', {
          name: draft.text['name'] || draft.id || t('modelDraft.newModel'),
        })}
      </summary>
      <dl className="model-info">
        <div>
          <dt>{t('modelCatalog.modelId')}</dt>
          <dd>{draft.id || t('modelDraft.notEntered')}</dd>
        </div>
        {modelTextFields.map(
          ([key, label]) =>
            draft.text[key] && (
              <div key={key}>
                <dt>{t(`modelCatalog.field.${key}`, { defaultValue: label })}</dt>
                <dd>{draft.text[key]}</dd>
              </div>
            ),
        )}
        {modelNumberFields.map(
          ([group, key, label]) =>
            draft.numbers[`${group}.${key}`] && (
              <div key={`${group}.${key}`}>
                <dt>{t(`modelCatalog.number.${group}.${key}`, { defaultValue: label })}</dt>
                <dd>{draft.numbers[`${group}.${key}`]}</dd>
              </div>
            ),
        )}
        <div>
          <dt>{t('modelCatalog.inputModalities')}</dt>
          <dd>{draft.input || t('modelTiers.unspecified')}</dd>
        </div>
        {modelFlags.map(([key, label]) => (
          <div key={key}>
            <dt>{t(`modelCatalog.flag.${key}`, { defaultValue: label })}</dt>
            <dd>
              {draft.flags[key] === 'inherit'
                ? t('modelCatalog.inheritCatalog')
                : draft.flags[key] === 'true'
                  ? t('modelCatalog.supported')
                  : t('modelCatalog.notSupported')}
            </dd>
          </div>
        ))}
        {(
          [
            ['status', draft.advanced.status || t('modelCatalog.inheritCatalog')],
            ['experimental', draft.advanced.experimental],
            ['sdk', draft.advanced.npm || t('modelCatalog.inheritProvider')],
            ['api', draft.advanced.api || t('modelCatalog.inheritProvider')],
            ['replay', `${draft.advanced.interleaved} ${draft.advanced.field}`],
            [
              'canDisable',
              draft.advanced.runtime.disableSupported
                ? t('modelAdvanced.yes')
                : t('modelAdvanced.no'),
            ],
            ['effortSupport', draft.advanced.runtime.effortSupported],
            ['retention', draft.advanced.runtime.preserveThinking],
          ] as const
        ).map(([label, text]) => (
          <div key={label}>
            <dt>{t(`modelAdvanced.${label}`)}</dt>
            <dd>{text}</dd>
          </div>
        ))}
        <div>
          <dt>{t('modelCatalog.outputModalities')}</dt>
          <dd>{draft.output || t('modelTiers.unspecified')}</dd>
        </div>
        <div>
          <dt>{t('modelCatalog.reasoningPolicy')}</dt>
          <dd>
            {draft.advanced.runtimePolicy} · {draft.advanced.runtime.default} ·{' '}
            {draft.advanced.runtime.effortLevels.join(', ') || t('modelDraft.noEfforts')}
          </dd>
        </div>
        {draft.advanced.options.map((option, index) => (
          <div key={index}>
            <dt>{t('modelAdvanced.controlLabel', { n: index + 1 })}</dt>
            <dd>
              {option.type} · {option.values.join(', ')} {option.min} {option.max}
            </dd>
          </div>
        ))}
        {draft.pricing.rows.map((row, index) => (
          <div key={index}>
            <dt>{t('modelTiers.tier', { n: index + 1 })}</dt>
            <dd>
              {row.editable
                ? t('modelDraft.threshold', { size: row.size || t('modelDraft.notEnteredLower') })
                : t('modelDraft.providerMetadata')}
              {tierPriceFields
                .map(([key, label]) =>
                  row.prices[key] !== '' && row.prices[key] !== undefined
                    ? ` · ${t(`modelTiers.price.${key}`, { defaultValue: label })}: ${row.prices[key]}`
                    : '',
                )
                .join('')}
            </dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
