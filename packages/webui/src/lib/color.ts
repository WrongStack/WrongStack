/**
 * Browser-safe OKLCH→hex conversion for the Design Studio gallery's color
 * pickers. The native `<input type="color">` is hex-only, so we seed it from a
 * token's OKLCH value and store the user's pick back as hex (a valid token
 * value — materialize/verify handle hex too).
 *
 * This duplicates `@wrongstack/core`'s `design-color` math because the Vite
 * browser build can't import the core barrel (Node built-ins) — see the
 * "webui browser can't import core barrel" note. Keep the two in sync.
 */

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

/** Degrees per CSS `<angle>` unit; a bare number is degrees (mirrors core's parseAngle). */
const ANGLE_UNIT_DEGREES: Record<string, number> = {
  '': 1,
  deg: 1,
  grad: 0.9,
  rad: 180 / Math.PI,
  turn: 360,
};

/** Hue in degrees from `145`, `145deg`, `200grad`, `3.14rad` or `0.5turn`; unknown unit → null. */
function parseAngle(s: string): number | null {
  const m = /^([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)([a-z]*)$/i.exec(s.trim());
  const unit = m?.[2]?.toLowerCase() ?? '';
  const factor =
    m && Object.hasOwn(ANGLE_UNIT_DEGREES, unit) ? ANGLE_UNIT_DEGREES[unit] : undefined;
  if (!m?.[1] || factor === undefined) return null;
  const n = Number.parseFloat(m[1]) * factor;
  return Number.isFinite(n) ? n : null;
}

function parseOklchComponent(token: string, pctScale: number): number | null {
  const match = /^([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)(%?)$/i.exec(token.trim());
  if (!match?.[1]) return null;
  const raw = Number.parseFloat(match[1]);
  if (!Number.isFinite(raw)) return null;
  return match[2] === '%' ? (raw / 100) * pctScale : raw;
}

function parseOklch(value: string): [number, number, number] | null {
  const m = /^oklch\(\s*([^)]+)\)$/i.exec(value.trim());
  if (!m?.[1]) return null;
  const coords = m[1].split('/')[0] ?? '';
  const parts = coords.trim().split(/\s+/);
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return null;
  const L = parseOklchComponent(parts[0], 1);
  // Chroma percentage reference (CSS Color 4): 100% → 0.4. L stays 100% → 1.0.
  const C = parseOklchComponent(parts[1], 0.4);
  const H = parseAngle(parts[2]);
  if (L === null || C === null || H === null) return null;
  return [clamp(L, 0, 1), Math.max(0, C), H];
}

function lin(c: number): number {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
  return clamp(v, 0, 1);
}

function hex2(n: number): string {
  return Math.round(n * 255)
    .toString(16)
    .padStart(2, '0');
}

/** OKLCH string → `#rrggbb`, or null if not parseable OKLCH. */
export function oklchToHex(value: string): string | null {
  const p = parseOklch(value);
  if (!p) return null;
  const [L, C, Hdeg] = p;
  const h = (Hdeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bl = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  return `#${hex2(lin(r))}${hex2(lin(g))}${hex2(lin(bl))}`;
}

/** Any color token → `#rrggbb` (hex passthrough, oklch convert), else null. */
export function colorToHex(value: string): string | null {
  const v = value.trim();
  const ok = oklchToHex(v);
  if (ok) return ok.toLowerCase();
  const hx = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(v);
  if (hx?.[1]) return `#${hx[1].toLowerCase()}`;
  const short = /^#([0-9a-f]{3})$/i.exec(v);
  if (short?.[1]) {
    return `#${short[1]
      .split('')
      .map((c) => c + c)
      .join('')
      .toLowerCase()}`;
  }
  return null;
}
