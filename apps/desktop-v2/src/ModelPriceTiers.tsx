import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { useDesktopText } from './desktop-i18n';
import { record } from './engine-values';
import {
  type ModelPriceTiersDraft,
  modelPriceTiersDraft,
  priceTierDraft,
  tierPriceFields,
} from './model-price-tiers';

export function ModelPriceTiers({
  value,
  onChange,
  legacySchedule,
}: {
  value: ModelPriceTiersDraft;
  onChange: (value: ModelPriceTiersDraft) => void;
  legacySchedule?: unknown;
}) {
  const { t } = useDesktopText();
  const change = (rows: ModelPriceTiersDraft['rows']) =>
    onChange({ ...value, changed: true, rows });
  return (
    <section className="model-price-tiers" aria-label={t('modelTiers.label')}>
      <header>
        <h3>{t('modelTiers.title')}</h3>
        <p>{t('modelTiers.intro')}</p>
      </header>
      <LegacyContextPrices value={legacySchedule} />
      {value.unsupported ? (
        <p>{t('modelTiers.unsupported')}</p>
      ) : (
        <>
          {!value.rows.length && <p>{t('modelTiers.none')}</p>}
          {value.rows.map((row, index) => (
            <article className="model-price-tier" key={index}>
              <header>
                <strong>{t('modelTiers.tier', { n: index + 1 })}</strong>
                <div className="model-tier-actions">
                  {([-1, 1] as const).map((delta) => (
                    <button
                      type="button"
                      className="icon-button"
                      key={delta}
                      aria-label={t(delta < 0 ? 'modelTiers.moveUp' : 'modelTiers.moveDown', {
                        n: index + 1,
                      })}
                      disabled={delta < 0 ? index === 0 : index === value.rows.length - 1}
                      onClick={() => {
                        const rows = [...value.rows];
                        [rows[index], rows[index + delta]] = [rows[index + delta]!, rows[index]!];
                        change(rows);
                      }}
                    >
                      {delta < 0 ? <ArrowUp size={14} /> : <ArrowDown size={14} />}
                    </button>
                  ))}
                  <button
                    type="button"
                    className="icon-button danger"
                    aria-label={t('modelTiers.remove', { n: index + 1 })}
                    onClick={() => change(value.rows.filter((_, i) => i !== index))}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </header>
              {row.editable ? (
                <div className="model-editor-grid">
                  <label>
                    {t('modelTiers.threshold')}
                    <input
                      type="number"
                      min={1}
                      step={1}
                      aria-label={t('modelTiers.thresholdLabel', { n: index + 1 })}
                      value={row.size}
                      onChange={(event) =>
                        change(
                          value.rows.map((old, i) =>
                            i === index ? { ...old, size: event.target.value } : old,
                          ),
                        )
                      }
                    />
                  </label>
                  {tierPriceFields.map(([key, label]) => (
                    <label key={key}>
                      {t('modelTiers.perMillion', {
                        label: t(`modelTiers.price.${key}`, { defaultValue: label }),
                      })}
                      <input
                        type="number"
                        min={0}
                        step="any"
                        placeholder={t('modelTiers.unspecified')}
                        aria-label={t('modelTiers.priceLabel', {
                          n: index + 1,
                          price: t(`modelTiers.priceLower.${key}`, {
                            defaultValue: label.toLowerCase(),
                          }),
                        })}
                        value={row.prices[key] ?? ''}
                        onChange={(event) =>
                          change(
                            value.rows.map((old, i) =>
                              i === index
                                ? { ...old, prices: { ...old.prices, [key]: event.target.value } }
                                : old,
                            ),
                          )
                        }
                      />
                    </label>
                  ))}
                </div>
              ) : (
                <p>{t('modelTiers.providerSpecific')}</p>
              )}
            </article>
          ))}
          <button
            type="button"
            className="button secondary small"
            onClick={() => change([...value.rows, priceTierDraft()])}
          >
            <Plus size={14} /> {t('modelTiers.add')}
          </button>
        </>
      )}
      {(value.unsupported || value.rows.length > 0) && (
        <button
          type="button"
          className="button secondary small"
          onClick={() => onChange({ changed: true, unsupported: false, rows: [] })}
        >
          {t('modelTiers.removeAll')}
        </button>
      )}
    </section>
  );
}

export function SavedModelPriceTiers({ cost }: { cost: Record<string, unknown> }) {
  const { t } = useDesktopText();
  const value = modelPriceTiersDraft(cost);
  const legacy = record(cost['context_over_200k']);
  if (cost['tiers'] === undefined && !Object.keys(legacy).length) return null;
  return (
    <section className="model-price-tiers" aria-label={t('modelTiers.savedLabel')}>
      <h4>{t('modelTiers.savedTitle')}</h4>
      <p>{t('modelTiers.savedIntro')}</p>
      <LegacyContextPrices value={cost['context_over_200k']} />
      {value.unsupported ? (
        <p>{t('modelTiers.savedUnsupported')}</p>
      ) : value.rows.length ? (
        <ol>
          {value.rows.map((row, index) => (
            <li key={index}>
              <strong>
                {row.editable
                  ? t('modelTiers.savedThreshold', { tokens: Number(row.size).toLocaleString() })
                  : t('modelTiers.savedProviderTier')}
              </strong>
              <dl className="model-info">
                {tierPriceFields.map(
                  ([key, label]) =>
                    typeof record(row.source)[key] === 'number' && (
                      <div key={key}>
                        <dt>{t(`modelTiers.price.${key}`, { defaultValue: label })}</dt>
                        <dd>
                          $
                          {Number(record(row.source)[key]).toLocaleString(undefined, {
                            maximumFractionDigits: 8,
                          })}
                        </dd>
                      </div>
                    ),
                )}
              </dl>
            </li>
          ))}
        </ol>
      ) : (
        <p>{t('modelTiers.savedNone')}</p>
      )}
    </section>
  );
}

function LegacyContextPrices({ value }: { value: unknown }) {
  const { t } = useDesktopText();
  const prices = record(value);
  if (!Object.keys(prices).length) return null;
  return (
    <div>
      <h4>{t('modelTiers.legacyTitle')}</h4>
      <p>{t('modelTiers.legacyNote')}</p>
      <dl className="model-info">
        {tierPriceFields.map(
          ([key, label]) =>
            typeof prices[key] === 'number' && (
              <div key={key}>
                <dt>
                  {t('modelTiers.perMillion', {
                    label: t(`modelTiers.price.${key}`, { defaultValue: label }),
                  })}
                </dt>
                <dd>
                  ${Number(prices[key]).toLocaleString(undefined, { maximumFractionDigits: 8 })}
                </dd>
              </div>
            ),
        )}
      </dl>
    </div>
  );
}
