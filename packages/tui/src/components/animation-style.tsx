// Animation styles for the TUI's working/thinking state chip.
//
// The status bar paints a small text label (e.g. "● thinking…") whenever the
// agent is running or streaming. To keep the indicator lively without being
// distracting, we apply one of several `AnimationStyle`s to that label — each
// style consumes the same `(text, phase, tick)` inputs and produces a
// different visual effect.
//
// Style catalog:
//   - `rainbow`  per-glyph hue cycling (the original wave UI)
//   - `wave`     per-glyph brightness sweep, single color
//   - `pulse`    whole-text brightness pulse, single color
//   - `dots`     trailing `.` `..` `...` ellipsis that grows and resets
//   - `breathe`  the leading glyph cycles through braille spinner frames while
//                the text itself stays flat
//
// `phase` is the per-frame tick from the spinner interval (0..N-1).
// `tick` is a coarser time tick (0..∞) used by styles that need seconds-scale
// pacing (cycle). The status bar ticks `phase` every ~250ms and `tick` every
// ~1s.
//
// Pastel (Catppuccin Mocha) hue-wheel for `rainbow`. 12 stops give a smooth
// gradient as the per-character offset shifts each spinner tick — soft tones
// so the wave stays gentle rather than neon.
export const HUE_WHEEL = [
  '#f38ba8', // red
  '#eba0ac', // maroon
  '#fab387', // peach
  '#f9e2af', // yellow
  '#a6e3a1', // green
  '#94e2d5', // teal
  '#89dceb', // sky
  '#89b4fa', // blue
  '#b4befe', // lavender
  '#cba6f7', // mauve
  '#f5c2e7', // pink
  '#f2cdcd', // flamingo
];

// Single base color used by `wave` / `pulse` / `breathe`. Stays inside the
// theme so it pairs with the rest of the status chip.
const ACCENT = '#fab387'; // Catppuccin peach

// Dim/highlight stops for the brightness sweep styles.
const DIM = '#313244'; // Catppuccin surface0

// Braille spinner frames used by `breathe` and by the leading statePrefix
// glyph.
export const BREATHE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// Dots frames — appended to the text. The number of dots wraps so the
// ellipsis cycles `.` → `..` → `...` → `..` → `.` → …
//   frame 0 → "thinking"   frame 1 → "thinking."   frame 2 → "thinking.."
//   frame 3 → "thinking..." frame 4 → "thinking.."   frame 5 → "thinking."
//   then wrap to 0
export const DOTS_FRAMES = ['', '.', '..', '...', '..', '.'];

export const ANIMATION_STYLES = ['rainbow', 'wave', 'pulse', 'dots', 'breathe'] as const;
export type AnimationStyle = (typeof ANIMATION_STYLES)[number];

export const DEFAULT_ANIMATION_STYLE: AnimationStyle = 'rainbow';

export const ANIMATION_STYLE_DESCS: Record<AnimationStyle, string> = {
  rainbow: 'Per-glyph hue cycle (default)',
  wave: 'Single-color brightness sweep',
  pulse: 'Whole-text brightness pulse',
  dots: 'Trailing dots ellipsis (. .. ... .. .)',
  breathe: 'Spinning braille glyph prefix, flat text',
};

/**
 * Seconds the user must be idle on the same style before `cycle` advances
 * to the next one. Picked to feel like a "shuffle" rather than a flicker.
 */
export const CYCLE_INTERVAL_SECONDS = 12;

/**
 * Milliseconds between each cycle tick. Picked so the cycle timer doesn't
 * drive unnecessary re-renders for idle sessions (the StatusBar pauses the
 * timer when state is idle/aborting).
 */
export const CYCLE_TICK_INTERVAL_MS = 1000;

/**
 * Cycle through every other `AnimationStyle` in order, returning to the
 * start once the list is exhausted. `rainbow` is excluded from the cycle
 * (it's the default/canonical look); cycle goes through the four variant
 * styles only.
 */
export const CYCLE_ORDER: readonly AnimationStyle[] = ['wave', 'pulse', 'dots', 'breathe'];

/**
 * Map a coarse `tick` (seconds elapsed since the cycle started) onto the
 * currently-active style. Returns the style at the cycle index derived from
 * `floor(tick / CYCLE_INTERVAL_SECONDS)`.
 *
 * Pure + exported for testing.
 */
export function styleForCycleTick(tick: number): AnimationStyle {
  const idx = Math.max(0, Math.floor(tick / CYCLE_INTERVAL_SECONDS));
  const i = idx % CYCLE_ORDER.length;
  return CYCLE_ORDER[i] ?? CYCLE_ORDER[0]!;
}

/** Mix two `#rrggbb` colors by `t ∈ [0,1]`. Pure. */
export function mixHex(a: string, b: string, t: number): string {
  const ca = parseHex(a);
  const cb = parseHex(b);
  if (!ca || !cb) return b;
  const k = Math.max(0, Math.min(1, t));
  const r = Math.round(ca[0] + (cb[0] - ca[0]) * k);
  const g = Math.round(ca[1] + (cb[1] - ca[1]) * k);
  const bl = Math.round(ca[2] + (cb[2] - ca[2]) * k);
  return `#${toHex(r)}${toHex(g)}${toHex(bl)}`;
}

function parseHex(s: string): [number, number, number] | null {
  if (!/^#[0-9a-f]{6}$/i.test(s)) return null;
  return [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
}

function toHex(n: number): string {
  return n.toString(16).padStart(2, '0');
}

/**
 * Pick a colour for the given glyph index + phase under the `wave` style —
 * interpolates from `DIM` to `ACCENT` along a sinusoidal band so the bright
 * spot glides smoothly across the text. Pure for testing.
 */
export function waveColor(charIndex: number, phase: number, length: number): string {
  const t = length > 0 ? charIndex / length : 0;
  const sweep = Math.sin(t * Math.PI * 2 + phase / 10);
  return mixHex(DIM, ACCENT, (sweep + 1) / 2);
}

/**
 * Pick a colour for the whole text under the `pulse` style — single color
 * modulated by an oscillator so the whole chip dims/brightens together.
 * Pure for testing.
 */
export function pulseColor(phase: number): string {
  const t = (phase % 16) / 16;
  const k = 0.5 - 0.5 * Math.cos(t * Math.PI * 2);
  return mixHex(DIM, ACCENT, k);
}

/** Strip trailing `.`, `…`, etc. so the `dots` style doesn't double up on
 *  the user-supplied label. */
export function stripTrailingDots(text: string): string {
  let s = text;
  while (s.length > 0) {
    const last = s.charAt(s.length - 1);
    if (last === '.' || last === ' ' || last === '…' || last === '·') {
      s = s.slice(0, -1);
    } else {
      break;
    }
  }
  return s;
}
