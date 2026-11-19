import { previousGraphemeIndex } from './input-graphemes.js';

/** Single-line picker fields accept pasted Unicode but never terminal controls. */
export function pickerInputText(input: string): string {
  return Array.from(input)
    .filter((ch) => !/[\u0000-\u001f\u007f-\u009f]/u.test(ch))
    .join('');
}

/**
 * A bracketed paste into a single-line picker field: controls (newlines,
 * tabs, escapes) dropped and the surrounding whitespace trimmed, so a copied
 * API key or URL with a trailing newline/space lands clean.
 */
export function pickerPasteText(input: string): string {
  return pickerInputText(input).trim();
}

export function pickerBackspace(value: string): string {
  return value.slice(0, previousGraphemeIndex(value, value.length));
}
