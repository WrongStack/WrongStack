/** Inline-style font size that follows the interface text scale — for the
 *  few components that size text from JS (graphs, inline-styled panels). */
export function scaledPx(px: number): string {
  return `calc(${px}px * var(--ui-font-scale, 1))`;
}
