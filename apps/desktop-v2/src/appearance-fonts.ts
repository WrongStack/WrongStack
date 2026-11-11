import { useSyncExternalStore } from 'react';

/**
 * Desktop typography settings for interface text, code, window zoom and code ligatures.
 * Unset fields use Geist, the Cascadia Code stack and 100% zoom.
 */
export interface FontAppearance {
  /** Unset is Geist, which the desktop ships. */
  uiFont?: 'system' | 'custom' | undefined;
  uiFontFamily?: string | undefined;
  /** Unset is Cascadia Code. */
  codeFont?: 'cascadia-mono' | 'consolas' | 'custom' | undefined;
  codeFontFamily?: string | undefined;
  /** Percent of the normal size, applied as the window's zoom; unset is 100. */
  textSize?: (typeof textSizes)[number] | undefined;
  ligatures?: 'off' | undefined;
}

export const uiFonts = ['system', 'custom'] as const;
export const codeFonts = ['cascadia-mono', 'consolas', 'custom'] as const;
/** Sizes besides the default 100; the top end keeps text readable on a 4K screen at 100% scaling. */
export const textSizes = [90, 110, 125, 150, 175, 200] as const;

export const DEFAULT_UI_STACK = '"Geist Variable", "Segoe UI", sans-serif';
export const DEFAULT_CODE_STACK = '"Cascadia Code", Consolas, monospace';
const UI_STACKS = { system: '"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif' };
const CODE_STACKS = {
  'cascadia-mono': '"Cascadia Mono", Consolas, monospace',
  consolas: 'Consolas, "Cascadia Mono", monospace',
};

/** An installed family's name as a person typed it; anything that is not a plain name is dropped. */
export function fontFamilyName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const name = value.replace(/\s+/g, ' ').trim();
  return /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,63}$/u.test(name) ? name : undefined;
}

/** The fields of a stored appearance that describe typography, validated. */
export function parseFontAppearance(candidate: Record<string, unknown>): FontAppearance {
  const uiFont = uiFonts.find((id) => id === candidate['uiFont']);
  const codeFont = codeFonts.find((id) => id === candidate['codeFont']);
  const uiFontFamily = fontFamilyName(candidate['uiFontFamily']);
  const codeFontFamily = fontFamilyName(candidate['codeFontFamily']);
  const textSize = textSizes.find((size) => size === candidate['textSize']);
  return {
    ...(uiFont ? { uiFont } : {}),
    ...(uiFontFamily ? { uiFontFamily } : {}),
    ...(codeFont ? { codeFont } : {}),
    ...(codeFontFamily ? { codeFontFamily } : {}),
    ...(textSize ? { textSize } : {}),
    ...(candidate['ligatures'] === 'off' ? { ligatures: 'off' as const } : {}),
  };
}

/** The interface font stack a person chose; null keeps the default. */
export function uiFontStack(fonts: FontAppearance): string | null {
  if (fonts.uiFont === 'custom')
    return fonts.uiFontFamily ? `"${fonts.uiFontFamily}", ${DEFAULT_UI_STACK}` : null;
  return fonts.uiFont ? UI_STACKS[fonts.uiFont] : null;
}

/** The code font stack a person chose; null keeps the default. */
export function codeFontStack(fonts: FontAppearance): string | null {
  if (fonts.codeFont === 'custom')
    return fonts.codeFontFamily ? `"${fonts.codeFontFamily}", ${DEFAULT_CODE_STACK}` : null;
  return fonts.codeFont ? CODE_STACKS[fonts.codeFont] : null;
}

/** The window zoom for a text size. */
export function textZoom(fonts: FontAppearance): number {
  return (fonts.textSize ?? 100) / 100;
}

/**
 * The text size one step larger (`1`) or smaller (`-1`) than `current`, clamped to the range;
 * `undefined` is the default 100%. `0` returns the default.
 */
export function stepTextSize(
  current: FontAppearance['textSize'],
  step: -1 | 0 | 1,
): FontAppearance['textSize'] {
  if (step === 0) return undefined;
  const ladder = [textSizes[0], 100, ...textSizes.slice(1)];
  const index = ladder.indexOf(current ?? 100);
  const next = ladder[Math.min(ladder.length - 1, Math.max(0, (index < 0 ? 1 : index) + step))];
  return next === 100 ? undefined : (next as FontAppearance['textSize']);
}
/** The text-size step a zoom key asks for, or null for any other key. */
export function textSizeStep(key: string): -1 | 0 | 1 | null {
  if (key === '+' || key === '=') return 1;
  if (key === '-' || key === '_') return -1;
  if (key === '0') return 0;
  return null;
}

/**
 * Code font for widgets that measure glyphs themselves (the file editor and terminals) and so
 * cannot read a CSS variable. `family` is null while the default applies.
 */
export interface CodeFont {
  family: string | null;
  ligatures: boolean;
}
let codeFont: CodeFont = { family: null, ligatures: true };
const listeners = new Set<() => void>();
export function setCodeFont(next: CodeFont) {
  if (next.family === codeFont.family && next.ligatures === codeFont.ligatures) return;
  codeFont = next;
  for (const listener of listeners) listener();
}
export function currentCodeFont(): CodeFont {
  return codeFont;
}
export function subscribeCodeFont(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function useCodeFont(): CodeFont {
  return useSyncExternalStore(subscribeCodeFont, currentCodeFont);
}

/** Applies the chosen typography and gives code surfaces a common default stack. */
export function applyFontAppearance(root: HTMLElement, fonts: FontAppearance) {
  const ui = uiFontStack(fonts);
  const code = codeFontStack(fonts);
  if (ui) root.style.setProperty('--user-font-ui', ui);
  else root.style.removeProperty('--user-font-ui');
  root.style.setProperty('--user-font-code', code ?? DEFAULT_CODE_STACK);
  if (ui) root.dataset['uiFont'] = fonts.uiFont;
  else delete root.dataset['uiFont'];
  if (code) root.dataset['codeFont'] = fonts.codeFont;
  else delete root.dataset['codeFont'];
  if (fonts.ligatures === 'off') root.dataset['ligatures'] = 'off';
  else delete root.dataset['ligatures'];
  if (fonts.textSize) root.dataset['textSize'] = String(fonts.textSize);
  else delete root.dataset['textSize'];
  setCodeFont({ family: code, ligatures: fonts.ligatures !== 'off' });
}
