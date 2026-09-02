import type { ModelDescriptor } from '../types.js';
import { readPersisted, writePersisted } from './persisted.js';

/**
 * Catalog presentation helpers for the model picker.
 *
 * A real WrongStack install can expose 1000+ catalog entries across dozens of
 * providers, including embeddings, image/video generators, voice, rerankers
 * and safety classifiers that can never serve a chat turn. These helpers turn
 * the raw `provider.catalog` / `provider.models` data into the list a human
 * should see: chat-capable, de-duplicated, searchable, with recents.
 */

/** provider\tmodel values the user picked recently. */
const RECENT_MODELS_KEY = 'wrongstack.simpleui.models.recent';
const RECENT_MODELS_VERSION = 1;
const MAX_RECENT_MODELS = 5;

/**
 * Conservative id/name patterns for entries that cannot serve chat turns.
 * Matched case-insensitively against both the model id and display name.
 */
const NON_CHAT_PATTERNS: RegExp[] = [
  // Retrieval / embeddings / reranking
  /embed(?:ding|dings)?\b/i,
  /\bembed-/i,
  /\bbge\b/i,
  /\brerank/i,
  /retriev/i,
  // Audio / speech
  /whisper/i,
  /\btts\b|-tts\b|tts-|text-to-speech/i,
  /voicechat|voice-chat|studiovoice/i,
  /riva-translate/i,
  // Image / video generation (chat models with vision input stay listed)
  /gpt-image|dall-e|\bimagen\b|flux\.|^-?flux|happyhorse|wan2|\bwan-|qwen-?image|chatgpt-image|image-edit|[-\/](i2v|t2v|r2v)\b|\bi2v\b|\bt2v\b|\br2v\b/i,
  // Safety / classification / domain-specific non-chat stacks
  /guard\b|-guard|content-safety|safety-guard|gliner|pii\b/i,
  /speaker-detection|active-speaker|synthetic-video|deepfake|detector/i,
  /esmfold|esm2-|\besm\b|cosmos-|sparsedrive|bevformer|streampetr|dracarys/i,
  /usdvalidate|magpie-tts/i,
];

/** Whether a catalog entry looks incapable of serving a chat turn. */
export function isLikelyNonChatModel(entry: ModelDescriptor): boolean {
  const haystack = `${entry.id} ${entry.name ?? ''}`;
  return NON_CHAT_PATTERNS.some((pattern) => pattern.test(haystack));
}

/**
 * Build the visible model groups from the raw catalog:
 *  - drop providers with no models;
 *  - drop entries that cannot serve chat turns;
 *  - drop exact duplicate model ids within a provider (catalog merges can
 *    append the same provider list more than once).
 * Provider order and intra-provider order are preserved.
 */
export function visibleModelGroups(
  models: Record<string, ModelDescriptor[]>,
): [string, ModelDescriptor[]][] {
  const groups: [string, ModelDescriptor[]][] = [];
  for (const [provider, entries] of Object.entries(models)) {
    if (!entries || entries.length === 0) continue;
    const seen = new Set<string>();
    const visible: ModelDescriptor[] = [];
    for (const entry of entries) {
      if (!entry || typeof entry.id !== 'string' || seen.has(entry.id)) continue;
      if (isLikelyNonChatModel(entry)) continue;
      seen.add(entry.id);
      visible.push(entry);
    }
    if (visible.length > 0) groups.push([provider, visible]);
  }
  return groups;
}

export interface ModelPickerRow {
  provider: string;
  providerLabel: string;
  entry: ModelDescriptor;
}

/**
 * Flatten + filter the visible groups by a free-text query (matches the model
 * name, id, or provider label). An empty query returns every row. The flat
 * list is what the picker renders; grouping is visual only.
 */
export function searchModelRows(
  groups: [string, ModelDescriptor[]][],
  providerLabels: Record<string, string>,
  query: string,
): ModelPickerRow[] {
  const needle = query.trim().toLowerCase();
  const rows: ModelPickerRow[] = [];
  for (const [provider, entries] of groups) {
    const label = (providerLabels[provider] ?? provider).toLowerCase();
    for (const entry of entries) {
      if (!needle) {
        rows.push({ provider, providerLabel: providerLabels[provider] ?? provider, entry });
        continue;
      }
      const name = (entry.name ?? entry.id).toLowerCase();
      if (
        name.includes(needle) ||
        entry.id.toLowerCase().includes(needle) ||
        label.includes(needle)
      ) {
        rows.push({ provider, providerLabel: providerLabels[provider] ?? provider, entry });
      }
    }
  }
  return rows;
}

/** Recently picked models, oldest first. Returns [] when nothing is stored. */
export function readRecentModels(): string[] {
  const stored = readPersisted<string[]>(RECENT_MODELS_KEY, {
    version: RECENT_MODELS_VERSION,
    validate: (value) =>
      Array.isArray(value) && value.every((x) => typeof x === 'string') ? value : null,
  });
  return stored ?? [];
}

/** Record a pick: moves it to the front, caps the list, best-effort persist. */
export function pushRecentModel(provider: string, model: string): void {
  const value = `${provider}\t${model}`;
  const next = [value, ...readRecentModels().filter((x) => x !== value)].slice(
    0,
    MAX_RECENT_MODELS,
  );
  writePersisted(RECENT_MODELS_KEY, RECENT_MODELS_VERSION, next);
}
