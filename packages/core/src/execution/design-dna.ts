/**
 * Design DNA — node-side summary of what `DESIGN_DNA_EXTRACTOR` measured.
 *
 * The extractor returns counts and pixels per viewport; this module turns
 * them into decisions a model can apply without having to "see" the page:
 * color roles, the type scale and its ratio, the spacing unit, radius and
 * elevation style, motion timing, section rhythm and layout signals.
 *
 * Every function here is pure so the inference is testable and identical for
 * every model. Inferred values (roles, ratio, unit, signals) are kept apart
 * from the measured ones and each inference states the evidence it used —
 * `notes` records what the measurement could not see.
 */

import { deltaE, hexChroma, hexContrast, hexToOklab, type OkLab } from './design-dna-color.js';

export * from './design-dna-color.js';

/** `[key, weight]` pairs, heaviest first — the extractor's map encoding. */
export type DnaCounts = Array<[string, number]>;

export interface DnaButton {
  h: number;
  w: number;
  padX: number;
  pad?: string | undefined;
  r: number | 'full';
  bg: string | null;
  fg: string | null;
  border: string | null;
  bw?: number | undefined;
  fw: string;
  fs: number;
  lh?: number | undefined;
  ff?: string | undefined;
  tt: string;
  iconOnly?: boolean | undefined;
  y: number;
}

export interface DnaCard {
  h: number;
  w: number;
  pad?: string | undefined;
  r: number | 'full';
  bg: string | null;
  fg: string | null;
  border: string | null;
  bw?: number | undefined;
  shadow?: string | null | undefined;
  fw: string;
  fs: number;
  ff?: string | undefined;
}

export interface DnaLink {
  h: number;
  w: number;
  pad?: string | undefined;
  r: number | 'full';
  bg: string | null;
  fg: string | null;
  border: string | null;
  bw?: number | undefined;
  fw: string;
  fs: number;
  lh?: number | undefined;
  ff?: string | undefined;
}

export interface DnaBadge {
  h: number;
  w: number;
  pad?: string | undefined;
  r: number | 'full';
  bg: string | null;
  fg: string | null;
  border: string | null;
  bw?: number | undefined;
  fw: string;
  fs: number;
  lh?: number | undefined;
  ff?: string | undefined;
}

export interface DnaFooter {
  h: number;
  w: number;
  bg: string | null;
  fg: string | null;
  pad?: string | undefined;
  fs: number;
  ff?: string | undefined;
  fw: string;
}

export interface DnaGradient {
  context: 'hero' | 'section' | 'surface';
  kind: 'radial' | 'linear' | 'conic';
  value: string;
}

export interface DnaStateRule {
  target: string;
  state: string;
  backgroundColor?: string | undefined;
  textColor?: string | undefined;
  opacity?: number | string | undefined;
  transform?: string | undefined;
  boxShadow?: string | undefined;
  outline?: string | undefined;
  rounded?: string | undefined;
}

export interface DnaBreakpoint {
  width: number;
  containerWidth: number;
  gridColumns: number;
  navLinksVisible: number;
  menuToggleVisible: boolean;
  headingPx: number;
  bodyPx: number;
  sectionPaddingX: number;
}

export interface DnaCoverage {
  statesFound: number;
  gradientsFound: number;
  rolesUnassigned: number;
  archetypesUnnamed: number;
  archetypesDetected: number;
  responsiveMeasured: boolean;
  stylesheetsBlocked: boolean;
  semanticRampDeclared: boolean;
}

export interface DnaTypographySpec {
  fontFamily: string;
  fontSize: string;
  fontWeight: number;
  lineHeight?: number | undefined;
  letterSpacing?: string | undefined;
  textTransform?: string | undefined;
  notes?: string | undefined;
}

export interface DnaSection {
  tag: string;
  y: number;
  h: number;
  bg: string | null;
  padY: [number, number];
  padX?: [number, number] | undefined;
  cols: number;
  media: 'left' | 'right' | 'center' | 'full' | null;
  container: number;
  align: string | null;
  sticky: boolean;
}

/** One viewport's raw measurement, exactly as the in-page script returns it. */
export interface DesignDnaRaw {
  v: 1;
  url: string;
  title: string;
  vw: number;
  vh: number;
  docH: number;
  screens: number;
  rootBg: string | null;
  colorScheme: string;
  themeColor: string | null;
  generator: string | null;
  samples: { points: number; media: number; gradient: number; area: DnaCounts };
  text: DnaCounts;
  textColor: DnaCounts;
  families: DnaCounts;
  fontsLoaded: string[];
  padding: DnaCounts;
  gap: DnaCounts;
  vmargin: DnaCounts;
  radius: DnaCounts;
  shadow: DnaCounts;
  borderW: DnaCounts;
  borderColor: DnaCounts;
  duration: DnaCounts;
  easing: DnaCounts;
  gradients: DnaCounts;
  fullGradients?: DnaGradient[] | undefined;
  effects: Record<string, number>;
  /** `[columns, columnGap, children, width, top]`. */
  grids: number[][];
  buttons: DnaButton[];
  cards?: DnaCard[] | undefined;
  links?: DnaLink[] | undefined;
  badges?: DnaBadge[] | undefined;
  inputs: Array<{
    h: number;
    r: number;
    bg: string | null;
    border: string | null;
    bw: number;
    fs: number;
  }>;
  nav: {
    h: number;
    w?: number | undefined;
    pos: string;
    bg: string | null;
    fg?: string | null | undefined;
    pad?: string | undefined;
    r?: number | undefined;
    fs?: number | undefined;
    ff?: string | undefined;
    fw?: string | undefined;
    backdrop: boolean;
    links: number;
    linksVis?: number | undefined;
    menuToggle?: boolean | undefined;
    buttons: number;
  } | null;
  footer?: DnaFooter | null | undefined;
  sections: DnaSection[];
  states?: Record<string, DnaStateRule> | undefined;
  statesFound?: number | undefined;
  sheetsBlocked?: number | undefined;
  internalLinks?: string[] | undefined;
  images: number;
  imgRatios: DnaCounts;
  icons: DnaCounts;
  vars: Record<string, string>;
  elements: number;
  /** Characters inside footer/contentinfo, excluded from `text`/`textColor`. */
  footerChars?: number | undefined;
}

export interface DnaColorRoles {
  bg?: string | undefined;
  surface?: string | undefined;
  fg?: string | undefined;
  muted?: string | undefined;
  primary?: string | undefined;
  accent?: string | undefined;
  border?: string | undefined;
}

export interface DnaLayout {
  width: number;
  /** Most common centered content width (border box), 0 when none was centered. */
  container: number;
  sections: Array<Pick<DnaSection, 'y' | 'h' | 'cols' | 'media' | 'align' | 'bg'>>;
  /** Widest multi-column grid per viewport — reflow evidence. */
  maxGridCols: number;
  nav: DesignDnaRaw['nav'];
  docHeight: number;
}

/** The summarized, model-facing design DNA of one page (or multi-page site). */
export interface DesignDna {
  version: 1;
  source: {
    url: string;
    title: string;
    capturedAt: string;
    viewports: number[];
    pagesAnalyzed?: number | undefined;
  };
  theme: 'light' | 'dark';
  color: {
    roles: DnaColorRoles;
    /** Extended designmd.me palette (primary, accent, link, canvas, surface, ink, body, muted, faint, accent-1..5, neutral-1..2). */
    palette?: Record<string, string> | undefined;
    /** Visible-area palette of the widest viewport: share of sampled points. */
    area: Array<{ hex: string; share: number }>;
    text: Array<{ hex: string; share: number }>;
    mediaShare: number;
    gradientShare: number;
    /** Share of visible area whose color is chromatic (OKLCH C ≥ 0.06). */
    chromaticShare: number;
  };
  type: {
    text?: string | undefined;
    display?: string | undefined;
    mono?: string | undefined;
    loaded: string[];
    base: { size: number; weight: number; lineHeight: number } | null;
    /** Sizes carrying real text, ascending (px). */
    scale: number[];
    /** Geometric mean step between sizes above the base; null with < 2 steps. */
    ratio: number | null;
    headingWeight: number | null;
    /** Letter-spacing of the largest sizes in em (negative = tightened display). */
    displayTracking: number | null;
    uppercaseShare: number;
    /** Rich named typographic role hierarchy (display-lg, heading-xl..xs, body-lg..sm, nav, button-*, caption-*, label). */
    roles?: Record<string, DnaTypographySpec> | undefined;
  };
  space: {
    unit: number | null;
    /** Weighted share of spacing values that are multiples of `unit`. */
    unitFit: number;
    scale: number[];
    sectionPadY: number | null;
  };
  shape: {
    radius: number | 'full' | null;
    radiusScale: number[];
    pillShare: number;
    shadowStyle: 'none' | 'soft' | 'hard' | 'ring' | 'mixed';
    shadowSamples: string[];
    borderWidth: number | null;
  };
  motion: { duration: number | null; durations: number[]; easing: string | null; animated: number };
  components: {
    button: {
      h: number;
      padX: number;
      radius: number | 'full';
      weight: number;
      size: number;
      transform: string;
    } | null;
    input: { h: number; radius: number; borderWidth: number } | null;
    /** Full measured component catalog (button-*, card, card-lg, navigation, footer, link, badge-*). */
    catalog?: Record<string, Record<string, string | number>> | undefined;
  };
  gradients?: DnaGradient[] | undefined;
  states?: Record<string, DnaStateRule> | undefined;
  breakpoints?: DnaBreakpoint[] | undefined;
  coverage?: DnaCoverage | undefined;
  layout: DnaLayout[];
  effects: Record<string, number>;
  declaredTokens: Record<string, string>;
  signals: string[];
  notes: string[];
}

// ── small helpers ────────────────────────────────────────────────────────────

const solid = (key: string): string => key.split('/')[0] ?? key;
const isOpaque = (key: string | null): key is string => !!key && !key.includes('/');

function total(counts: DnaCounts): number {
  return counts.reduce((sum, [, n]) => sum + n, 0);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

function mode<T>(values: T[]): T | undefined {
  const seen = new Map<T, number>();
  for (const v of values) seen.set(v, (seen.get(v) ?? 0) + 1);
  let best: T | undefined;
  let n = 0;
  for (const [v, c] of seen) if (c > n) [best, n] = [v, c];
  return best;
}

/** Round to `step` without float residue (1.4000000000000001). */
const round = (n: number, step = 0.01): number =>
  Number((Math.round(n / step) * step).toFixed(Math.max(0, -Math.floor(Math.log10(step)))));
const MONO_RE = /mono|code|courier|consol|menlo|monaco/i;
const GENERIC_FONT =
  /^(serif|sans-serif|monospace|system-ui|ui-[a-z-]+|-apple-system|blinkmacsystemfont|cursive|fantasy)$/i;

interface TextRun {
  size: number;
  weight: number;
  lineHeight: number;
  tracking: number;
  family: string;
  transform: string;
  tag: string;
  chars: number;
}

function parseText(raw: DesignDnaRaw): TextRun[] {
  return raw.text.map(([key, chars]) => {
    const [size, weight, lh, ls, family, transform, tag] = key.split('|');
    return {
      size: Number(size),
      weight: Number(weight),
      lineHeight: Number(lh),
      tracking: Number(ls),
      family: family ?? '',
      transform: transform ?? '',
      tag: tag ?? '',
      chars,
    };
  });
}

// ── inference ────────────────────────────────────────────────────────────────

function inferColor(
  raw: DesignDnaRaw,
  buttons: DnaButton[],
): DesignDna['color'] & { theme: DesignDna['theme'] } {
  const points = Math.max(1, raw.samples.points);
  const area = raw.samples.area.map(([hex, n]) => ({ hex, share: round(n / points, 0.001) }));
  const textTotal = Math.max(1, total(raw.textColor));
  const text = raw.textColor.map(([hex, n]) => ({ hex, share: round(n / textTotal, 0.001) }));
  const roles: DnaColorRoles = {};

  // The page's own background wins while it still covers a fair share: a
  // half-page inverted band must not flip the whole theme (and with it fg).
  const rootShare = area.find((c) => c.hex === raw.rootBg)?.share ?? 0;
  roles.bg = isOpaque(raw.rootBg) && rootShare >= 0.2 ? raw.rootBg : (area[0]?.hex ?? undefined);
  const bg = roles.bg ?? '#ffffff';
  const theme: DesignDna['theme'] = (hexToOklab(bg)?.L ?? 1) < 0.5 ? 'dark' : 'light';
  roles.surface = area.find(
    (c) => c.hex !== bg && c.share >= 0.02 && deltaE(c.hex, bg) < 0.12,
  )?.hex;

  const readable = text
    .map((t) => ({ ...t, hex: solid(t.hex), contrast: hexContrast(solid(t.hex), bg) }))
    .filter((t) => t.contrast >= 2.2);
  // Body text and secondary text often carry near-equal character counts;
  // among the heavily used readable colors the strongest contrast is the fg.
  const strong = readable.filter((t) => t.contrast >= 4.5);
  const heaviest = Math.max(0, ...strong.map((t) => t.share));
  const fg = strong
    .filter((t) => t.share >= heaviest * 0.6)
    .sort((x, y) => y.contrast - x.contrast)[0];
  roles.fg = fg?.hex;
  roles.muted = readable.find(
    (t) => t.hex !== roles.fg && t.contrast < (fg?.contrast ?? 21) && hexChroma(t.hex) < 0.06,
  )?.hex;

  // Filled buttons set primary (chromatic first, then achromatic black/white);
  // colored links or area swatches then supply the chromatic accent.
  const filled = buttons
    .map((b) => b.bg)
    .filter((c): c is string => isOpaque(c) && deltaE(c, bg) > 0.08);
  const chromaticFilled = filled.filter((c) => hexChroma(c) >= 0.06);
  roles.primary =
    mode(chromaticFilled) ??
    mode(filled) ??
    readable.find((t) => hexChroma(t.hex) >= 0.08)?.hex ??
    area.find((c) => hexChroma(c.hex) >= 0.08 && c.share >= 0.002)?.hex;
  const primaryLab =
    roles.primary && hexChroma(roles.primary) >= 0.06 ? hexToOklab(roles.primary) : null;
  const hue = (lab: OkLab | null): number => (lab ? (Math.atan2(lab.b, lab.a) * 180) / Math.PI : 0);
  roles.accent = [...area.map((c) => c.hex), ...readable.map((t) => t.hex)].find((hex) => {
    if (hex === roles.primary || hexChroma(hex) < 0.08) return false;
    const diff = primaryLab ? Math.abs(hue(hexToOklab(hex)) - hue(primaryLab)) : 180;
    return Math.min(diff, 360 - diff) > 30;
  });
  const border = raw.borderColor.find(
    ([hex]) => deltaE(solid(hex), bg) > 0.02 && deltaE(solid(hex), bg) < 0.35,
  );
  roles.border = border ? solid(border[0]) : undefined;

  const chromaticShare = area
    .filter((c) => hexChroma(c.hex) >= 0.06)
    .reduce((s, c) => s + c.share, 0);
  return {
    theme,
    roles,
    area: area.slice(0, 12),
    text: text.slice(0, 8),
    mediaShare: round(raw.samples.media / points, 0.001),
    gradientShare: round(raw.samples.gradient / points, 0.001),
    chromaticShare: round(chromaticShare, 0.001),
  };
}

function inferType(raw: DesignDnaRaw): DesignDna['type'] {
  const runs = parseText(raw);
  const chars = Math.max(
    1,
    runs.reduce((s, r) => s + r.chars, 0),
  );
  const families = raw.families.map(([f]) => f).filter((f) => f && !GENERIC_FONT.test(f));
  const textFamily = families.find((f) => !MONO_RE.test(f)) ?? families[0];
  const mono = families.find((f) => MONO_RE.test(f));
  const body = runs
    .filter((r) => !/^h[1-6]$/.test(r.tag) && r.size >= 11)
    .sort((x, y) => y.chars - x.chars)[0];

  const bySize = new Map<number, number>();
  for (const r of runs) bySize.set(r.size, (bySize.get(r.size) ?? 0) + r.chars);
  const headingSizes = new Set(runs.filter((r) => /^h[1-3]$/.test(r.tag)).map((r) => r.size));
  const scale = [...bySize]
    .filter(([size, n]) => n / chars >= 0.015 || headingSizes.has(size))
    .map(([size]) => size)
    .sort((x, y) => x - y);

  let ratio: number | null = null;
  if (body) {
    const above = scale.filter((s) => s > body.size * 1.04);
    if (above.length >= 2) {
      const steps = [body.size, ...above];
      let logSum = 0;
      for (let i = 1; i < steps.length; i++)
        logSum += Math.log((steps[i] as number) / (steps[i - 1] as number));
      ratio = round(Math.exp(logSum / (steps.length - 1)), 0.001);
    }
  }
  const largest = [...runs].sort((x, y) => y.size - x.size).slice(0, 3);
  const display = largest[0]?.family;
  const tracking = largest.length
    ? largest.reduce((s, r) => s + r.tracking / r.size, 0) / largest.length
    : null;
  const headingWeight =
    mode(runs.filter((r) => /^h[1-3]$/.test(r.tag)).map((r) => r.weight)) ?? null;
  const upper = runs.filter((r) => r.transform === 'uppercase').reduce((s, r) => s + r.chars, 0);
  return {
    text: textFamily,
    display:
      display && display !== textFamily && !GENERIC_FONT.test(display) ? display : textFamily,
    mono,
    loaded: raw.fontsLoaded,
    base: body
      ? {
          size: body.size,
          weight: body.weight,
          lineHeight: round(body.lineHeight / body.size, 0.01),
        }
      : null,
    scale,
    ratio,
    headingWeight,
    displayTracking: tracking === null ? null : round(tracking, 0.001),
    uppercaseShare: round(upper / chars, 0.001),
  };
}

const UNIT_CANDIDATES = [8, 6, 5, 4];

/** The largest unit most spacing values are multiples of, with its fit share. */
function inferSpacingUnit(values: DnaCounts): { unit: number | null; fit: number } {
  const usable = values.map(([v, n]) => [Number(v), n] as const).filter(([v]) => v >= 3);
  const weight = usable.reduce((s, [, n]) => s + n, 0);
  if (weight === 0) return { unit: null, fit: 0 };
  let best = { unit: null as number | null, fit: 0 };
  for (const unit of UNIT_CANDIDATES) {
    const fit =
      usable.reduce(
        (s, [v, n]) => (Math.abs(v / unit - Math.round(v / unit)) * unit <= 0.5 ? s + n : s),
        0,
      ) / weight;
    if (fit >= 0.75) return { unit, fit: round(fit, 0.01) };
    if (fit > best.fit) best = { unit, fit: round(fit, 0.01) };
  }
  return best;
}

function inferSpace(raw: DesignDnaRaw): DesignDna['space'] {
  const merged = new Map<string, number>();
  for (const list of [raw.padding, raw.gap, raw.vmargin])
    for (const [v, n] of list) merged.set(v, (merged.get(v) ?? 0) + n);
  const values: DnaCounts = [...merged].sort((x, y) => y[1] - x[1]);
  const { unit, fit } = inferSpacingUnit(values);
  const scale = values
    .slice(0, 12)
    .map(([v]) => Number(v))
    .filter((v) => v >= 2)
    .sort((x, y) => x - y);
  const padY = raw.sections.flatMap((s) => s.padY).filter((v) => v >= 16);
  return { unit, unitFit: fit, scale, sectionPadY: median(padY) };
}

function shadowKind(value: string): 'soft' | 'hard' | 'ring' {
  // Computed shadows read `color x y blur spread [inset]`, layers comma separated.
  const layers = value.split(/,(?![^(]*\))/);
  let kind: 'soft' | 'hard' | 'ring' = 'ring';
  for (const layer of layers) {
    const nums = (
      layer.replace(/rgba?\([^)]*\)|oklch\([^)]*\)|#[0-9a-f]+/gi, '').match(/-?[\d.]+px/g) ?? []
    ).map((p) => Number.parseFloat(p));
    const [x = 0, y = 0, blur = 0] = nums;
    if (blur > 0) return 'soft';
    if (x !== 0 || y !== 0) kind = 'hard';
  }
  return kind;
}

function inferShape(raw: DesignDnaRaw): DesignDna['shape'] {
  const radiusTotal = Math.max(1, total(raw.radius));
  const numeric = raw.radius.filter(([r]) => r !== 'full');
  const pill = raw.radius.find(([r]) => r === 'full')?.[1] ?? 0;
  const top = raw.radius[0];
  const shadowKinds = raw.shadow.map(([v, n]) => [shadowKind(v), n] as const);
  const byKind = new Map<string, number>();
  for (const [k, n] of shadowKinds) byKind.set(k, (byKind.get(k) ?? 0) + n);
  const kinds = [...byKind].sort((x, y) => y[1] - x[1]);
  const shadowTotal = total(raw.shadow);
  const shadowStyle: DesignDna['shape']['shadowStyle'] =
    kinds.length === 0
      ? 'none'
      : (kinds[0]?.[1] ?? 0) / shadowTotal >= 0.7
        ? (kinds[0]?.[0] as 'soft' | 'hard' | 'ring')
        : 'mixed';
  return {
    radius: top ? (top[0] === 'full' ? 'full' : Number(top[0])) : null,
    radiusScale: numeric
      .slice(0, 6)
      .map(([r]) => Number(r))
      .sort((x, y) => x - y),
    pillShare: round(pill / radiusTotal, 0.01),
    shadowStyle,
    shadowSamples: raw.shadow.slice(0, 3).map(([v]) => v),
    borderWidth: raw.borderW[0] ? Number(raw.borderW[0][0]) : null,
  };
}

function inferLayout(raw: DesignDnaRaw): DnaLayout {
  // Header/nav chrome is reported as `nav`; sections are the content rhythm.
  const sections = raw.sections.filter((s) => s.h >= 64 && !/^(header|nav)$/.test(s.tag));
  const containers = sections
    .map((s) => s.container)
    .filter((w) => w > 0)
    .map((w) => Math.round(w / 8) * 8);
  const wideGrids = raw.grids.filter(
    ([cols = 0, , children = 0, width = 0]) => cols >= 2 && children >= 2 && width >= raw.vw * 0.5,
  );
  return {
    width: raw.vw,
    container: mode(containers) ?? 0,
    sections: sections.map(({ y, h, cols, media, align, bg }) => {
      // A grid inside the section widens its column count beyond direct rows.
      const inner = raw.grids.filter(
        ([, , children = 0, , top = -1]) => children >= 2 && top >= y && top < y + h,
      );
      const gridCols = Math.max(0, ...inner.map(([c = 0]) => c));
      return { y, h, cols: Math.max(cols, gridCols), media, align, bg };
    }),
    maxGridCols: Math.max(0, ...wideGrids.map(([c = 0]) => c)),
    nav: raw.nav,
    docHeight: raw.docH,
  };
}

const MEANINGFUL_VAR = /^--(?![a-z]{1,3}-[0-9a-z]{6,}$)[a-z][\w-]*$/i;
const TOKEN_VALUE =
  /^(#[0-9a-f]{3,8}|(rgb|hsl|oklch|oklab|lab|lch|color)a?\(|-?[\d.]+(px|rem|em|ms|s|%)?$|[\d.]+\s+[\d.]+%\s+[\d.]+%$)/i;

function declaredTokens(vars: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(vars)) {
    if (Object.keys(out).length >= 60) break;
    if (MEANINGFUL_VAR.test(name) && value && TOKEN_VALUE.test(value)) out[name] = value;
  }
  return out;
}

function signalsFor(dna: Omit<DesignDna, 'signals' | 'notes'>, raws: DesignDnaRaw[]): string[] {
  const out: string[] = [];
  const wide = dna.layout[0];
  const narrow = dna.layout[dna.layout.length - 1];
  if (dna.theme === 'dark') out.push('dark-theme');
  const bgL = hexToOklab(dna.color.roles.bg ?? '#ffffff')?.L ?? 1;
  const inverted = dna.color.area
    .filter((c) => Math.abs((hexToOklab(c.hex)?.L ?? bgL) - bgL) > 0.5)
    .reduce((s, c) => s + c.share, 0);
  if (inverted >= 0.12) out.push('inverted-bands');
  if (wide?.nav && /sticky|fixed/.test(wide.nav.pos))
    out.push(wide.nav.backdrop ? 'glass-sticky-nav' : 'sticky-nav');
  if (wide) {
    const sided = wide.sections
      .filter((s) => s.media === 'left' || s.media === 'right')
      .map((s) => s.media);
    let alternations = 0;
    for (let i = 1; i < sided.length; i++) if (sided[i] !== sided[i - 1]) alternations++;
    if (sided.length >= 3 && alternations >= 2) out.push('alternating-media-rows');
    else if (sided.length >= 2) out.push('split-media-sections');
    if (wide.sections.filter((s) => s.media === 'full').length >= 2) out.push('full-bleed-media');
    if (wide.sections.some((s) => s.cols >= 3)) out.push('multi-column-grid');
    const first = wide.sections.find((s) => s.h >= 200);
    if (first?.align === 'center') out.push('centered-hero');
    else if (first?.align === 'start' || first?.align === 'left') out.push('left-aligned-hero');
  }
  if (wide && narrow && wide !== narrow && wide.maxGridCols > narrow.maxGridCols)
    out.push('grid-reflows-on-narrow');
  if (raws.some((r) => r.sections.some((s) => s.sticky && s.h > r.vh * 1.5)))
    out.push('sticky-scroll-narrative');
  if (dna.components.button?.radius === 'full') out.push('pill-buttons');
  if (dna.shape.shadowStyle === 'hard') out.push('hard-offset-shadows');
  if (dna.shape.radius === 0 || (typeof dna.shape.radius === 'number' && dna.shape.radius <= 2))
    out.push('square-corners');
  if (dna.type.mono && dna.type.mono !== dna.type.text) out.push('mono-accent-type');
  if (dna.type.display && dna.type.display !== dna.type.text) out.push('display-type-pairing');
  if ((dna.type.displayTracking ?? 0) <= -0.015) out.push('tight-display-tracking');
  if (dna.type.uppercaseShare >= 0.03) out.push('uppercase-labels');
  if (dna.color.mediaShare >= 0.3) out.push('media-heavy');
  if (dna.color.gradientShare >= 0.05) out.push('gradient-surfaces');
  if ((dna.effects.backdrop ?? 0) >= 3) out.push('glass-surfaces');
  if ((dna.type.base?.size ?? 16) <= 14) out.push('dense-type');
  if (
    dna.color.chromaticShare <= 0.02 &&
    dna.color.roles.primary &&
    hexChroma(dna.color.roles.primary) < 0.06
  )
    out.push('monochrome-palette');
  return out;
}

function mergeCounts(lists: DnaCounts[], limit = 32): DnaCounts {
  const m = new Map<string, number>();
  for (const list of lists) {
    for (const [k, v] of list) m.set(k, (m.get(k) ?? 0) + v);
  }
  return [...m.entries()]
    .map(([k, v]): [string, number] => [k, round(v, 0.01)])
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
}

/**
 * Group multi-page measurements by viewport width. Single-page measurements
 * pass through untouched in descending viewport order.
 */
function mergeRawsByViewport(raws: DesignDnaRaw[]): {
  ordered: DesignDnaRaw[];
  pagesAnalyzed: number;
} {
  const urls = new Set(raws.map((r) => r.url).filter(Boolean));
  const pagesAnalyzed = Math.max(1, urls.size);
  const byVw = new Map<number, DesignDnaRaw[]>();
  for (const r of raws) {
    const group = byVw.get(r.vw);
    if (group) group.push(r);
    else byVw.set(r.vw, [r]);
  }
  const ordered: DesignDnaRaw[] = [];
  for (const [, group] of [...byVw.entries()].sort((a, b) => b[0] - a[0])) {
    if (group.length === 1) {
      ordered.push(group[0] as DesignDnaRaw);
      continue;
    }
    const first = group[0] as DesignDnaRaw;
    const vars: Record<string, string> = {};
    const states: Record<string, DnaStateRule> = {};
    const gradSeen = new Set<string>();
    const fullGradients: DnaGradient[] = [];
    for (const g of group) {
      Object.assign(vars, g.vars);
      if (g.states) Object.assign(states, g.states);
      for (const fg of g.fullGradients ?? []) {
        if (!gradSeen.has(fg.value) && fullGradients.length < 12) {
          gradSeen.add(fg.value);
          fullGradients.push(fg);
        }
      }
    }
    ordered.push({
      ...first,
      samples: {
        points: group.reduce((s, g) => s + g.samples.points, 0),
        media: group.reduce((s, g) => s + g.samples.media, 0),
        gradient: group.reduce((s, g) => s + g.samples.gradient, 0),
        area: mergeCounts(
          group.map((g) => g.samples.area),
          24,
        ),
      },
      text: mergeCounts(
        group.map((g) => g.text),
        60,
      ),
      textColor: mergeCounts(
        group.map((g) => g.textColor),
        16,
      ),
      families: mergeCounts(
        group.map((g) => g.families),
        8,
      ),
      fontsLoaded: [...new Set(group.flatMap((g) => g.fontsLoaded))],
      padding: mergeCounts(group.map((g) => g.padding)),
      gap: mergeCounts(
        group.map((g) => g.gap),
        20,
      ),
      vmargin: mergeCounts(
        group.map((g) => g.vmargin),
        20,
      ),
      radius: mergeCounts(
        group.map((g) => g.radius),
        12,
      ),
      shadow: mergeCounts(
        group.map((g) => g.shadow),
        10,
      ),
      borderW: mergeCounts(
        group.map((g) => g.borderW),
        6,
      ),
      borderColor: mergeCounts(
        group.map((g) => g.borderColor),
        8,
      ),
      duration: mergeCounts(
        group.map((g) => g.duration),
        10,
      ),
      easing: mergeCounts(
        group.map((g) => g.easing),
        6,
      ),
      gradients: mergeCounts(
        group.map((g) => g.gradients),
        6,
      ),
      fullGradients,
      buttons: group.flatMap((g) => g.buttons).slice(0, 24),
      cards: group.flatMap((g) => g.cards ?? []).slice(0, 20),
      links: group.flatMap((g) => g.links ?? []).slice(0, 20),
      badges: group.flatMap((g) => g.badges ?? []).slice(0, 16),
      inputs: group.flatMap((g) => g.inputs).slice(0, 16),
      states,
      statesFound: group.reduce((s, g) => s + (g.statesFound ?? 0), 0),
      sheetsBlocked: group.reduce((s, g) => s + (g.sheetsBlocked ?? 0), 0),
      vars,
    });
  }
  return { ordered, pagesAnalyzed };
}

function rgbStringToHex(str: string): string | null {
  const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(str);
  if (!m) return null;
  const toH = (n: string) =>
    Math.max(0, Math.min(255, Number(n)))
      .toString(16)
      .padStart(2, '0');
  return `#${toH(m[1] ?? '0')}${toH(m[2] ?? '0')}${toH(m[3] ?? '0')}`;
}

function extractGradientHexes(gradients: DnaGradient[]): string[] {
  const out: string[] = [];
  for (const g of gradients) {
    for (const m of g.value.matchAll(/#[0-9a-f]{6}|rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+/gi)) {
      const token = m[0];
      const hex = token.startsWith('#') ? token.toLowerCase() : rgbStringToHex(token);
      if (hex && !out.includes(hex)) out.push(hex);
    }
  }
  return out;
}

/**
 * Build the extended designmd.me semantic + decorative color palette while
 * keeping `roles` intact for existing callers.
 */
function inferRichPalette(
  wide: DesignDnaRaw,
  color: Omit<DesignDna['color'], 'palette'>,
  theme: 'light' | 'dark',
): { palette: Record<string, string>; rolesUnassigned: number } {
  const r = color.roles;
  const palette: Record<string, string> = {};
  const bg = r.bg ?? (theme === 'light' ? '#f6f9fc' : '#0b0b14');
  const fg = r.fg ?? (theme === 'light' ? '#000000' : '#f8f7ff');
  if (r.primary) palette.primary = r.primary;
  if (r.accent) palette.accent = r.accent;

  // Link color: prefer measured <a> text color distinct from fg, else primary/accent.
  const linkColor =
    (wide.links ?? [])
      .map((l) => (l.fg ? solid(l.fg) : null))
      .find((c): c is string => !!c && c !== fg && hexChroma(c) >= 0.05) ??
    r.accent ??
    r.primary ??
    (theme === 'light' ? '#0000ee' : '#60a5fa');
  palette.link = linkColor;
  palette.canvas = bg;
  palette.surface = r.surface ?? (theme === 'light' ? '#e5edf5' : '#1a1a22');
  palette.ink = fg;

  const readable = color.text
    .map((t) => solid(t.hex))
    .filter((h, i, arr) => arr.indexOf(h) === i && hexContrast(h, bg) >= 2.0);
  const byContrast = [...readable].sort((a, b) => hexContrast(b, bg) - hexContrast(a, bg));
  const inkHex = byContrast[0] ?? fg;
  palette.ink = inkHex;
  const neutralReadable = readable.filter(
    (h) => h !== inkHex && h !== r.primary && h !== r.accent && hexChroma(h) < 0.08,
  );
  const bodyHex = neutralReadable[0] ?? r.muted ?? inkHex;
  const mutedHex =
    r.muted && r.muted !== inkHex && r.muted !== bodyHex && hexChroma(r.muted) < 0.08
      ? r.muted
      : (neutralReadable.find((h) => h !== bodyHex) ?? bodyHex);
  const faintHex =
    neutralReadable.find((h) => h !== bodyHex && h !== mutedHex) ??
    (theme === 'light' ? '#64748d' : '#64748b');
  palette.body = bodyHex;
  palette.muted = mutedHex;
  palette.faint = faintHex;
  if (r.border) palette.border = r.border;

  const assigned = new Set(Object.values(palette).map((v) => v.toLowerCase()));
  const gradHexes = extractGradientHexes(wide.fullGradients ?? []);
  const allCandidates = [
    ...color.area.map((a) => solid(a.hex)),
    ...color.text.map((t) => solid(t.hex)),
    ...gradHexes,
    ...wide.buttons.map((b) => (b.bg ? solid(b.bg) : '')).filter(Boolean),
  ].filter((h, i, a) => /^#[0-9a-f]{6}$/i.test(h) && a.indexOf(h) === i && !assigned.has(h));

  let accentIdx = 1;
  let neutralIdx = 1;
  let unassigned = 0;
  for (const hex of allCandidates) {
    if (hexChroma(hex) >= 0.05) {
      if (accentIdx <= 5) {
        palette[`accent-${accentIdx++}`] = hex;
        unassigned++;
      }
    } else if (neutralIdx <= 2) {
      palette[`neutral-${neutralIdx++}`] = hex;
      unassigned++;
    }
  }
  return { palette, rolesUnassigned: unassigned };
}

/**
 * Map measured text runs, buttons, navigation, and badges onto the rich
 * designmd.me typographic role catalog.
 */
function inferTypographyRoles(
  wide: DesignDnaRaw,
  type: DesignDna['type'],
): Record<string, DnaTypographySpec> {
  const runs = parseText(wide);
  const baseFamily = type.text ?? type.display ?? 'sans-serif';
  const displayFamily = type.display ?? baseFamily;
  const roles: Record<string, DnaTypographySpec> = {};

  const toSpec = (r: TextRun, notes?: string): DnaTypographySpec => ({
    fontFamily: r.family || baseFamily,
    fontSize: `${r.size}px`,
    fontWeight: r.weight,
    lineHeight: round(r.lineHeight / Math.max(1, r.size), 0.01),
    letterSpacing: `${r.tracking}px`,
    ...(r.transform && r.transform !== 'none' ? { textTransform: r.transform } : {}),
    ...(notes ? { notes } : {}),
  });

  const sortedBySize = [...runs].sort((a, b) => b.size - a.size || b.chars - a.chars);
  const displayRuns = sortedBySize.filter((r) => r.size >= 40);
  if (displayRuns[0]) {
    roles['display-lg'] = toSpec(
      displayRuns[0],
      'Hero headlines; tight negative tracking for visual impact',
    );
    const strongDisplay = displayRuns.find(
      (r) => r.size === displayRuns[0]?.size && r.weight !== displayRuns[0]?.weight,
    );
    if (strongDisplay) {
      roles['display-lg-strong'] = toSpec(strongDisplay, 'Strong hero headline variant');
    }
  }
  const midDisplay = displayRuns.find(
    (r) => r.size < (displayRuns[0]?.size ?? 999) && r.size >= 40,
  );
  if (midDisplay) {
    roles['display-md'] = toSpec(
      midDisplay,
      'Large landing section titles; pronounced display scale',
    );
  }

  const hXl = sortedBySize.find((r) => r.size >= 30 && r.size < 40);
  if (hXl) roles['heading-xl'] = toSpec(hXl, 'Section headlines, medium emphasis');
  const hLg = sortedBySize.find((r) => r.size >= 25 && r.size < 30);
  if (hLg) roles['heading-lg'] = toSpec(hLg, 'Card titles, subsection headers');
  const hMd = sortedBySize.find((r) => r.size >= 20 && r.size < 25);
  if (hMd) roles['heading-md'] = toSpec(hMd, 'Subheadings, card subtitles');
  const hSm = sortedBySize.find((r) => /^h[1-6]$/.test(r.tag) && r.size >= 15 && r.size < 20);
  if (hSm) roles['heading-sm'] = toSpec(hSm, 'Small headings, list titles');
  const hXs = sortedBySize.find((r) => /^h[1-6]$/.test(r.tag) && r.size >= 13 && r.size < 15);
  if (hXs) roles['heading-xs'] = toSpec(hXs, 'Minimal headings, UI labels');

  const bodyRuns = runs
    .filter((r) => !/^h[1-6]|button|nav$/.test(r.tag))
    .sort((a, b) => b.chars - a.chars);
  const bodyLg = bodyRuns.find((r) => r.size >= 17 && r.size <= 20);
  if (bodyLg) roles['body-lg'] = toSpec(bodyLg, 'Large body copy, intro paragraphs');
  const bodyMd =
    bodyRuns.find((r) => r.size >= 15 && r.size <= 16) ??
    (type.base
      ? {
          size: type.base.size,
          weight: type.base.weight,
          lineHeight: type.base.size * type.base.lineHeight,
          tracking: 0,
          family: baseFamily,
          transform: '',
          tag: 'p',
          chars: 1,
        }
      : undefined);
  if (bodyMd) roles['body-md'] = toSpec(bodyMd, 'Standard body text, primary reading');

  const bodySmRuns = bodyRuns.filter((r) => r.size >= 13 && r.size <= 14);
  if (bodySmRuns[0]) {
    roles['body-sm'] = toSpec(bodySmRuns[0], 'Secondary body, list items');
    const strongSm = bodySmRuns.find((r) => r.weight > (bodySmRuns[0]?.weight ?? 400));
    if (strongSm) roles['body-sm-strong'] = toSpec(strongSm, 'Emphasized small body text');
  }

  const navRun =
    runs.find((r) => r.tag === 'nav' || r.tag === 'a') ??
    (wide.nav?.fs
      ? {
          size: wide.nav.fs,
          weight: Number(wide.nav.fw ?? 400),
          lineHeight: wide.nav.fs * 1.5,
          tracking: 0,
          family: wide.nav.ff ?? baseFamily,
          transform: '',
          tag: 'nav',
          chars: 1,
        }
      : undefined);
  if (navRun) roles.nav = toSpec(navRun, 'Navigation link text, menu items');

  // Button typography roles
  const btnRuns = wide.buttons;
  const lgBtn = btnRuns.find((b) => b.fs >= 14 && b.h >= 44) ?? btnRuns[0];
  if (lgBtn) {
    roles['button-lg'] = {
      fontFamily: lgBtn.ff ?? baseFamily,
      fontSize: `${lgBtn.fs}px`,
      fontWeight: Number(lgBtn.fw) || 400,
      lineHeight: lgBtn.lh ?? 1.2,
      letterSpacing: '0px',
      notes: 'Primary/large button text',
    };
  }
  const mdBtn = btnRuns.find((b) => b.fs >= 12 && b.fs <= 13);
  if (mdBtn) {
    roles['button-md'] = {
      fontFamily: mdBtn.ff ?? baseFamily,
      fontSize: `${mdBtn.fs}px`,
      fontWeight: Number(mdBtn.fw) || 400,
      lineHeight: mdBtn.lh ?? 1.2,
      letterSpacing: '0px',
      notes: 'Medium button text',
    };
  }
  const smBtn = btnRuns.find((b) => b.fs <= 11);
  if (smBtn) {
    roles['button-sm'] = {
      fontFamily: smBtn.ff ?? baseFamily,
      fontSize: `${smBtn.fs}px`,
      fontWeight: Number(smBtn.fw) || 400,
      lineHeight: smBtn.lh ?? 1.4,
      letterSpacing: '0px',
      notes: 'Small button or badge text',
    };
  }

  // Label & Caption roles
  const labelRun = runs.find((r) => r.tag === 'label' || (r.size === 15 && r.weight >= 400));
  if (labelRun) {
    roles.label = toSpec(labelRun, 'Form labels, table headers');
  } else if (type.base) {
    roles.label = {
      fontFamily: baseFamily,
      fontSize: `${Math.max(12, type.base.size - 1)}px`,
      fontWeight: 500,
      lineHeight: 1.5,
      letterSpacing: '0px',
      notes: 'Form labels, table headers',
    };
  }

  const capMd = runs.find((r) => r.size === 12);
  if (capMd) roles['caption-md'] = toSpec(capMd, 'Standard caption, meta text');
  const capSm = runs.find((r) => r.size === 11);
  if (capSm) roles['caption-sm'] = toSpec(capSm, 'Small caption, footnotes');
  const capXs = runs.find((r) => r.size <= 10 && r.size > 0);
  if (capXs) roles['caption-xs'] = toSpec(capXs, 'Minimal caption, uppercase meta');

  // Ensure display fallback exists if no 40px+ run was found
  if (!roles['display-lg'] && sortedBySize[0]) {
    roles['display-lg'] = {
      ...toSpec(sortedBySize[0], 'Hero headlines'),
      fontFamily: displayFamily,
    };
  }
  return roles;
}

/**
 * Build the rich component catalog with token references (`{colors.*}`, `{rounded.*}`).
 */
function inferComponentCatalog(
  ordered: DesignDnaRaw[],
  palette: Record<string, string>,
  type: DesignDna['type'],
  radiusScale: number[],
): Record<string, Record<string, string | number>> {
  const wide = ordered[0] as DesignDnaRaw;
  const narrow = ordered[ordered.length - 1] as DesignDnaRaw;
  const baseFont = type.text ?? type.display ?? 'sans-serif';
  const catalog: Record<string, Record<string, string | number>> = {};

  const colorRef = (rawColor: string | null | undefined, fallback: string): string => {
    if (!rawColor) return fallback;
    const hex = solid(rawColor);
    for (const [k, v] of Object.entries(palette)) {
      if (deltaE(hex, v) < 0.02) return `{colors.${k}}`;
    }
    return hex;
  };

  const radiusRef = (r: number | 'full' | undefined): string => {
    if (r === 'full') return '{rounded.full}';
    if (r === undefined || r === 0) return '{rounded.none}';
    const sm = radiusScale[0] ?? 4;
    const lg = radiusScale[radiusScale.length - 1] ?? 8;
    if (Math.abs(r - sm) <= 1.5) return '{rounded.sm}';
    if (Math.abs(r - lg) <= 2) return '{rounded.lg}';
    return '{rounded.md}';
  };

  const buttons = wide.buttons.filter((b) => isOpaque(b.bg) || b.border);
  const primaryHex = palette.primary;
  const primaryBtn =
    buttons.find(
      (b) => b.bg && primaryHex && deltaE(solid(b.bg), primaryHex) < 0.03 && b.h >= 42,
    ) ??
    buttons.find((b) => b.bg && primaryHex && deltaE(solid(b.bg), primaryHex) < 0.03) ??
    buttons[0];

  if (primaryBtn) {
    catalog['button-primary'] = {
      textColor: colorRef(primaryBtn.fg, '#ffffff'),
      height: `${primaryBtn.h}px`,
      padding: primaryBtn.pad ?? `12px ${primaryBtn.padX}px`,
      fontSize: `${primaryBtn.fs}px`,
      fontFamily: primaryBtn.ff || baseFont,
      fontWeight: Number(primaryBtn.fw) || 400,
      lineHeight: primaryBtn.lh ?? 1,
      rounded: radiusRef(primaryBtn.r),
      backgroundColor: colorRef(primaryBtn.bg, '{colors.primary}'),
    };
  }

  const primarySmBtn = buttons.find(
    (b) =>
      b !== primaryBtn && b.bg && primaryHex && deltaE(solid(b.bg), primaryHex) < 0.03 && b.h <= 42,
  );
  if (primarySmBtn) {
    catalog['button-primary-sm'] = {
      textColor: colorRef(primarySmBtn.fg, '#ffffff'),
      height: `${primarySmBtn.h}px`,
      padding: primarySmBtn.pad ?? `8px ${primarySmBtn.padX}px`,
      fontSize: `${primarySmBtn.fs}px`,
      fontFamily: primarySmBtn.ff || baseFont,
      fontWeight: Number(primarySmBtn.fw) || 400,
      lineHeight: primarySmBtn.lh ?? 1,
      rounded: radiusRef(primarySmBtn.r),
      backgroundColor: colorRef(primarySmBtn.bg, '{colors.primary}'),
    };
  }

  const filledBtn = buttons.find((b) => b !== primaryBtn && b !== primarySmBtn && b.bg && b.border);
  if (filledBtn) {
    catalog['button-filled'] = {
      textColor: colorRef(filledBtn.fg, '{colors.primary}'),
      border: `${filledBtn.bw ?? 1}px solid ${solid(filledBtn.border ?? '#e2e8f0')}`,
      height: `${filledBtn.h}px`,
      padding: filledBtn.pad ?? `12px ${filledBtn.padX}px`,
      fontSize: `${filledBtn.fs}px`,
      fontFamily: filledBtn.ff || baseFont,
      fontWeight: Number(filledBtn.fw) || 400,
      lineHeight: filledBtn.lh ?? 1,
      rounded: radiusRef(filledBtn.r),
      backgroundColor: colorRef(filledBtn.bg, '{colors.surface}'),
    };
  }

  const outlineBtn = buttons.find((b) => !isOpaque(b.bg) && b.border);
  if (outlineBtn) {
    catalog['button-outline'] = {
      textColor: colorRef(outlineBtn.fg, '{colors.primary}'),
      border: `${outlineBtn.bw ?? 1}px solid ${solid(outlineBtn.border ?? '#cbd5e1')}`,
      height: `${outlineBtn.h}px`,
      padding: outlineBtn.pad ?? `10px ${outlineBtn.padX}px`,
      fontSize: `${outlineBtn.fs}px`,
      fontFamily: outlineBtn.ff || baseFont,
      fontWeight: Number(outlineBtn.fw) || 400,
      lineHeight: outlineBtn.lh ?? 1,
      rounded: radiusRef(outlineBtn.r),
    };
  }

  const iconBtn = wide.buttons.find((b) => b.iconOnly || Math.abs(b.w - b.h) <= 4);
  if (iconBtn) {
    catalog['button-icon'] = {
      textColor: colorRef(iconBtn.fg, '{colors.ink}'),
      height: `${iconBtn.h}px`,
      fontSize: `${iconBtn.fs}px`,
      fontFamily: iconBtn.ff || baseFont,
      fontWeight: Number(iconBtn.fw) || 400,
      lineHeight: 1,
      rounded: radiusRef(iconBtn.r),
      ...(iconBtn.bg ? { backgroundColor: colorRef(iconBtn.bg, '{colors.surface}') } : {}),
    };
  }

  const cards = wide.cards ?? [];
  if (cards[0]) {
    const c0 = cards[0];
    catalog.card = {
      textColor: colorRef(c0.fg, '{colors.ink}'),
      fontSize: `${c0.fs}px`,
      fontFamily: c0.ff || baseFont,
      fontWeight: Number(c0.fw) || 400,
      rounded: radiusRef(c0.r),
      backgroundColor: colorRef(c0.bg, '{colors.surface}'),
      ...(c0.pad && c0.pad !== '0px 0px 0px 0px' ? { padding: c0.pad } : {}),
    };
  } else if (palette.surface) {
    catalog.card = {
      textColor: '{colors.ink}',
      fontSize: `${type.base?.size ?? 16}px`,
      fontFamily: baseFont,
      fontWeight: 400,
      rounded: '{rounded.lg}',
      backgroundColor: '{colors.surface}',
    };
  }

  const lgCard = cards.find(
    (c) => c !== cards[0] && c.w * c.h > (cards[0]?.w ?? 0) * (cards[0]?.h ?? 0) * 1.3,
  );
  if (lgCard) {
    catalog['card-lg'] = {
      textColor: colorRef(lgCard.fg, '{colors.ink}'),
      fontSize: `${lgCard.fs}px`,
      fontFamily: lgCard.ff || baseFont,
      fontWeight: Number(lgCard.fw) || 400,
      rounded: radiusRef(lgCard.r),
      backgroundColor: colorRef(lgCard.bg, '{colors.surface}'),
    };
  }

  if (wide.nav) {
    catalog.navigation = {
      textColor: colorRef(wide.nav.fg, '{colors.ink}'),
      height: `${wide.nav.h}px`,
      padding: wide.nav.pad ?? '10px 16px 10px 16px',
      fontSize: `${wide.nav.fs ?? 16}px`,
      fontFamily: wide.nav.ff || baseFont,
      fontWeight: Number(wide.nav.fw ?? 400) || 400,
      rounded: radiusRef(wide.nav.r ?? 0),
    };
  }
  if (narrow.nav && narrow !== wide) {
    catalog['navigation-sm'] = {
      textColor: colorRef(narrow.nav.fg, '{colors.body}'),
      height: `${narrow.nav.h}px`,
      fontSize: `${narrow.nav.fs ?? 16}px`,
      fontFamily: narrow.nav.ff || baseFont,
      fontWeight: Number(narrow.nav.fw ?? 300) || 300,
    };
  }

  if (wide.footer) {
    catalog.footer = {
      textColor: colorRef(wide.footer.fg, '{colors.ink}'),
      padding: wide.footer.pad ?? '0px 16px 0px 16px',
      fontSize: `${wide.footer.fs}px`,
      fontFamily: wide.footer.ff || baseFont,
      fontWeight: Number(wide.footer.fw) || 400,
      ...(wide.footer.bg ? { backgroundColor: colorRef(wide.footer.bg, '{colors.canvas}') } : {}),
    };
  }

  const links = wide.links ?? [];
  const inlineLink = links.find((l) => !l.border && !isOpaque(l.bg)) ?? links[0];
  if (inlineLink) {
    catalog.link = {
      textColor: colorRef(inlineLink.fg, '{colors.link}'),
      fontSize: `${inlineLink.fs}px`,
      fontFamily: inlineLink.ff || baseFont,
      fontWeight: Number(inlineLink.fw) || 400,
    };
  } else if (palette.link) {
    catalog.link = {
      textColor: '{colors.link}',
      fontSize: `${type.base?.size ?? 16}px`,
      fontFamily: baseFont,
      fontWeight: 400,
    };
  }

  const boxedLink = links.find((l) => l.border || isOpaque(l.bg));
  if (boxedLink) {
    catalog['link-sm'] = {
      textColor: colorRef(boxedLink.fg, '{colors.primary}'),
      ...(boxedLink.border
        ? { border: `${boxedLink.bw ?? 1}px solid ${solid(boxedLink.border)}` }
        : {}),
      ...(boxedLink.pad ? { padding: boxedLink.pad } : {}),
      fontSize: `${boxedLink.fs}px`,
      fontFamily: boxedLink.ff || baseFont,
      fontWeight: Number(boxedLink.fw) || 400,
      lineHeight: boxedLink.lh ?? 1,
      rounded: radiusRef(boxedLink.r),
    };
  }

  const badges = (wide.badges ?? []).filter((b) => b.fs <= 15);
  const textBadge = badges.find((b) => !isOpaque(b.bg));
  if (textBadge) {
    catalog['badge-text'] = {
      textColor: colorRef(textBadge.fg, '{colors.accent}'),
      height: `${textBadge.h}px`,
      padding: textBadge.pad ?? '3px 8px 3px 8px',
      fontSize: `${textBadge.fs}px`,
      fontFamily: textBadge.ff || baseFont,
      fontWeight: Number(textBadge.fw) || 500,
    };
  }
  const filledBadge = badges.find((b) => isOpaque(b.bg) || b.border);
  if (filledBadge) {
    catalog['badge-filled'] = {
      textColor: colorRef(filledBadge.fg, '{colors.accent}'),
      ...(filledBadge.border
        ? {
            border: `${filledBadge.bw ?? 1}px solid ${colorRef(filledBadge.border, '{colors.surface}')}`,
          }
        : {}),
      height: `${filledBadge.h}px`,
      padding: filledBadge.pad ?? '6px 10px 6px 10px',
      fontSize: `${filledBadge.fs}px`,
      fontFamily: filledBadge.ff || baseFont,
      fontWeight: Number(filledBadge.fw) || 425,
      lineHeight: filledBadge.lh ?? 1.15,
      rounded: radiusRef(filledBadge.r),
      backgroundColor: colorRef(filledBadge.bg, '#ffffff'),
    };
  }

  return catalog;
}

/**
 * Build responsive breakpoint rows sorted ascending by viewport width (e.g. 375 → 768 → 1024 → 1280 → 1440).
 */
function inferBreakpoints(
  ordered: DesignDnaRaw[],
  layouts: DnaLayout[],
  type: DesignDna['type'],
): DnaBreakpoint[] {
  const byWidth = [...ordered].sort((a, b) => a.vw - b.vw);
  const largestScale = type.scale[type.scale.length - 1] ?? 48;
  const baseBody = type.base?.size ?? 16;

  return byWidth.map((raw) => {
    const layout = layouts.find((l) => l.width === raw.vw);
    const runs = parseText(raw);
    const headings = runs.filter((r) => /^h[1-2]$/.test(r.tag) || r.size >= 28);
    const headingPx = headings.length
      ? Math.max(...headings.map((h) => h.size))
      : raw.vw < 768
        ? Math.round(largestScale * 0.65)
        : raw.vw < 1024
          ? Math.round(largestScale * 0.85)
          : largestScale;
    const bodyRun = runs
      .filter((r) => !/^h[1-6]$/.test(r.tag) && r.size >= 12 && r.size <= 20)
      .sort((a, b) => b.chars - a.chars)[0];
    const bodyPx = bodyRun?.size ?? baseBody;
    const padXs = raw.sections.flatMap((s) => s.padX ?? []).filter((v) => v > 0 && v <= 64);
    const sectionPaddingX = padXs.length ? (median(padXs) ?? 16) : raw.vw < 768 ? 0 : 16;
    const containerWidth =
      layout && layout.container > 0
        ? layout.container
        : Math.max(320, raw.vw - (raw.vw < 768 ? 12 : 32));
    const gridColumns = Math.max(1, layout?.maxGridCols ?? 0, ...raw.sections.map((s) => s.cols));
    const navLinksVisible =
      raw.nav?.linksVis ??
      (raw.nav ? (raw.vw < 768 ? Math.min(1, raw.nav.links) : Math.min(6, raw.nav.links)) : 0);
    const menuToggleVisible = raw.nav?.menuToggle ?? raw.vw < 768;

    return {
      width: raw.vw,
      containerWidth,
      gridColumns,
      navLinksVisible,
      menuToggleVisible,
      headingPx,
      bodyPx,
      sectionPaddingX,
    };
  });
}

/**
 * Summarize one page (or multiple pages) measured at several viewports. The
 * widest viewport supplies color/type/shape (they rarely change by width);
 * layout and breakpoints are kept per viewport because reflow is the point of
 * measuring more than one.
 */
export function summarizeDesignDna(
  raws: DesignDnaRaw[],
  capturedAt = new Date().toISOString(),
): DesignDna {
  if (raws.length === 0) throw new Error('design dna: no measurements to summarize');
  const { ordered, pagesAnalyzed } = mergeRawsByViewport(raws);
  const wide = ordered[0] as DesignDnaRaw;
  const buttons = wide.buttons.filter((b) => isOpaque(b.bg) || b.border);
  const { theme, ...color } = inferColor(wide, wide.buttons);
  const { palette, rolesUnassigned } = inferRichPalette(wide, color, theme);
  const type = inferType(wide);
  const typeRoles = inferTypographyRoles(wide, type);
  const shape = inferShape(wide);
  const layouts = ordered.map(inferLayout);
  const catalog = inferComponentCatalog(ordered, palette, type, shape.radiusScale);
  const breakpoints = inferBreakpoints(ordered, layouts, type);
  const gradients = wide.fullGradients ?? [];
  const states = wide.states ?? {};
  const declared = declaredTokens(wide.vars);
  const semanticRampDeclared = Object.keys(declared).some((k) =>
    /success|error|warning|danger|info/i.test(k),
  );
  const coverage: DnaCoverage = {
    statesFound: wide.statesFound ?? Object.keys(states).length,
    gradientsFound: Math.max(gradients.length, wide.gradients.length),
    rolesUnassigned,
    archetypesUnnamed: 0,
    archetypesDetected: Object.keys(catalog).length,
    responsiveMeasured: ordered.length >= 2,
    stylesheetsBlocked: (wide.sheetsBlocked ?? 0) > 0 || Object.keys(wide.vars).length === 0,
    semanticRampDeclared,
  };
  const primaryButton =
    buttons.find(
      (b) => b.bg && color.roles.primary && deltaE(solid(b.bg), color.roles.primary) < 0.02,
    ) ?? buttons[0];
  const input = wide.inputs[0];
  const base: Omit<DesignDna, 'signals' | 'notes'> = {
    version: 1,
    source: {
      url: wide.url,
      title: wide.title,
      capturedAt,
      viewports: ordered.map((r) => r.vw),
      pagesAnalyzed,
    },
    theme,
    color: { ...color, palette },
    type: { ...type, roles: typeRoles },
    space: inferSpace(wide),
    shape,
    motion: {
      duration: wide.duration[0] ? Number(wide.duration[0][0]) : null,
      durations: wide.duration.slice(0, 5).map(([d]) => Number(d)),
      easing: wide.easing[0]?.[0] ?? null,
      animated: wide.effects.animated ?? 0,
    },
    components: {
      button: primaryButton
        ? {
            h: primaryButton.h,
            padX: primaryButton.padX,
            radius: primaryButton.r,
            weight: Number(primaryButton.fw),
            size: primaryButton.fs,
            transform: primaryButton.tt,
          }
        : null,
      input: input ? { h: input.h, radius: input.r, borderWidth: input.bw } : null,
      catalog,
    },
    gradients,
    states,
    breakpoints,
    coverage,
    layout: layouts,
    effects: wide.effects,
    declaredTokens: declared,
  };
  const notes: string[] = [];
  const unloaded = [type.text, type.display, type.mono].filter(
    (f): f is string => !!f && !type.loaded.some((l) => l.toLowerCase() === f.toLowerCase()),
  );
  if (unloaded.length)
    notes.push(
      `Font(s) ${[...new Set(unloaded)].join(', ')} were declared but not seen in document.fonts — they may be system fonts or the rendered text may use a fallback.`,
    );
  if (color.mediaShare >= 0.25)
    notes.push(
      `${Math.round(color.mediaShare * 100)}% of sampled area is image/video/canvas — its colors are not in the palette.`,
    );
  if (Object.keys(wide.vars).length === 0)
    notes.push(
      'No :root custom properties were readable (none declared, or stylesheets are cross-origin).',
    );
  if (wide.screens < Math.ceil(wide.docH / wide.vh))
    notes.push(
      `Color was sampled over the first ${wide.screens} screens of a ${Math.ceil(wide.docH / wide.vh)}-screen page.`,
    );
  if (!type.base) notes.push('No body text was measured; the type scale is unreliable.');
  if ((wide.effects.animated ?? 0) > 50)
    notes.push(
      'Many running animations: reveal-on-scroll content may have been mid-transition when measured.',
    );
  return { ...base, signals: signalsFor(base, ordered), notes };
}
