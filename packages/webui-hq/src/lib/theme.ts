/**
 * Theme application — the bridge between stored preferences and the DOM
 * contract the token stylesheet expects.
 *
 * Two orthogonal knobs, exactly as in `packages/webui`:
 *   - light/dark is a CLASS on `<html>` (`.dark`), because that is what the
 *     `@custom-variant dark` in `index.css` and every `dark:` utility key on
 *   - the accent palette is an ATTRIBUTE (`data-palette`), because it layers
 *     on top of either theme; the default `signal` palette has no block and is
 *     applied by removing the attribute
 */
import type { HqPaletteId, HqThemeChoice } from '../data/local-prefs.js';

export type ResolvedTheme = 'light' | 'dark';

/** Resolve `system` against the OS preference. */
export function resolveTheme(choice: HqThemeChoice): ResolvedTheme {
  if (choice !== 'system') return choice;
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'dark';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme(root: HTMLElement, choice: HqThemeChoice): ResolvedTheme {
  const resolved = resolveTheme(choice);
  root.classList.toggle('dark', resolved === 'dark');
  root.style.colorScheme = resolved;
  return resolved;
}

export function applyPalette(root: HTMLElement, palette: HqPaletteId): void {
  if (palette === 'signal') {
    root.removeAttribute('data-palette');
    return;
  }
  root.setAttribute('data-palette', palette);
}

/**
 * Watch the OS preference and re-apply while the choice is `system`.
 * Returns a teardown; a no-op outside a browser.
 */
export function watchSystemTheme(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => undefined;
  }
  const query = window.matchMedia('(prefers-color-scheme: dark)');
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}
