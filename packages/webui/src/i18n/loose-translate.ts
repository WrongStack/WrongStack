import type { TFunction } from 'i18next';

/**
 * A translator for computed keys with an optional options record, the shape
 * the WebUI's presentational helpers take.
 *
 * i18next 27's `TFunction` overloads accept a key alone or a key with
 * options, never an optional options parameter, so `t` no longer fits this
 * signature directly. {@link looseTranslate} adapts it without a cast.
 */
export type LooseTranslate = (key: string, options?: Record<string, unknown>) => string;

export function looseTranslate(t: TFunction): LooseTranslate {
  return (key, options) => (options === undefined ? t(key) : t(key, options));
}
