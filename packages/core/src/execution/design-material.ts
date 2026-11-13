/**
 * Design Studio — Material physics, 3D visual coordinate axes, photo-treatment
 * CSS compiler, and mechanical kit validator.
 *
 * Bridges WrongStack's multi-stack Light/Dark token system with tactile
 * "Material" metadata (inspired by Hallmark's material-first discipline):
 *   1. 3D coordinate axes (`paper/display/accent`) — parsed from frontmatter or
 *      inferred deterministically from `tokens.json` OKLCH values + font stacks.
 *   2. Photo treatment compiler (`photo:`) — compiles declarative specs like
 *      `warm con=-6 vib=-10`, `duotone fg surface`, or `tint accent` into CSS
 *      filters and OKLab duotone plates on `[data-slot]` media containers.
 *   3. Mechanical kit validation — checks WCAG AA contrast pairs, `photo:`
 *      syntax, and token purity inside `## Build hint` CSS snippets.
 */

import {
  DESIGN_DISPLAY_CLASSES,
  DESIGN_PAPER_BANDS,
  DESIGN_POSTURES,
  type DesignAccentBand,
  type DesignDisplayClass,
  type DesignKitAxes,
  type DesignKitManifest,
  type DesignKitTokens,
  type DesignPaperBand,
  type DesignPosture,
} from '@wrongstack/contracts/types/design-kit';
import { colorToHex, contrastRatio, parseOklch } from './design-color.js';

export function isDesignPaperBand(v: string): v is DesignPaperBand {
  return (DESIGN_PAPER_BANDS as readonly string[]).includes(v);
}

export function isDesignDisplayClass(v: string): v is DesignDisplayClass {
  return (DESIGN_DISPLAY_CLASSES as readonly string[]).includes(v);
}

export function isDesignAccentBand(v: string): v is DesignAccentBand {
  return v === 'warm' || v === 'cool' || v === 'neutral' || /^chromatic-[a-z][a-z0-9-]*$/.test(v);
}

export function isDesignPosture(v: string): v is DesignPosture {
  return (DESIGN_POSTURES as readonly string[]).includes(v);
}

/** Compact `paper/display/accent` coordinate string for diversity checks. */
export function formatKitAxesTriple(axes: DesignKitAxes): string {
  return `${axes.paper}/${axes.display}/${axes.accent}`;
}

/**
 * Parse frontmatter axis fields (`paper`, `display`, `accent`, or compact `axes`).
 * Accepts either:
 *   - `paper: light 94.5 76`, `display: roman-serif Sentient`, `accent: cool 248`
 *   - `axes: light/roman-serif/cool`
 */
export function parseKitAxesFrontmatter(fields: {
  axes?: string | undefined;
  paper?: string | undefined;
  display?: string | undefined;
  accent?: string | undefined;
}): DesignKitAxes | undefined {
  if (fields.axes) {
    const [p, d, a] = fields.axes.split('/').map((s) => s.trim());
    if (p && d && a && isDesignPaperBand(p) && isDesignDisplayClass(d) && isDesignAccentBand(a)) {
      return { paper: p, display: d, accent: a };
    }
  }
  if (!fields.paper || !fields.display || !fields.accent) return undefined;
  const pParts = fields.paper.trim().split(/\s+/);
  const dParts = fields.display.trim().split(/\s+/);
  const aParts = fields.accent.trim().split(/\s+/);
  const paper = pParts[0] ?? '';
  const display = dParts[0] ?? '';
  const accent = aParts[0] ?? '';
  if (!isDesignPaperBand(paper) || !isDesignDisplayClass(display) || !isDesignAccentBand(accent)) {
    return undefined;
  }
  const paperL = pParts[1] !== undefined ? Number(pParts[1]) : undefined;
  const paperHue = pParts[2] !== undefined ? Number(pParts[2]) : undefined;
  const displayFace = dParts.length > 1 ? dParts.slice(1).join(' ') : undefined;
  const accentHue = aParts[1] !== undefined ? Number(aParts[1]) : undefined;
  return {
    paper,
    display,
    accent,
    ...(paperL !== undefined && Number.isFinite(paperL) ? { paperL } : {}),
    ...(paperHue !== undefined && Number.isFinite(paperHue) ? { paperHue } : {}),
    ...(displayFace ? { displayFace } : {}),
    ...(accentHue !== undefined && Number.isFinite(accentHue) ? { accentHue } : {}),
  };
}

function classifyHueChromatic(hueDeg: number): DesignAccentBand {
  const h = ((hueDeg % 360) + 360) % 360;
  if (h >= 10 && h <= 65) return 'warm';
  if (h >= 200 && h <= 300) return 'cool';
  if (h > 65 && h <= 110) return 'chromatic-yellow';
  if (h > 110 && h <= 165) return 'chromatic-green';
  if (h > 165 && h < 200) return 'chromatic-teal';
  if (h > 300 && h <= 340) return 'chromatic-magenta';
  return 'chromatic-pink';
}

function classifyFontStack(font: string): { cls: DesignDisplayClass; face?: string } {
  const first = font
    .split(',')[0]
    ?.trim()
    .replace(/^["']|["']$/g, '');
  const low = font.toLowerCase();
  const face =
    first &&
    !/^(system-ui|ui-sans-serif|ui-serif|ui-monospace|sans-serif|serif|monospace)$/i.test(first)
      ? first
      : undefined;

  if (/pixel|press start|silkscreen|vt323|arcade/i.test(low)) {
    return { cls: 'pixel', ...(face ? { face } : {}) };
  }
  if (/gotisch|fraktur|blackletter|pirata|unifraktur/i.test(low)) {
    return { cls: 'blackletter', ...(face ? { face } : {}) };
  }
  if (/caveat|patrick hand|architects daughter|kalam|hand|cursive|marker/i.test(low)) {
    return { cls: 'handwritten', ...(face ? { face } : {}) };
  }
  if (
    /jetbrains|fira code|geist mono|plex mono|martian mono|chivo mono|space mono|monospace|courier/i.test(
      low,
    )
  ) {
    return { cls: 'mono', ...(face ? { face } : {}) };
  }
  if (
    /condensed|narrow|oswald|barlow condensed|saira condensed|six caps|anton|league gothic|bebas/i.test(
      low,
    )
  ) {
    return { cls: 'display-condensed', ...(face ? { face } : {}) };
  }
  if (/bungee|bowlby|big shoulders|rubik mono|impact|ultra|black/i.test(low)) {
    return { cls: 'display-heavy', ...(face ? { face } : {}) };
  }
  if (/zilla slab|roboto slab|arvo|rockwell|courier prime|slab/i.test(low)) {
    return { cls: 'slab-serif', ...(face ? { face } : {}) };
  }
  if (/playfair|bodoni|didot|prata|yeseva|boska|cormorant|cinzel/i.test(low)) {
    return { cls: 'high-contrast-serif', ...(face ? { face } : {}) };
  }
  if (
    /fraunces|sentient|newsreader|source serif|literata|vollkorn|libre caslon|hedvig|young serif|instrument serif|georgia|serif/i.test(
      low,
    )
  ) {
    return { cls: 'roman-serif', ...(face ? { face } : {}) };
  }
  if (/quicksand|nunito|fredoka|chillax|comfortaa|varela|rounded/i.test(low)) {
    return { cls: 'rounded-sans', ...(face ? { face } : {}) };
  }
  if (
    /futura|jost|outfit|poppins|syne|chakra|space grotesk|plus jakarta|gabarito|lexend|montserrat/i.test(
      low,
    )
  ) {
    return { cls: 'geometric-sans', ...(face ? { face } : {}) };
  }
  if (/cabinet grotesk|anybody|archivo black|libre franklin/i.test(low)) {
    return { cls: 'grotesk-heavy', ...(face ? { face } : {}) };
  }
  return { cls: 'grotesk-sans', ...(face ? { face } : {}) };
}

/**
 * Deterministically infer a kit's 3D `axes` from its primary theme tokens when
 * `KIT.md` omits explicit coordinate lines (e.g., user/project custom kits).
 */
export function inferKitAxesFromTokens(
  tokens: DesignKitTokens | undefined,
  themes?: readonly string[],
): DesignKitAxes | undefined {
  if (!tokens) return undefined;
  const primaryTheme = themes?.[0] === 'dark' ? 'dark' : 'light';
  const set = tokens[primaryTheme] ?? tokens.light ?? tokens.dark;
  if (!set) return undefined;

  const bgOklch = parseOklch(set['bg'] ?? '');
  const L = bgOklch ? Math.round(bgOklch[0] * 1000) / 10 : primaryTheme === 'dark' ? 16 : 98;
  const paperHue = bgOklch ? Math.round(bgOklch[2]) : 0;
  const paper: DesignPaperBand = L > 85 ? 'light' : L < 30 ? 'dark' : 'mid';

  const fontRaw =
    set['font-display'] ?? set['fontDisplay'] ?? set['font-sans'] ?? set['fontSans'] ?? 'system-ui';
  const { cls: display, face: displayFace } = classifyFontStack(fontRaw);

  const accOklch = parseOklch(set['accent'] ?? set['primary'] ?? '');
  let accent: DesignAccentBand = 'neutral';
  let accentHue: number | undefined;
  if (accOklch) {
    accentHue = Math.round(((accOklch[2] % 360) + 360) % 360);
    accent = accOklch[1] < 0.05 ? 'neutral' : classifyHueChromatic(accentHue);
  }

  return {
    paper,
    display,
    accent,
    paperL: L,
    paperHue,
    ...(displayFace ? { displayFace } : {}),
    ...(accentHue !== undefined ? { accentHue } : {}),
  };
}

// ── Photo Treatment Compiler ─────────────────────────────────────────────────

const BASE_PHOTO_FILTERS: Record<string, Record<string, number>> = {
  natural: {},
  warm: { sepia: 0.28, saturate: 0.94 },
  muted: { saturate: 0.65, contrast: 0.97 },
  mono: { grayscale: 1, contrast: 1.18 },
};

const PHOTO_ADJUSTMENTS: Record<string, [string, (n: number) => number]> = {
  con: ['contrast', (n) => 1 + n / 100],
  sat: ['saturate', (n) => Math.max(0, 1 + n / 100)],
  vib: ['saturate', (n) => 1 + n / 200],
  exp: ['brightness', (n) => 1 + n / 100],
  high: ['brightness', (n) => 1 + n / 300],
  shad: ['brightness', (n) => 1 + n / 400],
  sepia: ['sepia', (n) => Math.max(0, n / 100)],
  blur: ['blur', (n) => Math.max(0, n / 20)],
};

/** Map Hallmark-style token aliases onto WrongStack's universal semantic tokens. */
const PHOTO_TOKEN_ALIASES: Record<string, string> = {
  ink: 'fg',
  'ink-2': 'fg',
  paper: 'bg',
  'paper-2': 'surface',
  'paper-3': 'surface',
  rule: 'border',
};

const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface CompiledPhotoTreatment {
  css: string;
  filter: string;
  errors: string[];
}

/**
 * Compile a `photo:` treatment line (e.g. `warm con=-6 vib=-10`,
 * `duotone fg surface con=14`, `tint accent`) into `[data-slot]` CSS rules
 * backed by WrongStack's semantic variables (`var(--fg)`, `var(--bg)`, etc.).
 */
export function compilePhotoTreatmentCss(
  spec: string | undefined,
  options?: { knownTokens?: ReadonlySet<string> | undefined; darkPaper?: boolean | undefined },
): CompiledPhotoTreatment {
  const raw = (spec ?? 'natural').trim();
  if (!raw) return { css: '', filter: '', errors: [] };

  const parts = raw.split(/\s+/);
  const filters = new Map<string, number>();
  const errors: string[] = [];
  let duotone: [string, string] | null = null;

  const resolveVar = (tokenName: string | undefined): string => {
    if (!tokenName) {
      errors.push('missing token name in photo treatment');
      return 'var(--fg)';
    }
    const mapped = PHOTO_TOKEN_ALIASES[tokenName] ?? tokenName;
    if (
      options?.knownTokens &&
      !options.knownTokens.has(mapped) &&
      !options.knownTokens.has(tokenName)
    ) {
      errors.push(`unknown token "${tokenName}" in photo treatment`);
    }
    const varName = options?.knownTokens?.has(tokenName) ? tokenName : mapped;
    return `var(--${varName})`;
  };

  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (p in BASE_PHOTO_FILTERS) {
      for (const [k, v] of Object.entries(BASE_PHOTO_FILTERS[p]!)) filters.set(k, v);
    } else if (p === 'duotone') {
      const darkTok = resolveVar(parts[++i]);
      const lightTok = resolveVar(parts[++i]);
      duotone = [darkTok, lightTok];
      filters.set('grayscale', 1);
      if (!filters.has('contrast')) filters.set('contrast', 1.08);
    } else if (p === 'tint') {
      const tok = resolveVar(parts[++i]);
      duotone = options?.darkPaper
        ? ['var(--bg)', tok]
        : [`color-mix(in oklab, ${tok}, black 55%)`, `color-mix(in oklab, ${tok}, white 82%)`];
      filters.set('grayscale', 1);
    } else if (/^[a-z]+=-?\d+$/.test(p)) {
      const [key, numStr] = p.split('=');
      const adj = key ? PHOTO_ADJUSTMENTS[key] : undefined;
      if (!adj || numStr === undefined) {
        errors.push(`unknown photo adjustment "${p}"`);
        continue;
      }
      const [fn, calc] = adj;
      const val = calc(Number(numStr));
      filters.set(fn, key === 'vib' && filters.has(fn) ? (filters.get(fn) ?? 1) * val : val);
    } else {
      errors.push(
        `"${p}" is not a valid photo treatment (use natural, warm, muted, mono, duotone <dark> <light>, tint <token>, or con|sat|vib|exp|high|shad|sepia|blur=<n>)`,
      );
    }
  }

  const filter = [...filters.entries()]
    .map(([k, v]) => `${k}(${k === 'blur' ? `${round2(v)}px` : round2(v)})`)
    .join(' ');

  if (!filter && !duotone) {
    return { css: '', filter: '', errors };
  }

  const css = duotone
    ? [
        `[data-slot]:has(> img) { position: relative; isolation: isolate; overflow: hidden; background: ${duotone[1]}; outline: 1px solid color-mix(in oklab, var(--fg) 8%, transparent); outline-offset: -1px; }`,
        `[data-slot] > img { position: relative; z-index: 0; filter: ${filter}; mix-blend-mode: multiply; }`,
        `[data-slot]:has(> img)::before { content: ""; position: absolute; inset: 0; z-index: 1; background: ${duotone[0]}; mix-blend-mode: lighten; pointer-events: none; }`,
      ].join('\n')
    : `[data-slot] > img { filter: ${filter}; }`;

  return { css, filter, errors };
}

/** SVG feTurbulence data-URI textures for tactile paper/card/speck surfaces. */
export const MATERIAL_TEXTURE_RECIPES = {
  grain: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='g'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='1.15' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23g)'/%3E%3C/svg%3E")`,
  fibre: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='220' height='220'%3E%3Cfilter id='f'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23f)'/%3E%3C/svg%3E")`,
  speck: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Cfilter id='s'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 9 -4'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23s)'/%3E%3C/svg%3E")`,
} as const;

// ── Mechanical Kit Validation ────────────────────────────────────────────────

export interface KitValidationIssue {
  kitId: string;
  severity: 'error' | 'warning';
  rule: string;
  message: string;
}

const CORE_SEMANTIC_TOKENS = [
  'bg',
  'fg',
  'surface',
  'muted',
  'primary',
  'accent',
  'border',
  'ring',
] as const;

const AA_PAIRS: readonly [string, string][] = [
  ['fg', 'bg'],
  ['fg', 'surface'],
  ['muted', 'bg'],
  ['muted', 'surface'],
  ['bg', 'primary'],
];

/**
 * Validate a kit's manifest, light+dark tokens, photo treatment, and any
 * `## Build hint` CSS fence against WrongStack's quality & material contract.
 */
export function validateKitMaterial(
  manifest: Pick<DesignKitManifest, 'id' | 'name' | 'axes' | 'posture' | 'photo'>,
  tokens: DesignKitTokens | undefined,
  body: string,
): KitValidationIssue[] {
  const issues: KitValidationIssue[] = [];
  const kitId = manifest.id;

  if (!tokens) {
    issues.push({
      kitId,
      severity: 'error',
      rule: 'tokens.missing',
      message: 'tokens.json is missing or unreadable',
    });
    return issues;
  }

  for (const theme of ['light', 'dark'] as const) {
    const set = tokens[theme];
    if (!set) {
      issues.push({
        kitId,
        severity: 'error',
        rule: 'tokens.theme-missing',
        message: `tokens.json is missing the "${theme}" theme`,
      });
      continue;
    }
    for (const key of CORE_SEMANTIC_TOKENS) {
      const val = set[key];
      if (!val || !colorToHex(val)) {
        issues.push({
          kitId,
          severity: 'error',
          rule: 'tokens.core-color',
          message: `${theme}.${key} is missing or not a valid color`,
        });
      }
    }
    for (const [fgKey, bgKey] of AA_PAIRS) {
      const ratio = contrastRatio(set[fgKey] ?? '', set[bgKey] ?? '');
      if (ratio !== null && ratio < 4.5) {
        issues.push({
          kitId,
          severity: 'error',
          rule: 'contrast.aa-floor',
          message: `${theme} ${fgKey}/${bgKey} contrast is ${ratio.toFixed(2)}:1 (< 4.5:1 WCAG AA)`,
        });
      }
    }
  }

  if (manifest.photo) {
    const known = new Set<string>([
      ...Object.keys(tokens.light ?? {}),
      ...Object.keys(tokens.dark ?? {}),
    ]);
    const compiled = compilePhotoTreatmentCss(manifest.photo, {
      knownTokens: known,
      darkPaper: manifest.axes?.paper === 'dark',
    });
    for (const err of compiled.errors) {
      issues.push({
        kitId,
        severity: 'error',
        rule: 'material.photo-syntax',
        message: err,
      });
    }
  }

  // Validate `## Build hint` CSS fences (if present) for token purity.
  const hintMatch = /^##\s+Build hint\b[\s\S]*?```css\r?\n([\s\S]*?)```/im.exec(body);
  if (hintMatch?.[1]) {
    const css = hintMatch[1];
    for (const m of css.matchAll(/(?:transition|animation)[^;{}]*?\b(\d{2,4})ms\b/g)) {
      issues.push({
        kitId,
        severity: 'error',
        rule: 'hint.raw-duration',
        message: `raw duration "${m[1]}ms" in Build hint — use var(--duration-fast|base|slow)`,
      });
    }
    if (/(?:transition|animation)[^;{}]*(?<![-\w])ease(?:-in-out|-in|-out)?\b/.test(css)) {
      issues.push({
        kitId,
        severity: 'error',
        rule: 'hint.bare-ease',
        message:
          'bare ease keyword in Build hint — use var(--ease-standard) or var(--ease-emphasized)',
      });
    }
    for (const m of css.matchAll(/#[0-9a-f]{3,8}\b/gi)) {
      issues.push({
        kitId,
        severity: 'error',
        rule: 'hint.raw-hex',
        message: `hardcoded hex "${m[0]}" in Build hint — route colors through var(--*)`,
      });
    }
  }

  return issues;
}
