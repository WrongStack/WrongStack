/**
 * Design Studio — capture a project's EXISTING token source.
 *
 * `design verify` (and the write-time drift middleware) originally required a
 * pinned kit. But design-critique documents the common case in a mature
 * codebase: the project HAS a token system (`:root`/`@theme` CSS vars, a
 * theme.ts, Dart ColorScheme constants) and no kit — capturing those tokens
 * lets the same enforcement loop run against the project's own system without
 * replacing it.
 *
 * Parsers are deliberately regex/line-based and honest about limits: values
 * are normalized to hex/OKLCH (the formats `colorToHex` can match), and
 * anything unparsable is skipped and counted, never guessed. Best-effort
 * discovery checks a bounded list of conventional paths; explicit files can
 * be passed instead.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { DesignKitTokens } from '@wrongstack/contracts/types/design-kit';
import { classifyTokenValue, colorToHex } from './design-color.js';
import { designMdToTokens, parseDesignMd } from './design-md.js';

export interface CaptureResult {
  /** Inferred stack from what was actually found. */
  stack: 'web' | 'react-native' | 'flutter';
  /** Project-relative files that yielded tokens. */
  files: string[];
  tokens: DesignKitTokens;
  /**
   * `[data-palette="x"]` variant blocks, recorded separately — they override
   * the base system per user selection, so they never stomp the captured
   * `:root`/`.dark` values (informational; verify runs against the base).
   */
  palettes: Record<string, Record<string, string>>;
  /** Inspected candidate files that produced nothing. */
  skipped: string[];
  /** Honest limitations (unparsable values, partial themes…). */
  notes: string[];
}

// ── value normalization ──────────────────────────────────────────────────────

const HSL_RE = /^hsl\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%\s*\)$/i;
const RGB_RE = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i;

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function toHex2(n: number): string {
  return Math.round(clamp01(n) * 255)
    .toString(16)
    .padStart(2, '0');
}

/**
 * Normalize a declaration value into something `colorToHex` parses (hex or
 * OKLCH). shadcn's classic `--primary: 222 47% 11%;` channel triplets are
 * wrapped as hsl(); hsl()/rgb() strings are converted to hex. Returns null
 * for var() references, color-mix(), gradients, fonts — anything not a color.
 */
export function normalizeCssValue(raw: string): string | null {
  const v = raw.trim();
  if (!v || v.startsWith('var(') || v.includes('gradient(') || v.startsWith('color-mix(')) {
    return null;
  }
  // shadcn HSL channel triplet: "222 47% 11%" (no function wrapper).
  const triplet = /^([\d.]+)\s+([\d.]+)%\s+([\d.]+)%$/.exec(v);
  if (triplet) {
    return hslToHex(
      Number.parseFloat(triplet[1]!) / 360,
      Number.parseFloat(triplet[2]!) / 100,
      Number.parseFloat(triplet[3]!) / 100,
    );
  }
  if (colorToHex(v)) return v; // already hex / oklch
  const hsl = HSL_RE.exec(v);
  if (hsl) {
    const h = Number.parseFloat(hsl[1]!) / 360;
    const s = Number.parseFloat(hsl[2]!) / 100;
    const l = Number.parseFloat(hsl[3]!) / 100;
    return hslToHex(h, s, l);
  }
  const rgb = RGB_RE.exec(v);
  if (rgb) {
    const a =
      rgb[4] === undefined ? 1 : Number.parseFloat(rgb[4]) / (rgb[4].endsWith('%') ? 100 : 255);
    return `#${toHex2(Number.parseFloat(rgb[1]!) / 255)}${toHex2(Number.parseFloat(rgb[2]!) / 255)}${toHex2(
      Number.parseFloat(rgb[3]!) / 255,
    )}${a < 1 ? toHex2(a) : ''}`;
  }
  return null;
}

function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h * 6;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  return `#${toHex2(r + m)}${toHex2(g + m)}${toHex2(b + m)}`;
}

// ── CSS vars (`:root` / `.dark` / `@theme`) ─────────────────────────────────

/** Stock Tailwind shadow utility names (`@theme`-redefinable). */
const STOCK_SHADOW_NAME_RE = /^shadow-(?:2xs|xs|sm|md|lg|xl|2xl)$/;

/**
 * Line-based CSS custom-property scanner. Contexts: light (`:root`, `@theme`,
 * top level), dark (`.dark`, `[data-theme…dark]`). `[data-palette="x"]`
 * variant blocks are recorded SEPARATELY — they override the base system per
 * user selection, so recording them into the base capture would stomp
 * `:root`/`.dark` with whichever variant block came last. One declaration per
 * line is the practical formatting (prettier); nesting deeper than one
 * selector line is not tracked — a documented best-effort limit.
 *
 * Stock shadow utility redefinitions (`--shadow-sm: …` in `@theme`) are kept
 * as RAW non-color markers: their presence tells `verifyFiles` that this
 * project remaps the stock `shadow-*` utilities, so those utilities are
 * token-driven here — not "stock Tailwind elevation".
 */
export function parseCssTokens(text: string): {
  light: Record<string, string>;
  dark: Record<string, string>;
  /** `[data-palette="x"]` blocks, keyed by palette name (base-capture-excluded). */
  palettes: Record<string, Record<string, string>>;
  unparsed: number;
} {
  const stripped = text.replace(/\/\*[\s\S]*?\*\//g, '');
  const light: Record<string, string> = {};
  const dark: Record<string, string> = {};
  const palettes: Record<string, Record<string, string>> = {};
  let unparsed = 0;
  let ctx: 'light' | 'dark' | 'variant' | null = 'light';
  let variantName = '';

  for (const line of stripped.split('\n')) {
    const trimmed = line.trim();
    const decl = /^--([\w-]+)\s*:\s*([^;]+);?$/.exec(trimmed);
    if (decl && ctx) {
      const name = decl[1]!.replace(/^color-/, '');
      const raw = (decl[2] ?? '').trim();
      const value = normalizeCssValue(raw);
      const target = ctx === 'dark' ? dark : ctx === 'variant' ? palettes[variantName]! : light;
      if (value) {
        target[name] = value;
      } else if (STOCK_SHADOW_NAME_RE.test(name)) {
        target[name] = raw; // raw remap marker — see the doc comment above
      } else {
        unparsed++;
      }
      continue;
    }
    if (trimmed.endsWith('{')) {
      const sel = trimmed.slice(0, -1).trim();
      const pal = /\[data-palette\s*=\s*["']?([\w-]+)["']?\]/.exec(sel);
      if (/\.dark\b|\[data-theme.*dark|\[data-.*'dark'/.test(sel)) {
        ctx = 'dark';
      } else if (pal) {
        ctx = 'variant';
        variantName = pal[1] ?? 'variant';
        palettes[variantName] ??= {};
      } else if (sel.includes(':root') || sel.startsWith('@theme') || sel === '') {
        ctx = 'light';
      } else {
        ctx = 'light'; // unknown selector — vars there still count as light
      }
      continue;
    }
    if (trimmed.startsWith('}') || trimmed === '') {
      ctx = trimmed === '' ? ctx : 'light';
    }
  }
  return { light, dark, palettes, unparsed };
}

// ── theme.ts (React Native style object literals) ───────────────────────────

/** Extract `key: 'value'` pairs from an object literal block. */
function parseObjectEntries(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/['"]?([\w-]+)['"]?\s*:\s*['"]([^'"]+)['"]/g)) {
    out[m[1]!] = m[2]!;
  }
  return out;
}

export function parseTsThemeTokens(text: string): {
  light: Record<string, string>;
  dark: Record<string, string>;
  notes: string[];
} {
  const notes: string[] = [];
  const light: Record<string, string> = {};
  const dark: Record<string, string> = {};
  for (const m of text.matchAll(
    /\b(?:const|let|var)\s+(lightTheme|darkTheme|light|dark)\s*[:=]\s*\{([\s\S]*?)\n\}/g,
  )) {
    const entries = parseObjectEntries(m[2] ?? '');
    if (/^dark/i.test(m[1]!)) Object.assign(dark, entries);
    else Object.assign(light, entries);
  }
  if (Object.keys(light).length === 0 && Object.keys(dark).length === 0) {
    notes.push('no lightTheme/darkTheme object literals found in theme.ts');
  }
  return { light, dark, notes };
}

// ── Dart ColorScheme / Color constants ──────────────────────────────────────

/** `name: Color(0xAARRGGBB)` (optional `const`) → token name → #rrggbb. */
export function parseDartTokens(text: string): {
  light: Record<string, string>;
  dark: Record<string, string>;
  notes: string[];
} {
  const notes: string[] = [];
  const light: Record<string, string> = {};
  const dark: Record<string, string> = {};
  let ctx: 'light' | 'dark' = 'light';
  for (const line of text.split('\n')) {
    const open = /^(\S[^{(]*)(?:\(|\{)\s*$/.exec(line.trim());
    if (open) {
      const head = open[1] ?? '';
      ctx = /dark/i.test(head) ? 'dark' : 'light';
    }
    if (/^\}|^\)/.test(line.trim())) ctx = 'light';
    const record = (name: string, argb: string) => {
      // `0xAARRGGBB` → `#rrggbb` (alpha dropped; matching ignores it anyway).
      (ctx === 'dark' ? dark : light)[name] = `#${argb.slice(4).toLowerCase()}`;
    };
    // Named parameters: `primary: Color(0xFF…)` (ColorScheme / constructors).
    for (const m of line.matchAll(/\b(\w+)\s*:\s*(?:const\s+)?Color\((0x[0-9A-Fa-f]{8})\)/g)) {
      record(m[1]!, m[2]!);
    }
    // Class fields: `static const Color primary = Color(0xFF…)` — the shape
    // `design materialize` itself generates.
    for (const m of line.matchAll(
      /\bColor\s+(\w+)\s*=\s*(?:const\s+)?Color\((0x[0-9A-Fa-f]{8})\)/g,
    )) {
      record(m[1]!, m[2]!);
    }
  }
  if (Object.keys(light).length === 0 && Object.keys(dark).length === 0) {
    notes.push('no Color(0x…) constants found in the Dart file');
  }
  return { light, dark, notes };
}

// ── discovery + orchestration ────────────────────────────────────────────────

const CSS_CANDIDATES = [
  'src/index.css',
  'src/globals.css',
  'src/app/globals.css',
  'src/styles/globals.css',
  'src/styles/index.css',
  'src/styles/design-tokens.css',
  'styles/globals.css',
  'app/globals.css',
  'index.css',
  'globals.css',
];
const TS_CANDIDATES = [
  'src/theme/design-tokens.ts',
  'src/theme/theme.ts',
  'src/theme/tokens.ts',
  'src/theme.ts',
  'theme.ts',
];
const DART_CANDIDATES = [
  'lib/theme/design_tokens.dart',
  'lib/theme/theme.dart',
  'lib/theme/colors.dart',
  'lib/core/theme.dart',
];

async function firstExisting(
  projectRoot: string,
  candidates: string[],
): Promise<{ rel: string; text: string }[]> {
  const hits: { rel: string; text: string }[] = [];
  for (const rel of candidates) {
    try {
      const text = await fs.readFile(path.join(projectRoot, rel), 'utf8');
      hits.push({ rel, text });
    } catch {
      // candidate absent — next
    }
  }
  return hits;
}

/**
 * Capture the project's token source into a DesignKitTokens-shaped snapshot.
 * Explicit `files` (project-relative) override discovery; otherwise the
 * conventional candidate paths are probed, CSS first.
 */
export async function captureProjectTokens(
  projectRoot: string,
  opts?: { files?: string[] | undefined },
): Promise<CaptureResult> {
  const notes: string[] = [];
  const skipped: string[] = [];
  const light: Record<string, string> = {};
  const dark: Record<string, string> = {};
  const palettes: Record<string, Record<string, string>> = {};
  const used: string[] = [];
  let stack: CaptureResult['stack'] = 'web';

  const explicit = opts?.files?.filter(Boolean) ?? [];
  const targets: { rel: string; text: string }[] = explicit.length
    ? (
        await Promise.all(
          explicit.map(async (rel) => {
            try {
              return { rel, text: await fs.readFile(path.join(projectRoot, rel), 'utf8') };
            } catch {
              skipped.push(rel);
              return null;
            }
          }),
        )
      ).filter((x): x is { rel: string; text: string } => x !== null)
    : [
        // A DESIGN.md is the project's declared system — it wins over inference.
        ...(await firstExisting(projectRoot, ['DESIGN.md', 'docs/DESIGN.md'])),
        ...(await firstExisting(projectRoot, CSS_CANDIDATES)),
        ...(await firstExisting(projectRoot, TS_CANDIDATES)),
        ...(await firstExisting(projectRoot, DART_CANDIDATES)),
      ];

  const declaredLight: Record<string, string> = {};
  const declaredDark: Record<string, string> = {};

  for (const { rel, text } of targets) {
    if (/(^|[\\/])DESIGN\.md$/i.test(rel)) {
      const parsed = parseDesignMd(text);
      const errors = parsed.issues.filter((i) => i.severity === 'error');
      if (!parsed.doc || errors.length > 0) {
        skipped.push(rel);
        notes.push(
          `${rel}: not used — ${errors.map((e) => `[${e.rule}] ${e.message}`).join('; ')}`,
        );
        continue;
      }
      const fromMd = designMdToTokens(parsed.doc);
      Object.assign(light, fromMd.light);
      Object.assign(dark, fromMd.dark);
      Object.assign(declaredLight, fromMd.light);
      Object.assign(declaredDark, fromMd.dark);
      for (const w of parsed.issues.filter((i) => i.severity === 'warning')) {
        notes.push(`${rel}: [${w.rule}] ${w.message}`);
      }
      used.push(rel);
    } else if (/\.css$/i.test(rel)) {
      const parsed = parseCssTokens(text);
      if (Object.keys(parsed.light).length === 0 && Object.keys(parsed.dark).length === 0) {
        skipped.push(rel);
        continue;
      }
      stack = 'web';
      Object.assign(light, parsed.light);
      Object.assign(dark, parsed.dark);
      for (const [name, vars] of Object.entries(parsed.palettes)) {
        palettes[name] = { ...(palettes[name] ?? {}), ...vars };
      }
      if (Object.keys(parsed.palettes).length > 0) {
        notes.push(
          `${rel}: palette variants recorded separately (not in the base capture): ${Object.keys(parsed.palettes).join(', ')}`,
        );
      }
      if (parsed.unparsed > 0) {
        notes.push(`${rel}: ${parsed.unparsed} declaration(s) skipped (non-color values)`);
      }
      used.push(rel);
    } else if (/\.ts$/i.test(rel)) {
      const parsed = parseTsThemeTokens(text);
      if (Object.keys(parsed.light).length === 0 && Object.keys(parsed.dark).length === 0) {
        skipped.push(rel);
        continue;
      }
      stack = 'react-native';
      Object.assign(light, parsed.light);
      Object.assign(dark, parsed.dark);
      notes.push(...parsed.notes);
      used.push(rel);
    } else if (/\.dart$/i.test(rel)) {
      const parsed = parseDartTokens(text);
      if (Object.keys(parsed.light).length === 0 && Object.keys(parsed.dark).length === 0) {
        skipped.push(rel);
        continue;
      }
      stack = 'flutter';
      Object.assign(light, parsed.light);
      Object.assign(dark, parsed.dark);
      notes.push(...parsed.notes);
      used.push(rel);
    } else {
      notes.push(`${rel}: unsupported capture format (expected DESIGN.md/.css/.ts/.dart)`);
    }
  }

  // Re-apply declared DESIGN.md tokens when auto-discovered alongside inferred files so DESIGN.md wins.
  if (!explicit.length) {
    Object.assign(light, declaredLight);
    Object.assign(dark, declaredDark);
  }

  if (used.length === 0) {
    notes.push(
      'no token source found — pass explicit files or create one of the conventional paths (e.g. src/index.css, src/theme/theme.ts, lib/theme/theme.dart)',
    );
  }
  // Dark overlays light (CSS dark blocks usually override only some vars).
  const tokens: DesignKitTokens = {};
  if (Object.keys(light).length > 0) tokens.light = light;
  const mergedDark = { ...light, ...dark };
  if (Object.keys(dark).length > 0 || tokens.light) tokens.dark = mergedDark;

  return { stack, files: used, tokens, palettes, skipped, notes };
}

// ── established-system detection (no write) ──────────────────────────────────

/**
 * A token system the project already declares at a conventional path, found
 * without anyone running `design capture`. The Design Studio uses it to stop
 * offering new kits to a project that has its own system, and to check
 * frontend writes against it.
 */
export interface EstablishedDesignSystem {
  stack: CaptureResult['stack'];
  files: string[];
  tokens: DesignKitTokens;
  /** Color token names, light theme first; the evidence the system is real. */
  colorNames: string[];
}

/**
 * Below this many color tokens a stylesheet is a reset or a one-off variable,
 * not a system; offering a kit stays the right move.
 */
const ESTABLISHED_MIN_COLORS = 4;

/** Semantic roles lead the summary; chart and brand ramps follow in source order. */
const ROLE_NAME_RE =
  /^(?:bg|background|fg|foreground|surface|raised|card|popover|primary|secondary|accent|muted|border|input|ring|destructive|danger|success|warning|info)(?:-foreground|-fg)?$/;

function roleRank(name: string): number {
  return ROLE_NAME_RE.test(name) ? 0 : 1;
}

const ALL_CANDIDATES = [
  'DESIGN.md',
  'docs/DESIGN.md',
  ...CSS_CANDIDATES,
  ...TS_CANDIDATES,
  ...DART_CANDIDATES,
];

/** Keyed by project root; reused while every candidate's mtime is unchanged. */
const establishedMemo = new Map<
  string,
  { signature: string; result: EstablishedDesignSystem | undefined }
>();

/**
 * The project's own design system at the conventional token paths, or
 * undefined when there is none worth calling a system. Read-only: unlike
 * `design capture`, nothing is persisted. Runs on every UI turn, so the parse
 * is reused until a candidate file changes.
 */
export async function detectEstablishedDesignSystem(
  projectRoot: string | undefined,
): Promise<EstablishedDesignSystem | undefined> {
  if (!projectRoot) return undefined;
  const stamps = await Promise.all(
    ALL_CANDIDATES.map((rel) =>
      fs.stat(path.join(projectRoot, rel)).then(
        (s) => `${rel}:${s.mtimeMs}:${s.size}`,
        () => '',
      ),
    ),
  );
  const signature = stamps.filter(Boolean).join('|');
  const cached = establishedMemo.get(projectRoot);
  if (cached && cached.signature === signature) return cached.result;

  let result: EstablishedDesignSystem | undefined;
  if (signature) {
    const captured = await captureProjectTokens(projectRoot).catch(() => undefined);
    const names = new Set<string>();
    for (const theme of [captured?.tokens.light, captured?.tokens.dark]) {
      for (const [name, value] of Object.entries(theme ?? {})) {
        if (classifyTokenValue(value) === 'color') names.add(name);
      }
    }
    if (captured && names.size >= ESTABLISHED_MIN_COLORS) {
      result = {
        stack: captured.stack,
        files: captured.files,
        tokens: captured.tokens,
        colorNames: [...names].sort((a, b) => roleRank(a) - roleRank(b)),
      };
    }
  }
  establishedMemo.set(projectRoot, { signature, result });
  return result;
}
