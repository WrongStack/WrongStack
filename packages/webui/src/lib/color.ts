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
  return n < lo ? lo : n > hi ? hi : n;
}

function parseOklch(value: string): [number, number, number] | null {
  const m = /^oklch\(\s*([^)]+)\)$/i.exec(value.trim());
  if (!m?.[1]) return null;
  const coords = m[1].split('/')[0] ?? '';
  const parts = coords.trim().split(/\s+/);
  if (parts.length < 3 || !parts[0] || !parts[1] || !parts[2]) return null;
  const L = parts[0].endsWith('%')
    ? Number.parseFloat(parts[0]) / 100
    : Number.parseFloat(parts[0]);
  const C = parts[1].endsWith('%')
    ? Number.parseFloat(parts[1]) / 100
    : Number.parseFloat(parts[1]);
  const H = Number.parseFloat(parts[2].replace(/deg$/i, ''));
  if (![L, C, H].every(Number.isFinite)) return null;
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
