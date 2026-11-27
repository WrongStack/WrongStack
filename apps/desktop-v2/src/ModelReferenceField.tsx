import { useId, useMemo } from 'react';
import { CatalogCombobox } from './CatalogCombobox';
import { useDesktopText } from './desktop-i18n';
import { MODEL_DETAIL_WORDS, type ModelDetailWords, modelDetailLine } from './model-picker-details';
import { modelReferenceOptions, providerOptions } from './model-reference-options';
import { useModelCatalog } from './saved-model-catalog';

type Translate = ReturnType<typeof useDesktopText>['t'];

/** How a choice's catalog facts are worded: the display language's catalog, else English. */
export const modelDetailWords = (t: Translate): ModelDetailWords => ({
  context: (value) => t('modelPicker.detail.context', { value }),
  output: (value) => t('modelPicker.detail.output', { value }),
  noPrice: () => t('modelPicker.detail.noPrice'),
  price: (input, output) => t('modelPicker.detail.price', { input, output }),
  capability: (id) =>
    t(`modelPicker.detail.${id}`, { defaultValue: MODEL_DETAIL_WORDS.capability(id) }),
});

// Only referenced so the catalog line's words come from one place; see modelReferenceOptions.
void modelDetailLine;

/**
 * One provider/model reference. Choices come from the page's saved catalogs
 * (`ModelCatalogProvider`), grouped by provider and named as the catalogs name them; a
 * reference outside the catalogs stays as typed. A model ID alone inherits the runtime provider.
 */
export function ModelReferenceField({
  label,
  name,
  value,
  onChange,
  provider,
  allowEmpty = true,
  disabled = false,
}: {
  label: string;
  /** Accessible name when the visible label leans on a heading. */
  name?: string;
  value: string;
  onChange: (value: string) => void;
  /** Limits the choices to one provider and commits bare model IDs; the provider is held beside. */
  provider?: string | undefined;
  /** A clear button empties the reference. */
  allowEmpty?: boolean;
  disabled?: boolean;
}) {
  const { t } = useDesktopText();
  const catalog = useModelCatalog();
  const id = useId();
  const words = useMemo(() => modelDetailWords(t), [t]);
  const options = useMemo(
    () => modelReferenceOptions(catalog.models, catalog.names, words, provider ? { provider } : {}),
    [catalog, words, provider],
  );
  return (
    <div className="model-reference-field">
      {label && <label htmlFor={id}>{label}</label>}
      <CatalogCombobox
        id={id}
        name={name ?? (label || t('modelPolicy.field.model'))}
        value={value}
        onChange={onChange}
        options={options}
        loading={catalog.loading}
        disabled={disabled}
        placeholder={t('catalogPicker.modelPlaceholder')}
        customText={t('catalogPicker.customModel')}
        {...(allowEmpty ? { clearLabel: t('catalogPicker.clear') } : {})}
      />
    </div>
  );
}

/**
 * One saved provider, named as the provider catalog names it. `anyLabel` adds a first
 * choice that means no provider in particular.
 */
export function ProviderField({
  label,
  name,
  value,
  onChange,
  providers: listed,
  names: givenNames,
  anyLabel,
  required = false,
  disabled = false,
}: {
  label: string;
  name?: string;
  value: string;
  onChange: (value: string) => void;
  /** The page's own saved-provider list; the page's catalogs when omitted. */
  providers?: readonly string[];
  names?: Record<string, string>;
  /** A blank value with this label is offered as a choice. */
  anyLabel?: string;
  required?: boolean;
  disabled?: boolean;
}) {
  const { t } = useDesktopText();
  const catalog = useModelCatalog();
  const id = useId();
  const providers = listed ?? catalog.providers,
    names = givenNames ?? catalog.names;
  const options = useMemo(() => providerOptions(providers, names), [providers, names]);
  const choices = useMemo(
    () => (anyLabel ? [{ value: '', label: anyLabel }, ...options] : options),
    [anyLabel, options],
  );
  return (
    <div className="model-reference-field">
      {label && <label htmlFor={id}>{label}</label>}
      <CatalogCombobox
        id={id}
        name={name ?? (label || t('catalogPicker.provider'))}
        value={value}
        onChange={onChange}
        options={choices}
        loading={!listed && catalog.loading}
        disabled={disabled}
        required={required}
        placeholder={anyLabel ?? t('catalogPicker.providerPlaceholder')}
        customText={t('catalogPicker.customProvider')}
      />
    </div>
  );
}
