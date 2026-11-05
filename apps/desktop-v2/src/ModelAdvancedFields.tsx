import { useDesktopText } from './desktop-i18n';
import {
  type ModelAdvancedDraft,
  modelEfforts,
  type ReasoningOptionDraft,
} from './model-advanced-editor';

export function ModelAdvancedFields({
  value,
  onChange,
}: {
  value: ModelAdvancedDraft;
  onChange: (next: ModelAdvancedDraft) => void;
}) {
  const { t } = useDesktopText();
  const change = (patch: Partial<ModelAdvancedDraft>) => onChange({ ...value, ...patch });
  const editOption = (index: number, patch: Partial<ReasoningOptionDraft>) =>
    change({
      options: value.options.map((item, position) =>
        position === index ? { ...item, ...patch } : item,
      ),
    });
  return (
    <details className="model-advanced-fields">
      <summary>{t('modelAdvanced.title')}</summary>
      <p>{t('modelAdvanced.intro')}</p>
      <h3>{t('modelAdvanced.reasoningControls')}</h3>
      {value.runtimePolicy === 'preserve' && <p role="note">{t('modelAdvanced.explicitNote')}</p>}
      <label>
        {t('modelAdvanced.policySource')}
        <select
          aria-label={t('modelAdvanced.policySourceLabel')}
          value={value.runtimePolicy}
          onChange={(event) =>
            change({ runtimePolicy: event.target.value as ModelAdvancedDraft['runtimePolicy'] })
          }
        >
          <option value="preserve">{t('modelAdvanced.preserve')}</option>
          <option value="catalog">{t('modelAdvanced.catalog')}</option>
          <option value="custom">{t('modelAdvanced.custom')}</option>
        </select>
      </label>
      {value.runtimePolicy === 'custom' && (
        <div className="model-reasoning-option">
          <p>{t('modelAdvanced.customNote')}</p>
          <div className="model-editor-grid">
            <label>
              {t('modelAdvanced.default')}
              <select
                aria-label={t('modelAdvanced.defaultLabel')}
                value={value.runtime.default}
                onChange={(event) =>
                  change({ runtime: { ...value.runtime, default: event.target.value } })
                }
              >
                {['enabled', 'disabled', 'adaptive', 'always_on'].map((mode) => (
                  <option key={mode} value={mode}>
                    {t(`modelAdvanced.mode.${mode}`)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t('modelAdvanced.canDisable')}
              <select
                aria-label={t('modelAdvanced.canDisableLabel')}
                value={String(value.runtime.disableSupported)}
                onChange={(event) =>
                  change({
                    runtime: { ...value.runtime, disableSupported: event.target.value === 'true' },
                  })
                }
              >
                <option value="true">{t('modelAdvanced.yes')}</option>
                <option value="false">{t('modelAdvanced.no')}</option>
              </select>
            </label>
            <label>
              {t('modelAdvanced.effortSupport')}
              <select
                aria-label={t('modelAdvanced.effortSupportLabel')}
                value={value.runtime.effortSupported}
                onChange={(event) =>
                  change({
                    runtime: {
                      ...value.runtime,
                      effortSupported: event.target.value,
                      effortLevels: event.target.value === 'true' ? value.runtime.effortLevels : [],
                    },
                  })
                }
              >
                <option value="inherit">{t('modelAdvanced.undocumented')}</option>
                <option value="true">{t('modelAdvanced.documented')}</option>
                <option value="false">{t('modelAdvanced.noEffort')}</option>
              </select>
            </label>
            <label>
              {t('modelAdvanced.retention')}
              <select
                aria-label={t('modelAdvanced.retentionLabel')}
                value={value.runtime.preserveThinking}
                onChange={(event) =>
                  change({ runtime: { ...value.runtime, preserveThinking: event.target.value } })
                }
              >
                {['unsupported', 'optional', 'always_on'].map((mode) => (
                  <option key={mode} value={mode}>
                    {t(`modelAdvanced.mode.${mode}`)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {value.runtime.effortSupported === 'true' && (
            <fieldset className="model-effort-choices">
              <legend>{t('modelAdvanced.runtimeLevels')}</legend>
              {modelEfforts.map((effort) => (
                <label key={effort}>
                  <input
                    type="checkbox"
                    aria-label={t('modelAdvanced.runtimeLevelLabel', { effort })}
                    checked={value.runtime.effortLevels.includes(effort)}
                    onChange={(event) =>
                      change({
                        runtime: {
                          ...value.runtime,
                          effortLevels: event.target.checked
                            ? modelEfforts.filter(
                                (level) =>
                                  value.runtime.effortLevels.includes(level) || level === effort,
                              )
                            : value.runtime.effortLevels.filter((level) => level !== effort),
                        },
                      })
                    }
                  />
                  {effort}
                </label>
              ))}
            </fieldset>
          )}
        </div>
      )}
      <p>{t('modelAdvanced.controlsNote')}</p>
      {value.options.map((option, index) => (
        <div className="model-reasoning-option" key={`${index}-${option.type}`}>
          <div className="model-editor-grid">
            <label>
              {t('modelAdvanced.controlType')}
              <select
                aria-label={t('modelAdvanced.controlLabel', { n: index + 1 })}
                value={option.type}
                onChange={(event) => editOption(index, { type: event.target.value })}
              >
                <option value="toggle">{t('modelAdvanced.toggle')}</option>
                <option value="effort">{t('modelAdvanced.effort')}</option>
                <option value="budget_tokens">{t('modelAdvanced.budget')}</option>
              </select>
            </label>
            <button
              type="button"
              className="button secondary"
              onClick={() =>
                change({ options: value.options.filter((_, position) => position !== index) })
              }
            >
              {t('modelAdvanced.removeControl', { n: index + 1 })}
            </button>
          </div>
          {option.type === 'effort' && (
            <fieldset className="model-effort-choices">
              <legend>{t('modelAdvanced.supportedLevels')}</legend>
              {modelEfforts.map((effort) => (
                <label key={effort}>
                  <input
                    type="checkbox"
                    aria-label={t('modelAdvanced.controlEffortLabel', { n: index + 1, effort })}
                    checked={option.values.includes(effort)}
                    onChange={(event) =>
                      editOption(index, {
                        values: event.target.checked
                          ? modelEfforts.filter(
                              (level) => option.values.includes(level) || level === effort,
                            )
                          : option.values.filter((level) => level !== effort),
                      })
                    }
                  />
                  {effort}
                </label>
              ))}
            </fieldset>
          )}
          {option.type === 'budget_tokens' && (
            <div className="model-editor-grid">
              {(['min', 'max'] as const).map((key) => (
                <label key={key}>
                  {key === 'min' ? t('modelAdvanced.minTokens') : t('modelAdvanced.maxTokens')}
                  <input
                    type="number"
                    min={0}
                    step={1}
                    aria-label={t('modelAdvanced.tokensLabel', { n: index + 1, bound: key })}
                    value={option[key]}
                    onChange={(event) => editOption(index, { [key]: event.target.value })}
                  />
                </label>
              ))}
            </div>
          )}
        </div>
      ))}
      <button
        type="button"
        className="button secondary"
        disabled={value.options.length >= 3}
        onClick={() => {
          const type = ['effort', 'budget_tokens', 'toggle'].find(
            (type) => !value.options.some((option) => option.type === type),
          );
          if (type)
            change({
              options: [...value.options, { type, values: [], min: '', max: '', source: {} }],
            });
        }}
      >
        {t('modelAdvanced.addControl')}
      </button>
      <h3>{t('modelAdvanced.replay')}</h3>
      <p>{t('modelAdvanced.replayNote')}</p>
      <div className="model-editor-grid">
        <label>
          {t('modelAdvanced.interleaved')}
          <select
            aria-label={t('modelAdvanced.interleavedLabel')}
            value={value.interleaved}
            onChange={(event) => change({ interleaved: event.target.value })}
          >
            <option value="inherit">{t('modelAdvanced.inheritCatalog')}</option>
            <option value="true">{t('modelAdvanced.supported')}</option>
            <option value="false">{t('modelAdvanced.notSupported')}</option>
            <option value="field">{t('modelAdvanced.replayField')}</option>
          </select>
        </label>
        {value.interleaved === 'field' && (
          <label>
            {t('modelAdvanced.field')}
            <input
              aria-label={t('modelAdvanced.fieldLabel')}
              value={value.field}
              placeholder="reasoning_content"
              onChange={(event) => change({ field: event.target.value })}
            />
          </label>
        )}
      </div>
      <h3>{t('modelAdvanced.lifecycle')}</h3>
      <div className="model-editor-grid">
        <label>
          {t('modelAdvanced.status')}
          <select
            aria-label={t('modelAdvanced.statusLabel')}
            value={value.status}
            onChange={(event) => change({ status: event.target.value })}
          >
            <option value="">{t('modelAdvanced.statusOption.inherit')}</option>
            {[
              ...new Set(['alpha', 'beta', 'deprecated', ...(value.status ? [value.status] : [])]),
            ].map((status) => (
              <option key={status} value={status}>
                {t(`modelAdvanced.statusOption.${status}`, { defaultValue: status })}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('modelAdvanced.experimental')}
          <select
            aria-label={t('modelAdvanced.experimentalLabel')}
            value={value.experimental}
            onChange={(event) => change({ experimental: event.target.value })}
          >
            <option value="inherit">{t('modelAdvanced.inheritCatalog')}</option>
            <option value="true">{t('modelAdvanced.experimental')}</option>
            <option value="false">{t('modelAdvanced.notExperimental')}</option>
          </select>
        </label>
      </div>
      <h3>{t('modelAdvanced.connection')}</h3>
      <p>{t('modelAdvanced.connectionNote')}</p>
      <div className="model-editor-grid">
        <label>
          {t('modelAdvanced.sdk')}
          <input
            aria-label={t('modelAdvanced.sdkLabel')}
            value={value.npm}
            placeholder="@ai-sdk/openai-compatible"
            onChange={(event) => change({ npm: event.target.value })}
          />
        </label>
        <label>
          {t('modelAdvanced.api')}
          <input
            aria-label={t('modelAdvanced.apiLabel')}
            value={value.api}
            placeholder="https://provider.example/v1"
            onChange={(event) => change({ api: event.target.value })}
          />
        </label>
      </div>
    </details>
  );
}
