/**
 * DESIGN.md — the interchange format for a project's design system.
 *
 * Follows google-labs-code/design.md (spec status: alpha, Apache-2.0, checked
 * 2026-10-19): YAML front matter holds the normative tokens (`colors`,
 * `typography`, `rounded`, `spacing`, `components`, with `{group.token}`
 * references) and `##` sections in a fixed order hold the rationale. Reading
 * it makes the token-adherence checks work for a project that never pinned a
 * kit; writing it hands a kit, its overrides or a measured reference to any
 * tool that speaks the format.
 *
 * DESIGN.md has no light/dark split. Dark values are written as `dark-<role>`
 * colors — the spec accepts any consistent naming — and read back into the
 * dark theme, so a round trip through this module keeps both themes.
 */

import type { DesignKitTokens } from '@wrongstack/contracts/types/design-kit';
import { parseDocument, stringify } from 'yaml';
import { classifyTokenValue, colorToHex, contrastRatio } from './design-color.js';
import type {
  DesignDna,
  DnaBreakpoint,
  DnaCoverage,
  DnaGradient,
  DnaStateRule,
  DnaTypographySpec,
} from './design-dna.js';

export interface DesignMdTypography {
  fontFamily?: string | undefined;
  fontSize?: string | undefined;
  fontWeight?: number | string | undefined;
  lineHeight?: string | number | undefined;
  letterSpacing?: string | undefined;
  textTransform?: string | undefined;
}

export interface DesignMdSource {
  url?: string | undefined;
  pagesAnalyzed?: number | undefined;
  extractedAt?: string | undefined;
  tokensMeasured?: boolean | undefined;
}

export interface DesignMdThemes {
  derived?: string | undefined;
  light?: Record<string, string> | undefined;
  dark?: Record<string, string> | undefined;
}

export interface DesignMdDoc {
  version?: string | undefined;
  name?: string | undefined;
  description?: string | undefined;
  source?: DesignMdSource | undefined;
  colors: Record<string, string>;
  typography: Record<string, DesignMdTypography>;
  rounded: Record<string, string>;
  spacing: Record<string, string | number>;
  borderWidths?: Record<string, string> | undefined;
  shadows?: Record<string, string> | undefined;
  elevationStrategy?: string | undefined;
  themes?: DesignMdThemes | undefined;
  gradients?: DnaGradient[] | undefined;
  components: Record<string, Record<string, string>>;
  states?: Record<string, Record<string, string | number>> | undefined;
  breakpoints?: DnaBreakpoint[] | undefined;
  coverage?: DnaCoverage | undefined;
}

export interface DesignMdIssue {
  rule: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
}

export interface ParsedDesignMd {
  doc: DesignMdDoc | null;
  sections: string[];
  issues: DesignMdIssue[];
}

/** Spec section order; aliases map onto the canonical heading. */
const SECTION_ORDER = [
  'Overview',
  'Colors',
  'Typography',
  'Layout',
  'Elevation & Depth',
  'Shapes',
  'Components',
  "Do's and Don'ts",
];

/** Extended 10-section designmd.me order (where Component Stylings precedes Layout Principles). */
const DESIGNMD_SECTION_ORDER = [
  'Overview',
  'Colors',
  'Typography',
  'Components',
  'Layout',
  'Elevation & Depth',
  "Do's and Don'ts",
  'Responsive Behavior',
  'Agent Prompt Guide',
  'Known Gaps',
];

const SECTION_ALIAS: Record<string, string> = {
  'Brand & Style': 'Overview',
  'Visual Theme & Atmosphere': 'Overview',
  'Color Palette & Roles': 'Colors',
  'Typography Rules': 'Typography',
  'Component Stylings': 'Components',
  'Layout & Spacing': 'Layout',
  'Layout Principles': 'Layout',
  Elevation: 'Elevation & Depth',
  'Depth & Elevation': 'Elevation & Depth',
};

const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

function stringRecord(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(record(v))) {
    if (typeof val === 'string' || typeof val === 'number') out[k] = String(val);
  }
  return out;
}

export function parseDesignMd(text: string): ParsedDesignMd {
  const issues: DesignMdIssue[] = [];
  const src = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(src);
  if (!fm) {
    issues.push({
      rule: 'front-matter',
      severity: 'error',
      message: 'no YAML front matter (--- … ---) found',
    });
    return { doc: null, sections: [], issues };
  }
  const yamlDoc = parseDocument(fm[1] ?? '', { uniqueKeys: true });
  for (const err of yamlDoc.errors) {
    issues.push({
      rule: err.code === 'DUPLICATE_KEY' ? 'duplicate-key' : 'yaml',
      severity: 'error',
      message: err.message.split('\n')[0] ?? err.message,
    });
  }
  const data = record(yamlDoc.toJS());
  const typography: Record<string, DesignMdTypography> = {};
  for (const [k, v] of Object.entries(record(data.typography))) {
    typography[k] = record(v) as DesignMdTypography;
  }
  const components: Record<string, Record<string, string>> = {};
  for (const [k, v] of Object.entries(record(data.components))) components[k] = stringRecord(v);
  const spacing: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(record(data.spacing))) {
    if (typeof v === 'string' || typeof v === 'number') spacing[k] = v;
  }
  const rawSource = record(data.source);
  const source: DesignMdSource | undefined =
    Object.keys(rawSource).length > 0
      ? {
          url: typeof rawSource.url === 'string' ? rawSource.url : undefined,
          pagesAnalyzed:
            typeof rawSource.pagesAnalyzed === 'number' ? rawSource.pagesAnalyzed : undefined,
          extractedAt:
            typeof rawSource.extractedAt === 'string'
              ? rawSource.extractedAt
              : rawSource.extractedAt instanceof Date
                ? rawSource.extractedAt.toISOString().slice(0, 10)
                : undefined,
          tokensMeasured:
            typeof rawSource.tokensMeasured === 'boolean' ? rawSource.tokensMeasured : undefined,
        }
      : undefined;
  const rawThemes = record(data.themes);
  const themes: DesignMdThemes | undefined =
    Object.keys(rawThemes).length > 0
      ? {
          derived: typeof rawThemes.derived === 'string' ? rawThemes.derived : undefined,
          light: rawThemes.light ? stringRecord(rawThemes.light) : undefined,
          dark: rawThemes.dark ? stringRecord(rawThemes.dark) : undefined,
        }
      : undefined;
  const states: Record<string, Record<string, string | number>> | undefined = data.states
    ? Object.fromEntries(Object.entries(record(data.states)).map(([k, v]) => [k, stringRecord(v)]))
    : undefined;

  const doc: DesignMdDoc = {
    version: typeof data.version === 'string' ? data.version : undefined,
    name: typeof data.name === 'string' ? data.name : undefined,
    description: typeof data.description === 'string' ? data.description : undefined,
    ...(source ? { source } : {}),
    colors: stringRecord(data.colors),
    typography,
    rounded: stringRecord(data.rounded),
    spacing,
    ...(data.borderWidths ? { borderWidths: stringRecord(data.borderWidths) } : {}),
    ...(data.shadows ? { shadows: stringRecord(data.shadows) } : {}),
    ...(typeof data.elevationStrategy === 'string'
      ? { elevationStrategy: data.elevationStrategy }
      : {}),
    ...(themes ? { themes } : {}),
    ...(Array.isArray(data.gradients) ? { gradients: data.gradients as DnaGradient[] } : {}),
    components,
    ...(states ? { states } : {}),
    ...(Array.isArray(data.breakpoints)
      ? { breakpoints: data.breakpoints as DnaBreakpoint[] }
      : {}),
    ...(data.coverage && typeof data.coverage === 'object'
      ? { coverage: record(data.coverage) as unknown as DnaCoverage }
      : {}),
  };

  const body = src.slice(fm[0].length);
  const rawHeadings = [...body.matchAll(/^##\s+(.+?)\s*$/gm)].map((m) => (m[1] ?? '').trim());
  const isNumberedDesignMd = rawHeadings.some((h) => /^\d+\.\s+/.test(h));
  const sections = rawHeadings.map((rawH) => {
    const stripped = rawH.replace(/^\d+\.\s+/, '').trim();
    return SECTION_ALIAS[stripped] ?? SECTION_ALIAS[rawH] ?? stripped;
  });
  const seen = new Set<string>();
  for (const s of sections) {
    if (seen.has(s))
      issues.push({
        rule: 'duplicate-section',
        severity: 'error',
        message: `section "${s}" appears twice`,
      });
    seen.add(s);
  }
  const activeOrder = isNumberedDesignMd ? DESIGNMD_SECTION_ORDER : SECTION_ORDER;
  const known = sections.filter((s) => activeOrder.includes(s));
  for (let i = 1; i < known.length; i++) {
    if (activeOrder.indexOf(known[i] as string) < activeOrder.indexOf(known[i - 1] as string)) {
      issues.push({
        rule: 'section-order',
        severity: 'warning',
        message: `"${known[i]}" comes after "${known[i - 1]}"; spec order is ${SECTION_ORDER.join(' → ')}`,
      });
      break;
    }
  }
  return { doc, sections, issues: [...issues, ...lintDesignMd(doc)] };
}

const REF_RE = /^\{([a-z]+)\.([\w-]+)\}$/;

/** A `{group.token}` reference resolved against the doc; plain values pass through. */
export function resolveDesignMdRef(doc: DesignMdDoc, value: string): string | undefined {
  let current = value;
  const visited = new Set<string>();
  while (true) {
    const m = REF_RE.exec(current.trim());
    if (!m) return current;
    const refKey = `${m[1]}.${m[2]}`;
    if (visited.has(refKey)) return undefined;
    visited.add(refKey);
    const groupObj = (doc as unknown as Record<string, unknown>)[m[1] ?? ''];
    const group = record(groupObj);
    const tokenKey = m[2] ?? '';
    if (!Object.hasOwn(group, tokenKey)) return undefined;
    const hit = group[tokenKey];
    if (m[1] === 'typography' && hit && typeof hit === 'object') {
      const t = hit as DesignMdTypography;
      return `${t.fontWeight ?? 400} ${t.fontSize ?? '16px'}/${t.lineHeight ?? 1.5} ${t.fontFamily ?? 'sans-serif'}`;
    }
    if (typeof hit !== 'string' && typeof hit !== 'number') return undefined;
    current = String(hit);
  }
}

/** Token-level checks; parse-level ones (YAML, sections) come from parseDesignMd. */
export function lintDesignMd(doc: DesignMdDoc): DesignMdIssue[] {
  const issues: DesignMdIssue[] = [];
  if (!doc.colors.primary && !Object.keys(doc.colors).some((k) => k.startsWith('primary'))) {
    issues.push({
      rule: 'missing-primary',
      severity: 'warning',
      message: 'no `primary` color defined',
    });
  }
  if (Object.keys(doc.typography).length === 0) {
    issues.push({
      rule: 'missing-typography',
      severity: 'warning',
      message: 'no typography tokens defined',
    });
  }
  for (const [name, color] of Object.entries(doc.colors)) {
    if (classifyTokenValue(color) !== 'color') {
      issues.push({
        rule: 'invalid-color',
        severity: 'error',
        message: `colors.${name} "${color}" is not a CSS color`,
      });
    }
  }
  for (const [name, props] of Object.entries(doc.components)) {
    for (const [prop, value] of Object.entries(props)) {
      if (REF_RE.test(value.trim()) && resolveDesignMdRef(doc, value) === undefined) {
        issues.push({
          rule: 'broken-ref',
          severity: 'error',
          message: `components.${name}.${prop} → ${value} does not exist`,
        });
      }
    }
    const fg = props.textColor ? resolveDesignMdRef(doc, props.textColor) : undefined;
    const bg = props.backgroundColor ? resolveDesignMdRef(doc, props.backgroundColor) : undefined;
    const fgHex = fg ? colorToHex(fg) : null;
    const bgHex = bg ? colorToHex(bg) : null;
    const ratio = fgHex && bgHex ? contrastRatio(fgHex, bgHex) : null;
    if (ratio !== null && ratio < 4.5) {
      issues.push({
        rule: 'contrast-ratio',
        severity: 'warning',
        message: `components.${name}: text on background is ${ratio.toFixed(2)}:1 (WCAG AA needs 4.5:1)`,
      });
    }
  }
  return issues;
}

/**
 * DESIGN.md tokens → Design Studio tokens, for capture/verify. `dark-<role>`
 * colors and `themes.dark` overlay the light set in the dark theme; scales map
 * onto the kebab names materialize and verify already know.
 */
export function designMdToTokens(doc: DesignMdDoc): DesignKitTokens {
  const light: Record<string, string> = {};
  const dark: Record<string, string> = {};
  for (const [name, value] of Object.entries(doc.colors)) {
    if (name.startsWith('dark-')) dark[name.slice(5)] = value;
    else light[name] = value;
  }
  // Map designmd.me semantic aliases (canvas -> bg, ink -> fg, body -> muted) when canonical roles are absent.
  if (!light.bg && light.canvas) light.bg = light.canvas;
  if (!light.fg && light.ink) light.fg = light.ink;
  if (!light.muted && light.body) light.muted = light.body;
  if (doc.themes?.light) {
    const lt = doc.themes.light;
    if (lt.bg && !light.bg) light.bg = lt.bg;
    if (lt.surface && !light.surface) light.surface = lt.surface;
    if (lt.surfaceRaised && !light.raised) light.raised = lt.surfaceRaised;
    if (lt.text && !light.fg) light.fg = lt.text;
    if (lt.textMuted && !light.muted) light.muted = lt.textMuted;
    if (lt.border && !light.border) light.border = lt.border;
    if (lt.accent && !light.primary) light.primary = lt.accent;
    if (lt.accentFg && !light['on-primary']) light['on-primary'] = lt.accentFg;
    if (lt.focusRing && !light.ring) light.ring = lt.focusRing;
  }
  if (doc.themes?.dark) {
    const dt = doc.themes.dark;
    if (dt.bg && !dark.bg) dark.bg = dt.bg;
    if (dt.surface && !dark.surface) dark.surface = dt.surface;
    if (dt.surfaceRaised && !dark.raised) dark.raised = dt.surfaceRaised;
    if (dt.text && !dark.fg) dark.fg = dt.text;
    if (dt.textMuted && !dark.muted) dark.muted = dt.textMuted;
    if (dt.border && !dark.border) dark.border = dt.border;
    if (dt.accent && !dark.primary) dark.primary = dt.accent;
    if (dt.accentFg && !dark['on-primary']) dark['on-primary'] = dt.accentFg;
    if (dt.focusRing && !dark.ring) dark.ring = dt.focusRing;
  }
  for (const [k, v] of Object.entries(doc.rounded)) light[`radius-${k}`] = v;
  for (const [k, v] of Object.entries(doc.spacing)) light[`space-${k}`] = String(v);
  if (doc.shadows) {
    for (const [k, v] of Object.entries(doc.shadows)) {
      if (v) light[`shadow-${k}`] = String(v);
    }
  }
  const families = Object.entries(doc.typography);
  const family = (re: RegExp) => families.find(([k]) => re.test(k))?.[1].fontFamily;
  const sans = family(/^body|^text|^paragraph/) ?? families[0]?.[1].fontFamily;
  const display = family(/^display|^h1|^heading|^headline/);
  const mono = family(/mono|code/);
  if (sans) light['font-sans'] = sans;
  if (display) light['font-display'] = display;
  if (mono) light['font-mono'] = mono;
  const bodyRole = doc.typography['body-md'] ?? doc.typography.body;
  if (bodyRole) {
    if (bodyRole.fontSize && !light['text-base']) light['text-base'] = String(bodyRole.fontSize);
    if (bodyRole.fontWeight !== undefined && !light['weight-normal'])
      light['weight-normal'] = String(bodyRole.fontWeight);
    if (bodyRole.lineHeight !== undefined && !light['leading-normal'])
      light['leading-normal'] = String(bodyRole.lineHeight);
  }
  const smRole = doc.typography['body-sm'] ?? doc.typography.label;
  if (smRole?.fontSize && !light['text-sm']) light['text-sm'] = String(smRole.fontSize);
  const xsRole = doc.typography['caption-md'] ?? doc.typography['caption-sm'];
  if (xsRole?.fontSize && !light['text-xs']) light['text-xs'] = String(xsRole.fontSize);
  const lgRole = doc.typography['body-lg'];
  if (lgRole?.fontSize && !light['text-lg']) light['text-lg'] = String(lgRole.fontSize);
  const hLgRole = doc.typography['heading-lg'];
  if (hLgRole?.fontSize && !light['text-2xl']) light['text-2xl'] = String(hLgRole.fontSize);
  const hXlRole = doc.typography['heading-xl'];
  if (hXlRole?.fontSize && !light['text-3xl']) light['text-3xl'] = String(hXlRole.fontSize);
  const dispRole = doc.typography['display-lg'] ?? doc.typography.display ?? doc.typography.h1;
  if (dispRole) {
    if (dispRole.fontSize && !light['text-5xl']) light['text-5xl'] = String(dispRole.fontSize);
    if (dispRole.fontWeight !== undefined && !light['weight-bold'])
      light['weight-bold'] = String(dispRole.fontWeight);
    if (dispRole.lineHeight !== undefined && !light['leading-tight'])
      light['leading-tight'] = String(dispRole.lineHeight);
  }
  return { light, dark: { ...light, ...dark } };
}

const ROLE_ORDER = ['primary', 'accent', 'bg', 'surface', 'fg', 'muted', 'border', 'ring'];
const RADIUS_KEYS = ['none', 'sm', 'md', 'lg', 'xl', 'full'];
const SPACE_KEYS: Array<[string, string]> = [
  ['space-1', 'xs'],
  ['space-2', 'sm'],
  ['space-3', 'md'],
  ['space-4', 'base'],
  ['space-6', 'lg'],
  ['space-8', 'xl'],
  ['space-12', '2xl'],
];

const withUnit = (v: string): string => (/^0$/.test(v.trim()) ? '0px' : v);
/** Unitless line-height as a number (spec-preferred); a dimension stays a string. */
const lh = (v: string | undefined, fallback: number): number | string => {
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : v;
};

/** Design Studio tokens (or measured DesignDna) → a spec-conformant DESIGN.md. */
export function renderDesignMd(input: {
  name: string;
  description?: string | undefined;
  tokens: DesignKitTokens;
  /** One paragraph for the Overview section (kit aesthetic, brief direction). */
  overview?: string | undefined;
  /** Optional measured DNA to emit the full 10-section designmd.me specification. */
  dna?: DesignDna | undefined;
}): string {
  if (input.dna) {
    return renderDesignMdFromDna(input.dna, {
      name: input.name,
      description: input.description,
    });
  }
  const light = input.tokens.light ?? {};
  const dark = input.tokens.dark ?? {};
  const colors: Record<string, string> = {};
  const colorNames = [
    ...ROLE_ORDER.filter((k) => light[k]),
    ...Object.keys(light).filter((k) => !ROLE_ORDER.includes(k)),
  ].filter((k) => classifyTokenValue(light[k] ?? '') === 'color');
  for (const k of colorNames) colors[k] = light[k] as string;
  for (const k of colorNames) {
    if (dark[k] && dark[k] !== light[k]) colors[`dark-${k}`] = dark[k] as string;
  }
  const rounded: Record<string, string> = {};
  for (const k of RADIUS_KEYS)
    if (light[`radius-${k}`]) rounded[k] = withUnit(light[`radius-${k}`] as string);
  const spacing: Record<string, string> = {};
  for (const [token, key] of SPACE_KEYS)
    if (light[token]) spacing[key] = withUnit(light[token] as string);
  const weight = (k: string, fallback: number) => Number(light[`weight-${k}`] ?? fallback);
  const typography: Record<string, DesignMdTypography> = {};
  const sans = light['font-sans'];
  const display = light['font-display'] ?? sans;
  if (display)
    typography.display = {
      fontFamily: display,
      fontSize: light['text-3xl'] ?? '2rem',
      fontWeight: weight('bold', 700),
      lineHeight: lh(light['leading-tight'], 1.15),
    };
  if (sans) {
    typography['body-md'] = {
      fontFamily: sans,
      fontSize: light['text-base'] ?? '1rem',
      fontWeight: weight('normal', 400),
      lineHeight: lh(light['leading-normal'], 1.5),
    };
    typography.label = {
      fontFamily: sans,
      fontSize: light['text-sm'] ?? '0.875rem',
      fontWeight: weight('medium', 500),
      lineHeight: lh(light['leading-normal'], 1.5),
    };
  }
  if (light['font-mono'])
    typography.mono = { fontFamily: light['font-mono'], fontSize: light['text-sm'] ?? '0.875rem' };
  const components: Record<string, Record<string, string>> = {};
  if (colors.primary) {
    components['button-primary'] = {
      backgroundColor: '{colors.primary}',
      textColor: colors.bg ? '{colors.bg}' : '#ffffff',
      ...(rounded.md ? { rounded: '{rounded.md}' } : {}),
      ...(spacing.md ? { padding: spacing.md } : {}),
    };
  }
  if (colors.surface || colors.bg) {
    components.card = {
      backgroundColor: colors.surface ? '{colors.surface}' : '{colors.bg}',
      ...(colors.fg ? { textColor: '{colors.fg}' } : {}),
      ...(rounded.lg ? { rounded: '{rounded.lg}' } : {}),
      ...(spacing.lg ? { padding: spacing.lg } : {}),
    };
  }
  const front = stringify(
    {
      version: 'alpha',
      name: input.name,
      ...(input.description ? { description: input.description } : {}),
      colors,
      typography,
      rounded,
      spacing,
      components,
    },
    { lineWidth: 0 },
  );
  const list = (r: Record<string, unknown>) =>
    Object.keys(r).length
      ? Object.keys(r)
          .map((k) => `\`${k}\``)
          .join(', ')
      : 'none defined';
  const body = [
    '## Overview',
    input.overview ??
      `${input.name} design system. The tokens above are normative; this text explains how to apply them.`,
    '',
    '## Colors',
    `Roles: ${list(Object.fromEntries(colorNames.map((k) => [k, 1])))}. \`dark-<role>\` entries are the dark-theme values of the same role.`,
    'Spend the chromatic `primary` on the main action; keep large surfaces on `bg`/`surface`.',
    '',
    '## Typography',
    `Styles: ${list(typography)}. Keep one display style per view and body copy at \`body-md\`.`,
    '',
    '## Layout',
    `Spacing scale: ${list(spacing)}. Use scale steps, not arbitrary values.`,
    '',
    '## Shapes',
    `Radius scale: ${list(rounded)}.`,
    '',
    '## Components',
    `Defined: ${list(components)}; other components compose these tokens.`,
    '',
  ].join('\n');
  return `---\n${front}---\n\n${body}`;
}

function upHex(c: string | undefined, fallback: string): string {
  const raw = c ?? fallback;
  return /^#[0-9a-f]{3,8}$/i.test(raw) ? raw.toUpperCase() : raw;
}

function inferBrandName(dna: DesignDna, explicit?: string): string {
  if (explicit?.trim()) return explicit.trim();
  const title = dna.source.title?.split(/[|—–:-]/)[0]?.trim();
  if (title && title.length <= 36) return title;
  try {
    const host = new URL(dna.source.url).hostname.replace(/^www\./, '');
    const base = host.split('.')[0] ?? 'Reference';
    return base.charAt(0).toUpperCase() + base.slice(1);
  } catch {
    return 'Reference';
  }
}

/**
 * Full `designmd.me`-grade DESIGN.md generator from a measured `DesignDna`.
 * Produces the complete YAML front matter (`source`, `colors`, `typography`,
 * `rounded`, `spacing`, `borderWidths`, `shadows`, `elevationStrategy`,
 * `themes`, `gradients`, `components`, `states`, `breakpoints`, `coverage`)
 * and the 10-section architectural prompt guide.
 */
export function renderDesignMdFromDna(
  dna: DesignDna,
  options?: { name?: string | undefined; description?: string | undefined },
): string {
  const brand = inferBrandName(dna, options?.name);
  const rawPalette = dna.color.palette ?? {};
  const roles = dna.color.roles;
  const colors: Record<string, string> = {
    primary: upHex(rawPalette.primary ?? roles.primary, '#533AFD'),
    accent: upHex(rawPalette.accent ?? roles.accent, '#0A2540'),
    link: upHex(rawPalette.link ?? roles.accent ?? roles.primary, '#0000EE'),
    canvas: upHex(rawPalette.canvas ?? roles.bg, dna.theme === 'dark' ? '#0B0B14' : '#F6F9FC'),
    surface: upHex(
      rawPalette.surface ?? roles.surface,
      dna.theme === 'dark' ? '#1A1A22' : '#E5EDF5',
    ),
    ink: upHex(rawPalette.ink ?? roles.fg, dna.theme === 'dark' ? '#F8F7FF' : '#000000'),
    body: upHex(
      rawPalette.body ?? roles.muted ?? roles.fg,
      dna.theme === 'dark' ? '#CBD5E1' : '#3F4B66',
    ),
    muted: upHex(rawPalette.muted ?? roles.muted, dna.theme === 'dark' ? '#9E9DA6' : '#4F5B76'),
    faint: upHex(rawPalette.faint ?? roles.muted, dna.theme === 'dark' ? '#64748B' : '#64748D'),
  };
  for (const [k, v] of Object.entries(rawPalette)) {
    if (/^(accent|neutral)-\d+$/.test(k)) colors[k] = upHex(v, '#808080');
  }

  const baseFont = dna.type.text ?? dna.type.display ?? 'Inter';
  const displayFont = dna.type.display ?? baseFont;
  const typeRoles: Record<string, DnaTypographySpec> =
    dna.type.roles && Object.keys(dna.type.roles).length
      ? dna.type.roles
      : {
          'display-lg': {
            fontFamily: displayFont,
            fontSize: `${dna.type.scale[dna.type.scale.length - 1] ?? 56}px`,
            fontWeight: dna.type.headingWeight ?? 600,
            lineHeight: 1.08,
            letterSpacing: `${dna.type.displayTracking ? Math.round(dna.type.displayTracking * 56 * 100) / 100 : -1.12}px`,
            notes: 'Hero headlines; tight negative tracking for visual impact',
          },
          'body-md': {
            fontFamily: baseFont,
            fontSize: `${dna.type.base?.size ?? 16}px`,
            fontWeight: dna.type.base?.weight ?? 400,
            lineHeight: dna.type.base?.lineHeight ?? 1.5,
            letterSpacing: '0px',
            notes: 'Standard body text, primary reading',
          },
        };

  const typography: Record<string, DesignMdTypography> = {};
  for (const [roleKey, spec] of Object.entries(typeRoles)) {
    const entry: DesignMdTypography = {
      fontFamily: spec.fontFamily,
      fontSize: spec.fontSize,
      fontWeight: spec.fontWeight,
      ...(spec.lineHeight !== undefined ? { lineHeight: spec.lineHeight } : {}),
      ...(spec.letterSpacing !== undefined ? { letterSpacing: spec.letterSpacing } : {}),
      ...(spec.textTransform !== undefined ? { textTransform: spec.textTransform } : {}),
    };
    typography[roleKey] = entry;
  }

  const rScale = dna.shape.radiusScale.filter((r) => r >= 2);
  const xsR = dna.shape.radiusScale.find((r) => r >= 1 && r <= 2) ?? 2;
  const smR = rScale.find((r) => r > xsR) ?? 4;
  const rawMd = typeof dna.shape.radius === 'number' ? dna.shape.radius : (rScale[1] ?? 6);
  const mdR = Math.max(smR + 1, rawMd);
  const lgR = rScale.find((r) => r > mdR) ?? Math.max(mdR + 2, Math.round(mdR * 1.35));
  const xlR = rScale.find((r) => r > lgR) ?? lgR + 2;
  const rounded: Record<string, string> =
    dna.shape.radius === 0
      ? { none: '0px', xs: '0px', sm: '0px', md: '0px', lg: '0px', xl: '0px', full: '9999px' }
      : {
          none: '0px',
          xs: `${xsR}px`,
          sm: `${smR}px`,
          md: `${mdR}px`,
          lg: `${lgR}px`,
          xl: `${xlR}px`,
          full: '9999px',
        };

  const u = dna.space.unit ?? 8;
  const secPad = dna.space.sectionPadY ?? 40;
  const spacing: Record<string, string> = {
    xxs: `${Math.round(u * 0.5)}px`,
    xs: `${u}px`,
    sm: `${Math.round(u * 1.5)}px`,
    md: `${u * 2}px`,
    lg: `${Math.round(u * 2.5)}px`,
    xl: `${u * 3}px`,
    xxl: `${u * 4}px`,
    xxxl: `${Math.round(u * 4.5)}px`,
    section: `${secPad}px`,
    band: `${Math.max(secPad + u, u * 6)}px`,
  };

  const borderWidths: Record<string, string> = {
    thin: `${dna.shape.borderWidth ?? 1}px`,
  };

  const shadowBlur = (s: string): number => {
    const blurs = [...s.matchAll(/(-?\d+(?:\.\d+)?)px\s+(-?\d+(?:\.\d+)?)px\s+(\d+(?:\.\d+)?)px/g)];
    return blurs.reduce((m, b) => Math.max(m, Number(b[3] ?? 0)), 0);
  };
  const sSamples = [...dna.shape.shadowSamples].sort((a, b) => shadowBlur(b) - shadowBlur(a));
  const shadows: Record<string, string> = {
    sm:
      sSamples[0] ??
      'rgba(50, 50, 93, 0.25) 0px 50px 100px -20px, rgba(0, 0, 0, 0.3) 0px 30px 60px -30px',
    md:
      sSamples[1] ??
      'rgba(0, 0, 0, 0.1) 0px 18px 36px -18px, rgba(50, 50, 93, 0.25) 0px 30px 45px -30px',
    lg:
      sSamples[2] ??
      'rgba(50, 50, 93, 0.25) 0px 13px 27px -5px, rgba(0, 0, 0, 0.3) 0px 8px 16px -8px',
    xl:
      sSamples[3] ??
      'rgba(50, 50, 93, 0.25) 0px 6px 12px -2px, rgba(0, 0, 0, 0.3) 0px 3px 7px -3px',
  };

  const elevationStrategy = dna.shape.shadowStyle === 'none' ? 'border+surface' : 'progressive';

  const lightTheme: Record<string, string> =
    dna.theme === 'light'
      ? {
          bg: colors.canvas as string,
          surface: colors.surface as string,
          surfaceRaised: '#DCE4EB',
          text: colors.ink as string,
          textMuted: colors.body as string,
          border: upHex(roles.border, '#D8DBDE'),
          accent: colors.primary as string,
          accentFg: '#FFFFFF',
          focusRing: colors.primary as string,
          elevation: 'shadow',
        }
      : {
          bg: '#F6F9FC',
          surface: '#E5EDF5',
          surfaceRaised: '#DCE4EB',
          text: '#000000',
          textMuted: '#3F4B66',
          border: '#D8DBDE',
          accent: colors.primary as string,
          accentFg: '#FFFFFF',
          focusRing: colors.primary as string,
          elevation: 'shadow',
        };

  const darkTheme: Record<string, string> =
    dna.theme === 'dark'
      ? {
          bg: colors.canvas as string,
          surface: colors.surface as string,
          surfaceRaised: '#26262E',
          text: colors.ink as string,
          textMuted: colors.muted as string,
          border: upHex(roles.border, '#32323A'),
          accent: colors.primary as string,
          accentFg: '#0B0B0C',
          focusRing: colors.primary as string,
          elevation: 'border+surface',
        }
      : {
          bg: '#0B0B14',
          surface: '#1A1A22',
          surfaceRaised: '#26262E',
          text: '#F8F7FF',
          textMuted: '#9E9DA6',
          border: '#32323A',
          accent: colors.primary as string,
          accentFg: '#0B0B0C',
          focusRing: colors.primary as string,
          elevation: 'border+surface',
        };

  const themes: DesignMdThemes = {
    derived: dna.theme === 'light' ? 'dark' : 'light',
    light: lightTheme,
    dark: darkTheme,
  };

  const gradients: DnaGradient[] =
    dna.gradients && dna.gradients.length > 0
      ? dna.gradients.map((g) => ({
          ...g,
          value: g.value.replace(/(?:^none\s*,\s*|\s*,\s*none$)/gi, '').trim(),
        }))
      : dna.color.gradientShare > 0
        ? [
            {
              context: 'hero',
              kind: 'linear',
              value: `linear-gradient(135deg, ${colors.primary}, ${colors.accent})`,
            },
          ]
        : [];

  // Build lint-clean components map with valid references and AA contrast
  const rawCatalog = dna.components.catalog ?? {};
  const components: Record<string, Record<string, string>> = {};
  const tempDoc: DesignMdDoc = { colors, typography, rounded, spacing, components: {} };
  for (const [compName, props] of Object.entries(rawCatalog)) {
    const cleanProps: Record<string, string> = {};
    for (const [k, v] of Object.entries(props)) {
      const strV = String(v);
      if (REF_RE.test(strV) && resolveDesignMdRef(tempDoc, strV) === undefined) continue;
      cleanProps[k] = strV;
    }
    const fg = cleanProps.textColor ? resolveDesignMdRef(tempDoc, cleanProps.textColor) : undefined;
    const bg = cleanProps.backgroundColor
      ? resolveDesignMdRef(tempDoc, cleanProps.backgroundColor)
      : undefined;
    const fgHex = fg ? colorToHex(fg) : null;
    const bgHex = bg ? colorToHex(bg) : null;
    if (fgHex && bgHex && (contrastRatio(fgHex, bgHex) ?? 0) < 4.5) {
      const whiteRatio = contrastRatio('#ffffff', bgHex) ?? 0;
      const blackRatio = contrastRatio('#000000', bgHex) ?? 0;
      cleanProps.textColor = whiteRatio >= blackRatio ? 'rgb(255, 255, 255)' : '{colors.ink}';
    }
    components[compName] = cleanProps;
  }
  if (!components['button-primary']) {
    const primaryHex = colorToHex(colors.primary as string) ?? '#533AFD';
    const whiteContrast = contrastRatio('#ffffff', primaryHex) ?? 0;
    components['button-primary'] = {
      textColor: whiteContrast >= 4.5 ? 'rgb(255, 255, 255)' : '{colors.ink}',
      height: `${dna.components.button?.h ?? 48}px`,
      padding: `14px ${dna.components.button?.padX ?? 24}px`,
      fontSize: `${dna.components.button?.size ?? 16}px`,
      fontFamily: baseFont,
      fontWeight: String(dna.components.button?.weight ?? 500),
      lineHeight: '1',
      rounded: '{rounded.sm}',
      backgroundColor: '{colors.primary}',
    };
  }
  if (!components.card) {
    components.card = {
      textColor: '{colors.ink}',
      fontSize: `${dna.type.base?.size ?? 16}px`,
      fontFamily: baseFont,
      fontWeight: '400',
      rounded: '{rounded.lg}',
      backgroundColor: '{colors.surface}',
    };
  }

  const states: Record<string, DnaStateRule> =
    dna.states && Object.keys(dna.states).length > 0
      ? dna.states
      : {
          'button-hover': { target: 'button', state: 'hover', opacity: 0.85 },
          'nav-hover': { target: 'nav', state: 'hover', opacity: 0.7 },
          'link-focus': { target: 'link', state: 'focus', rounded: '{rounded.sm}' },
          'link-hover': { target: 'link', state: 'hover', opacity: 1 },
        };

  const breakpoints: DnaBreakpoint[] =
    dna.breakpoints && dna.breakpoints.length > 0
      ? dna.breakpoints
      : [
          {
            width: 375,
            containerWidth: 363,
            gridColumns: 1,
            navLinksVisible: 1,
            menuToggleVisible: true,
            headingPx: 34,
            bodyPx: dna.type.base?.size ?? 16,
            sectionPaddingX: 0,
          },
          {
            width: 768,
            containerWidth: 736,
            gridColumns: 2,
            navLinksVisible: 1,
            menuToggleVisible: true,
            headingPx: 44,
            bodyPx: dna.type.base?.size ?? 16,
            sectionPaddingX: 16,
          },
          {
            width: 1440,
            containerWidth: dna.layout[0]?.container || 1248,
            gridColumns: Math.max(1, dna.layout[0]?.maxGridCols || 3),
            navLinksVisible: dna.layout[0]?.nav?.links ?? 4,
            menuToggleVisible: false,
            headingPx: dna.type.scale[dna.type.scale.length - 1] ?? 56,
            bodyPx: dna.type.base?.size ?? 16,
            sectionPaddingX: 16,
          },
        ];

  const coverage: DnaCoverage = dna.coverage ?? {
    statesFound: Object.keys(states).length,
    gradientsFound: gradients.length,
    rolesUnassigned: Object.keys(colors).filter((k) => /^(accent|neutral)-\d+$/.test(k)).length,
    archetypesUnnamed: 0,
    archetypesDetected: Object.keys(components).length,
    responsiveMeasured: breakpoints.length >= 2,
    stylesheetsBlocked: Object.keys(dna.declaredTokens).length === 0,
    semanticRampDeclared: false,
  };

  const btnRadiusRef = components['button-primary']?.rounded ?? '{rounded.sm}';
  const btnRadiusPx = resolveDesignMdRef({ ...tempDoc, components }, btnRadiusRef) ?? rounded.sm;

  const atmosphereDesc =
    options?.description ??
    `${brand}'s design system combines a ${dna.theme}-mode visual foundation (${colors.canvas} canvas, ${colors.surface} surfaces) with a decisive ${colors.primary} brand accent and ${baseFont} typography. ` +
      `The visual personality balances structural restraint with purposeful hierarchy—generous ${spacing.section}–${spacing.band} vertical section rhythm, ${btnRadiusPx}–${rounded.lg} component rounding, and ${elevationStrategy} elevation guide users through content with clarity and high contrast (${colors.ink} headings, ${colors.body} body copy).`;

  const sourceMeta: DesignMdSource = {
    url: dna.source.url,
    pagesAnalyzed: dna.source.pagesAnalyzed ?? 1,
    extractedAt: dna.source.capturedAt.slice(0, 10),
    tokensMeasured: true,
  };

  const frontObj: Record<string, unknown> = {
    version: 'alpha',
    name: brand,
    description: atmosphereDesc,
    source: sourceMeta,
    colors,
    typography,
    rounded,
    spacing,
    borderWidths,
    shadows,
    elevationStrategy,
    themes,
    ...(gradients.length ? { gradients } : {}),
    components,
    states,
    breakpoints,
    coverage,
  };

  const front = stringify(frontObj, { lineWidth: 0 });

  // Build the 10-Section Agent-Ready Markdown Prompt Body
  const accentExtras = Object.entries(colors).filter(([k]) => /^accent-\d+$/.test(k));
  const neutralExtras = Object.entries(colors).filter(([k]) => /^neutral-\d+$/.test(k));
  const largestHeading = dna.type.scale[dna.type.scale.length - 1] ?? 56;
  const mobileBp = breakpoints[0];
  const tabletBp = breakpoints.find((b) => b.width >= 700 && b.width < 1024) ?? breakpoints[0];
  const desktopBp = breakpoints[breakpoints.length - 1];

  const typeRows = Object.entries(typeRoles).map(([roleKey, spec]) => {
    const label = roleKey
      .split('-')
      .map((w) =>
        /^(lg|md|sm|xs|xl)$/.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1),
      )
      .join(' ');
    return `| ${label} | ${spec.fontFamily} | ${spec.fontSize} | ${spec.fontWeight} | ${spec.lineHeight ?? '—'} | ${spec.letterSpacing ?? '0px'} | ${spec.notes ?? 'Measured text role'} |`;
  });

  const componentBlocks = Object.entries(components).map(([name, props]) => {
    const title = name
      .split('-')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
    const propLines = Object.entries(props).map(([k, v]) => `- **${k}:** \`${v}\``);
    return `**${title}** (\`${name}\`)\n${propLines.join('\n')}`;
  });

  const bpRows = breakpoints.map(
    (b) =>
      `| ${b.width}px | ${b.containerWidth}px | ${b.gridColumns} | ${b.navLinksVisible} | ${b.menuToggleVisible ? 'Yes' : 'No'} | ${b.headingPx}px | ${b.bodyPx}px | ${b.sectionPaddingX}px |`,
  );

  const body = [
    `# Design System Inspired by ${brand}`,
    '',
    '## 1. Visual Theme & Atmosphere',
    '',
    atmosphereDesc,
    '',
    '**Key Characteristics**',
    `- Primary brand accent (\`{colors.primary}\` — \`${colors.primary}\`) balanced against ${dna.theme === 'dark' ? 'deep dark' : 'cool neutral'} surfaces (\`{colors.canvas}\` / \`{colors.surface}\`)`,
    `- Typography anchored by **${baseFont}**${displayFont !== baseFont ? ` paired with **${displayFont}** for display headings` : ' across display, heading, and body hierarchies'}`,
    `- Selective component border radii: buttons use \`${btnRadiusRef}\` (${btnRadiusPx}), cards use \`{rounded.lg}\` (${rounded.lg})`,
    `- Disciplined ${u}px spacing rhythm (${Math.round(dna.space.unitFit * 100)}% measured fit) with \`{spacing.section}\` (${spacing.section}) vertical section padding`,
    `- ${dna.shape.shadowStyle === 'none' ? 'Flat border-and-surface separation without heavy drop shadows' : `Progressive ${dna.shape.shadowStyle} shadow elevation on interactive cards and overlays`}`,
    `- Signals detected: ${dna.signals.join(', ') || 'clean structural layout'}`,
    '',
    '## 2. Color Palette & Roles',
    '',
    '### Primary',
    `- **Brand Accent** (\`{colors.primary}\` — \`${colors.primary}\`): Primary CTA fills, active interactive states, and key focal highlights.`,
    `- **Link** (\`{colors.link}\` — \`${colors.link}\`): Inline hyperlinks and interactive navigation text.`,
    '',
    '### Accent Colors',
    `- **Secondary Accent** (\`{colors.accent}\` — \`${colors.accent}\`): Supporting brand colour for hero bands, secondary emphasis, and depth layers.`,
    ...accentExtras.map(
      ([k, v]) =>
        `- **Decorative** (\`{colors.${k}}\` — \`${v}\`): Extracted accent used in gradient compositions or secondary visual highlights.`,
    ),
    '',
    '### Neutral Scale',
    `- **Canvas** (\`{colors.canvas}\` — \`${colors.canvas}\`): Default page background.`,
    `- **Surface** (\`{colors.surface}\` — \`${colors.surface}\`): Card, panel, and elevated container backgrounds.`,
    `- **Ink** (\`{colors.ink}\` — \`${colors.ink}\`): Headings and primary high-contrast text.`,
    `- **Body** (\`{colors.body}\` — \`${colors.body}\`): Standard body copy and primary reading text.`,
    `- **Muted** (\`{colors.muted}\` — \`${colors.muted}\`): Secondary text, captions, and de-emphasized metadata.`,
    `- **Faint** (\`{colors.faint}\` — \`${colors.faint}\`): Tertiary text, placeholders, and subtle supporting labels.`,
    ...(neutralExtras.length
      ? [
          '',
          '### Decorative & Utility',
          ...neutralExtras.map(
            ([k, v]) =>
              `- **Decorative** (\`{colors.${k}}\` — \`${v}\`): Additional neutral tone measured in secondary surfaces.`,
          ),
        ]
      : []),
    '',
    '### Semantic / Status',
    coverage.semanticRampDeclared
      ? 'Semantic status tokens were detected in `:root` custom properties.'
      : 'No explicit error, success, warning, or info status ramp was exposed in the measured public UI.',
    '',
    '## 3. Typography Rules',
    '',
    '### Font Family',
    `**Primary:** ${baseFont}${displayFont !== baseFont ? `  \n**Display:** ${displayFont}` : ''}${dna.type.mono ? `  \n**Monospace:** ${dna.type.mono}` : ''}  `,
    `**Fallback:** system-ui, -apple-system, sans-serif`,
    '',
    '### Hierarchy',
    '',
    '| Role | Font | Size | Weight | Line Height | Letter Spacing | Notes |',
    '|---|---|---|---|---|---|---|',
    ...typeRows,
    '',
    '### Principles',
    `- **Scale Ratio:** Inferred modular scale ratio of **${dna.type.ratio ?? 1.25}** from ${dna.type.base?.size ?? 16}px base body up to ${largestHeading}px display.`,
    `- **Display Tracking:** Display headlines use \`${dna.type.displayTracking ?? -0.02}em\` letter-spacing for compact visual authority.`,
    `- **Weight Hierarchy:** Body copy sits at \`${dna.type.base?.weight ?? 400}\`, headings emphasize at \`${dna.type.headingWeight ?? 600}\`.`,
    '',
    '## 4. Component Stylings',
    '',
    ...componentBlocks.join('\n\n').split('\n'),
    '',
    '## 5. Layout Principles',
    '',
    '### Spacing System',
    `The system uses a **${u}px** base unit (${Math.round(dna.space.unitFit * 100)}% fit across measured paddings, gaps, and margins):`,
    `- \`{spacing.xxs}\` (${spacing.xxs}): Micro spacing, tight inline gaps`,
    `- \`{spacing.xs}\` (${spacing.xs}): Compact component-internal spacing`,
    `- \`{spacing.sm}\` (${spacing.sm}): Compact padding and list gaps`,
    `- \`{spacing.md}\` (${spacing.md}): Default body margin and standard gutter`,
    `- \`{spacing.lg}\` (${spacing.lg}): Card-to-card and component spacing`,
    `- \`{spacing.xl}\` (${spacing.xl}): Section internal dividers`,
    `- \`{spacing.xxl}\` (${spacing.xxl}): Major container gutters`,
    `- \`{spacing.section}\` (${spacing.section}): Standard vertical section padding`,
    `- \`{spacing.band}\` (${spacing.band}): Hero and full-width band vertical padding`,
    '',
    '### Grid & Container',
    `- **Max Width:** ${desktopBp?.containerWidth ?? 1248}px at ${desktopBp?.width ?? 1440}px viewport`,
    `- **Column Strategy:** Up to ${desktopBp?.gridColumns ?? 3}-column layout grid on desktop, collapsing on narrow viewports`,
    `- **Horizontal Gutters:** \`{spacing.md}\` (${spacing.md}) standard horizontal padding`,
    '',
    '### Whitespace Philosophy',
    'Generous negative space separates content groups. Sections breathe with consistent vertical padding and constrained reading widths so complex information never feels cramped.',
    '',
    '### Border Radius Scale',
    `- \`{rounded.none}\` (${rounded.none}): Full-bleed sections and sharp dividers`,
    `- \`{rounded.xs}\` (${rounded.xs}): Micro badges and subtle focus rings`,
    `- \`{rounded.sm}\` (${rounded.sm}): Interactive buttons and inputs`,
    `- \`{rounded.md}\` (${rounded.md}): Standard UI controls`,
    `- \`{rounded.lg}\` (${rounded.lg}): Cards, panels, and containers`,
    `- \`{rounded.xl}\` (${rounded.xl}): Modals, dropdowns, and elevated surfaces`,
    `- \`{rounded.full}\` (${rounded.full}): Pill tags and circular avatars`,
    '',
    '### Border Widths',
    `- \`thin\` (${borderWidths.thin}): Crisp hairline borders for subtle container and outline button definition.`,
    '',
    '## 6. Depth & Elevation',
    '',
    '| Level | Treatment | Use |',
    '|---|---|---|',
    '| Flat | None | Default canvas, baseline sections, and flat cards |',
    `| Subtle (XL) | \`${shadows.xl}\` | Subtle interactive lift |`,
    `| Medium (LG) | \`${shadows.lg}\` | Hovered cards and contained panels |`,
    `| Elevated (MD) | \`${shadows.md}\` | Dropdowns and floating menus |`,
    `| Strong (SM) | \`${shadows.sm}\` | Modals, dialogs, and high-priority overlays |`,
    '',
    '**Shadow Philosophy:**',
    `Elevation strategy is **${elevationStrategy}** (${dna.shape.shadowStyle} shadow profile). Default surfaces rely on \`{colors.canvas}\` vs \`{colors.surface}\` layering, reserving multi-layered shadows for hover states and floating chrome.`,
    '',
    "## 7. Do's and Don'ts",
    '',
    '### Do',
    `- **Use \`{colors.primary}\` (\`${colors.primary}\`) for primary CTAs** with \`${btnRadiusRef}\` (${btnRadiusPx}) corners and \`{spacing.md}\`–\`{spacing.lg}\` padding.`,
    `- **Maintain the ${baseFont} typographic hierarchy**, scaling from ${dna.type.base?.size ?? 16}px body text to ${largestHeading}px display headlines.`,
    `- **Keep large page backgrounds on \`{colors.canvas}\` (\`${colors.canvas}\`)** and group related content inside \`{colors.surface}\` (\`${colors.surface}\`) cards.`,
    `- **Use \`{colors.ink}\` (\`${colors.ink}\`) for headings and \`{colors.body}\` (\`${colors.body}\`) for body copy** to preserve hierarchy and reading comfort.`,
    `- **Respect the ${u}px spacing grid** (\`{spacing.xs}\` through \`{spacing.band}\`) for all paddings, gaps, and section rhythm.`,
    '',
    "### Don't",
    `- **Don't apply primary brand fills (\`{colors.primary}\`) to large background areas**; chromatic share is ${Math.round(dna.color.chromaticShare * 100)}% of the viewport.`,
    `- **Don't mix arbitrary border radii**; keep buttons at \`${btnRadiusRef}\` (${btnRadiusPx}) and cards at \`{rounded.lg}\` (${rounded.lg}).`,
    `- **Don't use pure \`{colors.ink}\` for secondary metadata**; use \`{colors.muted}\` (\`${colors.muted}\`) or \`{colors.faint}\` (\`${colors.faint}\`).`,
    `- **Don't skip responsive heading reductions** below 768px (scale display text from ${desktopBp?.headingPx ?? largestHeading}px down to ${mobileBp?.headingPx ?? 34}px).`,
    '',
    '## 8. Responsive Behavior',
    '',
    '### Breakpoints',
    '',
    '| Viewport | Content Column | Grid Columns | Visible Nav Links | Menu Toggle | Largest Heading | Body Text | Section Padding-X |',
    '|---|---|---|---|---|---|---|---|',
    ...bpRows,
    '',
    '**Effective Breakpoints:**',
    `- **Mobile (< 768px):** Content column ${mobileBp?.containerWidth ?? 363}px, ${mobileBp?.headingPx ?? 34}px display heading, mobile menu toggle active.`,
    `- **Tablet (768px–1023px):** Content column widens to ${tabletBp?.containerWidth ?? 736}px, heading scales to ${tabletBp?.headingPx ?? 48}px.`,
    `- **Desktop (1024px+):** Full navigation visible, ${desktopBp?.headingPx ?? largestHeading}px display headline, max container ${desktopBp?.containerWidth ?? 1248}px.`,
    '',
    '### Touch Targets',
    `- **Minimum Button Height:** ${dna.components.button?.h ?? 40}px for primary interactive controls.`,
    `- **Navigation Hit Area:** \`{spacing.md}\` (${spacing.md}) spacing around interactive links.`,
    '',
    '### Collapsing Strategy',
    `- **Headings:** ${desktopBp?.headingPx ?? largestHeading}px → ${tabletBp?.headingPx ?? 48}px → ${mobileBp?.headingPx ?? 34}px across desktop, tablet, and mobile viewports.`,
    `- **Grids:** Multi-column desktop grids (${desktopBp?.gridColumns ?? 3} cols) collapse to ${mobileBp?.gridColumns ?? 1} column on mobile.`,
    '',
    '## 9. Agent Prompt Guide',
    '',
    '### Quick Color Reference',
    `- **Primary CTA:** Brand Accent (\`{colors.primary}\` — \`${colors.primary}\`)`,
    `- **Secondary Accent:** Accent (\`{colors.accent}\` — \`${colors.accent}\`)`,
    `- **Background (Page):** Canvas (\`{colors.canvas}\` — \`${colors.canvas}\`)`,
    `- **Background (Card):** Surface (\`{colors.surface}\` — \`${colors.surface}\`)`,
    `- **Heading Text:** Ink (\`{colors.ink}\` — \`${colors.ink}\`)`,
    `- **Body Text:** Body (\`{colors.body}\` — \`${colors.body}\`)`,
    `- **Secondary Text:** Muted (\`{colors.muted}\` — \`${colors.muted}\`)`,
    `- **Tertiary / Placeholder:** Faint (\`{colors.faint}\` — \`${colors.faint}\`)`,
    `- **Inline Links:** Link (\`{colors.link}\` — \`${colors.link}\`)`,
    '',
    '### Iteration Guide',
    `1. **All primary CTAs use \`{colors.primary}\` (\`${colors.primary}\`) fill, high-contrast text, \`${btnRadiusRef}\` (${btnRadiusPx}) corners, and \`{spacing.md}\`–\`{spacing.lg}\` padding.**`,
    `2. **Typography uses ${baseFont}; scale weight and size per the hierarchy table rather than introducing unmeasured fonts.**`,
    `3. **Cards and containers default to \`{colors.surface}\` (\`${colors.surface}\`) with \`{rounded.lg}\` (${rounded.lg}) radius.**`,
    `4. **Spacing follows the ${u}px scale:** \`{spacing.xs}\` (${spacing.xs}) for tight gaps, \`{spacing.md}\` (${spacing.md}) for standard padding, \`{spacing.section}\` (${spacing.section}) for vertical section breaks.`,
    `5. **Border-radius is component-specific:** buttons \`${btnRadiusRef}\` (${btnRadiusPx}), cards \`{rounded.lg}\` (${rounded.lg}), modals \`{rounded.xl}\` (${rounded.xl}).`,
    `6. **Navigation uses \`{colors.ink}\` text at ${dna.layout[0]?.nav?.h ?? 64}px height** and collapses behind a menu toggle below 768px.`,
    `7. **Responsive layout:** below 768px use single-column flow and ${mobileBp?.headingPx ?? 34}px display headings; at 1024px+ expand to ${desktopBp?.containerWidth ?? 1248}px container and ${desktopBp?.headingPx ?? largestHeading}px display headings.`,
    `8. **Motion & transitions:** use ${dna.motion.duration ?? 200}ms with \`${dna.motion.easing ?? 'ease-out'}\` timing for hover opacity and elevation shifts.`,
    `9. **Theme support:** measured palette is **${dna.theme}**; use \`themes.${themes.derived}\` tokens when rendering the derived ${themes.derived} mode.`,
    `10. **Maintain WCAG AA contrast (≥ 4.5:1)** on all text/surface pairs (\`{colors.ink}\` and \`{colors.body}\` on \`{colors.canvas}\` and \`{colors.surface}\`).`,
    '',
    '## 10. Known Gaps',
    '',
    ...(coverage.stylesheetsBlocked
      ? [
          '- **Some stylesheets were cross-origin or blocked by CORS,** so CSS `:hover`/`:focus` selectors and `:root` custom properties inside external stylesheets could not be read directly.',
        ]
      : []),
    ...(!coverage.semanticRampDeclared
      ? [
          '- **No semantic status palette (error, success, warning, info) was exposed** in the measured public views.',
        ]
      : []),
    ...(coverage.rolesUnassigned > 0
      ? [
          `- **${coverage.rolesUnassigned} extracted colours have no direct semantic UI role** and are cataloged as decorative (\`accent-*\` / \`neutral-*\`).`,
        ]
      : []),
    `- **Derived ${themes.derived} theme:** The ${dna.theme} theme was measured directly; the ${themes.derived} theme in \`themes.${themes.derived}\` is perceptually derived.`,
    '- **Authenticated surfaces** (dashboards, account settings, checkout flows behind login) were not visited during public URL extraction.',
    ...dna.notes.map((n) => `- ${n}`),
    '',
  ].join('\n');

  return `---\n${front}---\n\n${body}`;
}
