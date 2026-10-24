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

/**
 * Parse a lightness/chroma/alpha component. `percentIsFraction` selects the
 * percentage reference range (CSS Color 4):
 *   - L & alpha (`true`):  100% → 1.0   (`62%` → 0.62)
 *   - chroma   (`false`):  100% → 0.4   (`50%` → 0.20)
 * A bare number passes through unchanged for all three.
 */
function parseComponent(s: string, percentIsFraction: boolean): number | null {
  s = s.trim();
  if (s.endsWith('%')) {
    const n = Number.parseFloat(s.slice(0, -1));
    if (!Number.isFinite(n)) return null;
    return percentIsFraction ? n / 100 : (n / 100) * 0.4;
  }
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

/** Degrees per CSS `<angle>` unit; a bare number is degrees. */
const ANGLE_UNIT_DEGREES: Record<string, number> = {
  '': 1,
  deg: 1,
  grad: 0.9,
  rad: 180 / Math.PI,
  turn: 360,
};

/**
 * Parse a hue angle into degrees: bare number, `145deg`, `200grad`,
 * `3.14rad` or `0.5turn`. `parseFloat` alone stopped at the unit and read
 * `0.5turn` as 0.5°. An unknown unit is not a hue.
 */
function parseAngle(s: string): number | null {
  const m = /^([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)([a-z]*)$/i.exec(s.trim());
  const factor = m ? ANGLE_UNIT_DEGREES[m[2]!.toLowerCase()] : undefined;
  if (!m || factor === undefined) return null;
  const n = Number.parseFloat(m[1]!) * factor;
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

// ── Value classification (color / length / duration / …) ─────────────────────

const LENGTH_RE = /^-?\d*\.?\d+(?:px|rem|em|%|vw|vh|vmin|vmax|ch|pt)$/i;
const DURATION_RE = /^-?\d*\.?\d+(?:ms|s)$/i;
const NUMBER_RE = /^-?\d*\.?\d+$/;
const GRADIENT_RE = /\b(?:linear|radial|conic)-gradient\s*\(/i;
// A box-shadow-ish value: two+ offset lengths (the first is often a unitless
// `0`), optionally `inset`, usually with a trailing color. Colors and single
// lengths are caught earlier by classify, so this only sees multi-part values.
const OFFSET = String.raw`(?:0|-?\d*\.?\d+(?:px|rem|em))`;
const SHADOW_RE = new RegExp(String.raw`(?:^|,)\s*(?:inset\s+)?${OFFSET}\s+${OFFSET}`, 'i');

/**
 * Classify a design-token string into the axis it drives, so materialize/verify
 * can branch beyond colors. Order matters: colors first (an `oklch()` is not a
 * gradient), then single-unit forms, then multi-part shadow, then font stacks.
 *
 * A font-family is inferred structurally (a comma-separated list, or a single
 * quoted/multi-word/known-generic name) rather than by a token-name allowlist,
 * so custom fonts classify correctly.
 */
export function classifyTokenValue(
  value: string,
): import('@wrongstack/contracts/types/design-kit').TokenValueKind {
  const v = value.trim();
  if (!v) return 'raw';
  if (isColorToken(v)) return 'color';
  if (GRADIENT_RE.test(v)) return 'gradient';
  if (LENGTH_RE.test(v)) return 'length';
  if (DURATION_RE.test(v)) return 'duration';
  if (NUMBER_RE.test(v)) return 'number';
  if (SHADOW_RE.test(v)) return 'shadow';
  // Font stack: has a comma (list), or looks like a family name.
  const GENERIC_FONTS =
    /\b(sans-serif|serif|monospace|system-ui|ui-sans-serif|ui-monospace|ui-serif|cursive|fantasy|emoji)\b/i;
  if (v.includes(',') || GENERIC_FONTS.test(v) || /^["']?[A-Za-z][\w '-]*["']?$/.test(v)) {
    return 'font';
  }
  return 'raw';
}

// ── WCAG 2.x contrast ────────────────────────────────────────────────────────

/** sRGB relative luminance of a `#rrggbb[aa]` hex; alpha is ignored. */
function hexLuminance(hex: string): number {
  const h = hex.slice(1, 7);
  const channel = (part: string) => {
    const c = Number.parseInt(part, 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * channel(h.slice(0, 2)) +
    0.7152 * channel(h.slice(2, 4)) +
    0.0722 * channel(h.slice(4, 6))
  );
}

/**
 * WCAG 2.x contrast ratio (1..21) between two color tokens — any mix of OKLCH
 * and hex, normalized through `colorToHex`. Returns null when either side is
 * not a parseable color. Same math as the corpus AA floor test, so a kit that
 * passes that test passes this gate.
 */
export function contrastRatio(a: string, b: string): number | null {
  const ha = colorToHex(a);
  const hb = colorToHex(b);
  if (!ha || !hb) return null;
  const la = hexLuminance(ha);
  const lb = hexLuminance(hb);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}
