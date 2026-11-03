/**
 * UI locale constants + detection helpers.
 *
 * Pure module: must NOT import react/i18next/the prefs store, so that
 * `local-prefs.ts` DEFAULTS can call `detectLocale()` without a cycle.
 *
 * This is a DISPLAY-ONLY preference — the chosen locale only affects which
 * translation catalog the WebUI chrome renders. It never reaches the agent,
 * system prompt, skills, prompts, or model output.
 */

export type AppLocaleCode = (typeof SUPPORTED_LNGS)[number];

/** BCP-47 codes the WebUI ships translations for. `en` is the source + fallback. */
export const SUPPORTED_LNGS = ['en', 'tr', 'de', 'fr', 'it', 'es', 'pt-BR'] as const;

/** Source language + fallback target for any missing key. */
export const FALLBACK_LNG = 'en';

export interface AppLocale {
  /** BCP-47 code, e.g. `pt-BR`. */
  code: string;
  /** Endonym — the language's own name (shown untranslated in the picker so a
   *  user can always find their language even while the UI is in English). */
  name: string;
}

/**
 * Picker entries. Names are ENDONYMS (native spellings) on purpose: a Turkish
 * user must see "Türkçe" regardless of the active UI language.
 */
export const LANGUAGES: AppLocale[] = [
  { code: 'en', name: 'English' },
  { code: 'tr', name: 'Türkçe' },
  { code: 'de', name: 'Deutsch' },
  { code: 'fr', name: 'Français' },
  { code: 'it', name: 'Italiano' },
  { code: 'es', name: 'Español' },
  { code: 'pt-BR', name: 'Português (Brasil)' },
];

const SUPPORTED_SET: ReadonlySet<string> = new Set(SUPPORTED_LNGS);

/**
 * Map the browser's preferred language to the closest shipped locale.
 * Strategy (lower-cased): exact match → primary subtag match (`de-AT`→`de`,
 * `pt-PT`→`pt-BR`) → `en`.
 */
export function detectLocale(): string {
  if (typeof navigator === 'undefined' || !navigator.language) return FALLBACK_LNG;
  return matchLocale(navigator.language);
}

/**
 * Validate an arbitrary locale string against the shipped set. Returns the
 * best-supported locale (falling back to `detectLocale()` then `en`) — never
 * throws, never returns an unsupported code.
 */
export function normalizeLocale(raw?: string | null): string {
  if (!raw || typeof raw !== 'string') return detectLocale();
  const matched = matchLocale(raw);
  return matched;
}

function matchLocale(tag: string): string {
  const lower = tag.trim().toLowerCase();
  if (!lower) return FALLBACK_LNG;
  if (SUPPORTED_SET.has(lower)) return lower;
  const primary = lower.split('-')[0];
  if (primary && SUPPORTED_SET.has(primary)) return primary;
  // `pt-PT`, `pt-*-...` → Brazilian Portuguese catalog (closest shipped).
  if (primary === 'pt') return 'pt-BR';
  return FALLBACK_LNG;
}
