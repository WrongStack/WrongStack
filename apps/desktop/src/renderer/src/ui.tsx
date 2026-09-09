/**
 * Small shared pieces for the shell: icons and the i18n hook.
 */
import { memo, useMemo, useSyncExternalStore } from 'react';
import { getLocale, onLocaleChange, t as translate } from './i18n.js';
import { iconMarkup, type IconName } from './icons.js';

/**
 * Re-render on locale change, and hand back a translate function whose
 * identity is stable per locale.
 *
 * The identity matters: `t` reads a module-level locale, so a component that
 * memoises on it would never re-render on a language switch if the function
 * were the same object forever. One new identity per locale makes exactly the
 * rows that render text update, and nothing else.
 */
export function useT(): (key: string) => string {
  const locale = useSyncExternalStore(onLocaleChange, getLocale, getLocale);
  return useMemo(() => {
    void locale;
    return (key: string) => translate(key);
  }, [locale]);
}

/**
 * One icon.
 *
 * The inner markup comes from `icons.ts`, which stores each glyph as a literal
 * SVG fragment — mostly `<path>`, but several use `<circle>` or `<rect>`, so
 * extracting path data alone would silently drop parts of those glyphs.
 *
 * On `dangerouslySetInnerHTML`: `ICON_PATHS` is a compile-time constant record
 * keyed by the `IconName` union. The only values that can reach this call are
 * the literals written in that file; nothing user-, disk- or network-supplied
 * can index into it, and a name outside the union does not typecheck.
 */
export const Icon = memo(function Icon({
  name,
  className,
}: {
  name: IconName;
  className?: string | undefined;
}) {
  return (
    <svg
      className={className ? `svg-icon ${className}` : 'svg-icon'}
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      dangerouslySetInnerHTML={{ __html: iconMarkup(name) }}
    />
  );
});
