import {
  MODEL_DETAIL_WORDS,
  type ModelDetailWords,
  modelDetailLine,
  type PickerModel,
} from './model-picker-details';

/** One choice of a catalog picker; `value` is what a pick commits. */
export interface ComboboxOption {
  value: string;
  label: string;
  /** The text shown while the field is idle; the label when omitted. */
  display?: string;
  /** A second line under the label. */
  hint?: string;
  /** Choices that share a group are listed under one heading. */
  group?: string;
  /** Extra words a search matches besides value, label, group and hint. */
  keywords?: string;
}

/** One model of a saved provider's catalog. */
export interface SavedModel {
  provider: string;
  model: PickerModel;
}

/** The stored reference of a provider and model: `provider/model`, or the model alone to inherit. */
export function modelReference(provider: string, model: string): string {
  return provider ? `${provider}/${model}` : model;
}

/** Splits a reference at its first slash; a model ID may itself contain slashes. */
export function parseModelReference(value: string): { provider: string; model: string } {
  const trimmed = value.trim(),
    slash = trimmed.indexOf('/');
  return slash > 0
    ? { provider: trimmed.slice(0, slash), model: trimmed.slice(slash + 1) }
    : { provider: '', model: trimmed };
}

/** The stored model reference of a route, tier or review entry. */
export function modelRef(entry: Record<string, unknown>): string {
  return modelReference(String(entry['provider'] ?? ''), String(entry['model'] ?? ''));
}

/** The same entry with its model reference replaced; every other setting stays. */
export function modelRefPatch(
  entry: Record<string, unknown>,
  value: string,
): Record<string, unknown> {
  const { provider: _provider, model: _model, ...rest } = entry;
  const trimmed = value.trim(),
    slash = trimmed.indexOf('/');
  // As before the picker: a qualified reference sets both parts, a bare ID only the model.
  if (!trimmed) return rest;
  return slash > 0
    ? { ...rest, provider: trimmed.slice(0, slash), model: trimmed.slice(slash + 1) }
    : { ...rest, model: trimmed };
}

/** A provider's display name; own properties only, since an id may be `toString`. */
export function providerDisplayName(names: Record<string, string>, id: string): string {
  return Object.hasOwn(names, id) && names[id] ? names[id]! : id;
}

/**
 * Every saved model as a choice, grouped by its provider's display name and carrying the
 * catalog facts the session model picker shows. With one provider fixed the values are bare
 * model IDs: the provider is held beside the field.
 */
export function modelReferenceOptions(
  catalog: readonly SavedModel[],
  names: Record<string, string>,
  words: ModelDetailWords = MODEL_DETAIL_WORDS,
  scope?: { provider?: string },
): ComboboxOption[] {
  const provider = scope?.provider;
  return catalog
    .filter((entry) => !provider || entry.provider === provider)
    .map((entry) => {
      const group = providerDisplayName(names, entry.provider);
      return {
        value: provider ? entry.model.id : `${entry.provider}/${entry.model.id}`,
        label: entry.model.name,
        display: `${group} · ${entry.model.name}`,
        group,
        hint: [
          entry.model.name !== entry.model.id ? entry.model.id : '',
          modelDetailLine(entry.model, words),
        ]
          .filter(Boolean)
          .join(' · '),
        keywords: entry.provider,
      };
    });
}

/** Saved providers by display name, with the id as the second line when it differs. */
export function providerOptions(
  providers: readonly string[],
  names: Record<string, string>,
): ComboboxOption[] {
  return providers.map((id) => {
    const label = providerDisplayName(names, id);
    return { value: id, label, hint: label === id ? '' : id };
  });
}

/** The choices matching every whitespace-separated word of a query, anywhere in their text. */
export function filterOptions(options: readonly ComboboxOption[], query: string): ComboboxOption[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...options];
  return options.filter((option) => {
    const text =
      `${option.value} ${option.label} ${option.group ?? ''} ${option.hint ?? ''} ${option.keywords ?? ''}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}
