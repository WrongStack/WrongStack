/**
 * Design DNA color math: sRGB hex ↔ OKLab, OKLab distance and WCAG contrast.
 * Measurements arrive as `#rrggbb` (an optional `/alpha` suffix is ignored).
 */

export interface OkLab {
  L: number;
  a: number;
  b: number;
}

function parseHex(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{6})(?:\/[^\s]+)?$/i.exec(hex.trim());
  if (!m?.[1]) return null;
  const n = Number.parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function linear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** sRGB hex (`#rrggbb`, optional `/alpha` suffix ignored) → OKLab. */
export function hexToOklab(hex: string): OkLab | null {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  const [r, g, b] = rgb.map(linear) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

export function hexChroma(hex: string): number {
  const c = hexToOklab(hex);
  return c ? Math.hypot(c.a, c.b) : 0;
}

/** `oklch(L% C H)` string for a hex, rounded for token use. */
export function hexToOklchString(hex: string): string | null {
  const c = hexToOklab(hex);
  if (!c) return null;
  const C = Math.hypot(c.a, c.b);
  const H = C < 0.002 ? 0 : ((Math.atan2(c.b, c.a) * 180) / Math.PI + 360) % 360;
  return `oklch(${(c.L * 100).toFixed(1)}% ${C.toFixed(3)} ${H.toFixed(1)})`;
}

/** Euclidean OKLab distance; ~0.02 is a just-noticeable difference. */
export function deltaE(a: string, b: string): number {
  const x = hexToOklab(a);
  const y = hexToOklab(b);
  if (!x || !y) return Number.POSITIVE_INFINITY;
  return Math.hypot(x.L - y.L, x.a - y.a, x.b - y.b);
}

function luminance(hex: string): number {
  const rgb = parseHex(hex);
  if (!rgb) return 0;
  const [r, g, b] = rgb.map(linear) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function hexContrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
