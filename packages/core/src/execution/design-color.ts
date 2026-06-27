/**
 * Design Studio color utilities.
 *
 * Design kit tokens are authored in OKLCH (CSS-native, the modern 2026 default).
 * CSS targets keep them verbatim, but native stacks (React Native, Flutter,
 * SwiftUI, Compose) need concrete sRGB — so `materialize` converts each token
 * with `oklchToHex`. The verifier also normalizes colors to hex before
 * comparing, so an `oklch()` token and the same color written as `#rrggbb`
 * count as a match.
 *
 * Conversion is the standard Björn Ottosson OKLab→linear-sRGB pipeline; values
 * out of the sRGB gamut are clamped (not gamut-mapped) — adequate for the
 * near-in-gamut palettes our kits use.
 */

/** Clamp a number into [lo, hi]. */
function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

/** Parse an `oklch(L C H[ / a])` string into [L(0..1), C, H(deg), a(0..1)] or null. */
export function parseOklch(value: string): [number, number, number, number] | null {
  const m = /^oklch\(\s*([^)]+)\)$/i.exec(value.trim());
  if (!m?.[1]) return null;
  // Split on whitespace and an optional `/ alpha`.
  const [coords, alphaPart] = m[1].split('/');
  const parts = (coords ?? '').trim().split(/\s+/);
  if (parts.length < 3 || !parts[0] || !parts[1] || !parts[2]) return null;
  const L = parseComponent(parts[0], true);
  const C = parseComponent(parts[1], false);
  const H = parseAngle(parts[2]);
  if (L === null || C === null || H === null) return null;
  let a = 1;
  if (alphaPart !== undefined) {
    const av = parseComponent(alphaPart.trim(), true);
    if (av !== null) a = clamp(av, 0, 1);
  }
  return [clamp(L, 0, 1), Math.max(0, C), H, a];
}

/** Parse a lightness/chroma/alpha component: `62%` → 0.62, `0.62` → 0.62. */
function parseComponent(s: string, percentIsFraction: boolean): number | null {
  s = s.trim();
  if (s.endsWith('%')) {
    const n = Number.parseFloat(s.slice(0, -1));
    return Number.isFinite(n) ? (percentIsFraction ? n / 100 : n / 100) : null;
  }
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

/** Parse a hue angle: bare number or `145deg`. */
function parseAngle(s: string): number | null {
  s = s.trim().replace(/deg$/i, '');
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function linearToSrgb(c: number): number {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
  return clamp(v, 0, 1);
}

function toHex2(n: number): string {
  return Math.round(n * 255)
    .toString(16)
    .padStart(2, '0');
}

/**
 * Convert an OKLCH string to `#rrggbb` (or `#rrggbbaa` when alpha < 1).
 * Returns null if `value` is not parseable OKLCH.
 */
export function oklchToHex(value: string): string | null {
  const parsed = parseOklch(value);
  if (!parsed) return null;
  const [L, C, Hdeg, alpha] = parsed;
  const h = (Hdeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);

  // OKLab → LMS (cube of the linear terms).
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  // LMS → linear sRGB.
  const r = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bl = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;

  let hex = `#${toHex2(linearToSrgb(r))}${toHex2(linearToSrgb(g))}${toHex2(linearToSrgb(bl))}`;
  if (alpha < 1) hex += toHex2(alpha);
  return hex;
}

/**
 * Normalize any color token to a lowercase `#rrggbb[aa]` hex when possible.
 * Passes through existing hex (lowercased, expanded from #rgb), converts
 * `oklch(...)`, and returns null for values we can't resolve (named colors,
 * gradients, non-color tokens like font names).
 */
export function colorToHex(value: string): string | null {
  const v = value.trim();
  const oklch = oklchToHex(v);
  if (oklch) return oklch.toLowerCase();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(v);
  if (hex?.[1]) {
    let h = hex[1].toLowerCase();
    if (h.length === 3 || h.length === 4) {
      h = h
        .split('')
        .map((c) => c + c)
        .join('');
    }
    return `#${h}`;
  }
  return null;
}

/** True when a token value looks like a color (OKLCH or hex), not a font/size. */
export function isColorToken(value: string): boolean {
  return colorToHex(value) !== null;
}
