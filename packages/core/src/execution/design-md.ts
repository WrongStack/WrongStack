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

export interface DesignMdTypography {
  fontFamily?: string | undefined;
  fontSize?: string | undefined;
  fontWeight?: number | string | undefined;
  lineHeight?: string | number | undefined;
  letterSpacing?: string | undefined;
}

export interface DesignMdDoc {
  version?: string | undefined;
  name?: string | undefined;
  description?: string | undefined;
  colors: Record<string, string>;
  typography: Record<string, DesignMdTypography>;
  rounded: Record<string, string>;
  spacing: Record<string, string | number>;
  components: Record<string, Record<string, string>>;
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
const SECTION_ALIAS: Record<string, string> = {
  'Brand & Style': 'Overview',
  'Layout & Spacing': 'Layout',
  Elevation: 'Elevation & Depth',
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
  const doc: DesignMdDoc = {
    version: typeof data.version === 'string' ? data.version : undefined,
    name: typeof data.name === 'string' ? data.name : undefined,
    description: typeof data.description === 'string' ? data.description : undefined,
    colors: stringRecord(data.colors),
    typography,
    rounded: stringRecord(data.rounded),
    spacing,
    components,
  };

  const body = src.slice(fm[0].length);
  const sections = [...body.matchAll(/^##\s+(.+?)\s*$/gm)].map((m) => {
    const h = (m[1] ?? '').trim();
    return SECTION_ALIAS[h] ?? h;
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
  const known = sections.filter((s) => SECTION_ORDER.includes(s));
  for (let i = 1; i < known.length; i++) {
    if (SECTION_ORDER.indexOf(known[i] as string) < SECTION_ORDER.indexOf(known[i - 1] as string)) {
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
  const m = REF_RE.exec(value.trim());
  if (!m) return value;
  const group = record((doc as unknown as Record<string, unknown>)[m[1] ?? '']);
  const hit = group[m[2] ?? ''];
  return typeof hit === 'string' || typeof hit === 'number' ? String(hit) : undefined;
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
 * colors overlay the light set in the dark theme; scales map onto the kebab
 * names materialize and verify already know.
 */
export function designMdToTokens(doc: DesignMdDoc): DesignKitTokens {
  const light: Record<string, string> = {};
  const dark: Record<string, string> = {};
  for (const [name, value] of Object.entries(doc.colors)) {
    if (name.startsWith('dark-')) dark[name.slice(5)] = value;
    else light[name] = value;
  }
  for (const [k, v] of Object.entries(doc.rounded)) light[`radius-${k}`] = v;
  for (const [k, v] of Object.entries(doc.spacing)) light[`space-${k}`] = String(v);
  const families = Object.entries(doc.typography);
  const family = (re: RegExp) => families.find(([k]) => re.test(k))?.[1].fontFamily;
  const sans = family(/^body|^text|^paragraph/) ?? families[0]?.[1].fontFamily;
  const display = family(/^display|^h1|^heading|^headline/);
  const mono = family(/mono|code/);
  if (sans) light['font-sans'] = sans;
  if (display) light['font-display'] = display;
  if (mono) light['font-mono'] = mono;
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

/** Design Studio tokens → a spec-conformant DESIGN.md. */
export function renderDesignMd(input: {
  name: string;
  description?: string | undefined;
  tokens: DesignKitTokens;
  /** One paragraph for the Overview section (kit aesthetic, brief direction). */
  overview?: string | undefined;
}): string {
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
