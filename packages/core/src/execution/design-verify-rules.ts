/**
 * Design verify — rule catalogue additions and inline waivers.
 *
 * Every rule has a stable id (`<axis-ish>.<name>`) and a severity. FAIL is
 * reserved for a definite accessibility defect; everything else is WARN — a
 * likely generated-UI or craft problem to fix or defend. Each rule here was
 * run over the repository's own UI corpus (824 files) before it was added;
 * candidates whose hits were mostly legitimate code were rejected rather than
 * tuned until quiet (removed outline inside a focus-within wrapper, sub-12px
 * text in dense operator UI, per-file reduced-motion with a global rule).
 *
 * Waivers are comments in any syntax, naming ids explicitly:
 *   `design-ignore: a11y.div-click`              — this line
 *   `design-ignore-next-line: motion.transition-all` — the following line
 *   `design-ignore-file: copy.em-dash-density`   — the whole file
 * `*` waives every rule at that scope.
 */

import type { DesignKitTokens } from '@wrongstack/contracts/types/design-kit';
import { classifyTokenValue } from './design-color.js';

export type DesignSeverity = 'FAIL' | 'WARN';
type RuleAxis = 'type' | 'motion' | 'composition';

export interface RuleContext {
  /** The kit's own tokens include a gradient: decorative glow is its idiom. */
  gradientKit: boolean;
}

interface LineRule {
  id: string;
  axis: RuleAxis;
  severity: DesignSeverity;
  reason: string;
  /** The offending snippet, or null. `next` is the next non-empty code line. */
  match(line: string, next: string, ctx: RuleContext): string | null;
}

interface FileRule {
  id: string;
  axis: RuleAxis;
  severity: DesignSeverity;
  match(code: string[], ctx: RuleContext): { line: number; snippet: string; reason: string } | null;
}

const CLASS_RE = /(?:className|class)=["'`{]([^"'`}]+)/;
const classOf = (line: string): string => CLASS_RE.exec(line)?.[1] ?? '';

export const LINE_RULES: readonly LineRule[] = [
  {
    id: 'motion.transition-all',
    axis: 'motion',
    severity: 'WARN',
    reason:
      'transition on every property animates layout and paint you did not intend — list the properties (transition-colors, transition-opacity, transition-transform)',
    match: (l) => /\btransition-all\b|transition:\s*all\b/.exec(l)?.[0] ?? null,
  },
  {
    id: 'motion.overshoot-easing',
    axis: 'motion',
    severity: 'WARN',
    reason:
      'hand-written overshooting easing — bounce reads as a toy in product UI; use the kit ease tokens (ease-standard / ease-emphasized)',
    match: (l) => {
      for (const m of l.matchAll(
        /cubic-bezier\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)/g,
      )) {
        const y1 = Number(m[2]);
        const y2 = Number(m[4]);
        if (y1 > 1 || y1 < 0 || y2 > 1 || y2 < 0) return m[0];
      }
      return null;
    },
  },
  {
    id: 'composition.glow-blob',
    axis: 'composition',
    severity: 'WARN',
    reason:
      'blurred decorative glow blob — a stock generated-hero motif; give the surface a product reason or remove it',
    match: (l, _n, ctx) => {
      if (ctx.gradientKit) return null;
      const c = classOf(l) || l;
      return /\bblur-(?:2xl|3xl|\[\d{2,}px\])\b/.test(c) &&
        /\brounded-full\b/.test(c) &&
        /\babsolute\b/.test(c)
        ? c.slice(0, 80)
        : null;
    },
  },
  {
    id: 'composition.eyebrow-label',
    axis: 'composition',
    severity: 'WARN',
    reason:
      'tiny uppercase eyebrow label above the main heading — the most repeated generated-hero tell; let the heading carry the section',
    match: (l, next) => {
      const c = classOf(l);
      return /\buppercase\b/.test(c) &&
        /\btext-(?:xs|\[1[01]px\])\b/.test(c) &&
        /<h[12]\b/.test(next)
        ? c.slice(0, 80)
        : null;
    },
  },
  {
    id: 'copy.not-x-but-y',
    axis: 'composition',
    severity: 'WARN',
    reason:
      '"not just X — it’s Y" forced-contrast copy — state what the product does instead of correcting a claim nobody made',
    match: (l) =>
      />[^<]*\b(?:not just|isn['’]t just|not only)\b[^<]*[,—–-]\s*(?:it['’]s|but)\b[^<]*/i
        .exec(l)?.[0]
        ?.slice(1, 81) ?? null,
  },
  {
    id: 'media.img-unsized',
    axis: 'composition',
    severity: 'WARN',
    reason:
      '<img> without width/height or a sizing class shifts the layout while it loads — set dimensions or an aspect ratio',
    match: (l) => {
      if (!/<img\b/.test(l) || !/\/?>/.test(l)) return null;
      if (/\b(?:width|height)=/.test(l) || /\baspect-/.test(l)) return null;
      if (/\b(?:size|w|h)-(?:\d|\[|full|screen|auto)/.test(classOf(l))) return null;
      return l.trim().slice(0, 80);
    },
  },
  {
    id: 'a11y.div-click',
    axis: 'composition',
    severity: 'WARN',
    reason:
      'click handler on a <div>/<span> without a role — keyboard and screen-reader users cannot reach it; use a <button> or <a>',
    match: (l) => {
      const m = /<(div|span)\b[^>]*\bonClick=/.exec(l);
      return m && !/\brole=/.test(l) && !/\btabIndex=/.test(l) ? m[0].slice(0, 80) : null;
    },
  },
  {
    id: 'a11y.icon-button-unlabeled',
    axis: 'composition',
    severity: 'FAIL',
    reason:
      'icon-only <button> without aria-label — it has no accessible name; add aria-label with the action',
    match: (l) =>
      /<button\b(?![^>]*\baria-label)(?![^>]*\btitle=)[^>]*>\s*<[A-Z]\w*\b[^>]*\/>\s*<\/button>/
        .exec(l)?.[0]
        ?.slice(0, 80) ?? null,
  },
  {
    id: 'a11y.zoom-disabled',
    axis: 'composition',
    severity: 'FAIL',
    reason:
      'pinch-zoom disabled in the viewport meta — low-vision users cannot enlarge the page (WCAG 1.4.4)',
    match: (l) =>
      /user-scalable\s*=\s*(?:no|0)|maximum-scale\s*=\s*1(?:\.0)?\b/.exec(l)?.[0] ?? null,
  },
  {
    id: 'type.justify',
    axis: 'type',
    severity: 'WARN',
    reason: 'justified text on the web leaves uneven word gaps (rivers) — use start alignment',
    match: (l) => /\btext-justify\b|text-align:\s*justify/.exec(l)?.[0] ?? null,
  },
];

const EM_DASH_LIMIT = 6;

export const FILE_RULES: readonly FileRule[] = [
  {
    id: 'copy.em-dash-density',
    axis: 'composition',
    severity: 'WARN',
    match: (code) => {
      let count = 0;
      let first = -1;
      code.forEach((l, i) => {
        const n = (l.match(/>[^<>{}]*—[^<>{}]*</g) ?? []).length;
        if (n && first < 0) first = i;
        count += n;
      });
      return count >= EM_DASH_LIMIT
        ? {
            line: first + 1,
            snippet: `— ×${count}`,
            reason: `${count} em-dashes in visible copy — a generated-prose tell; most can be a period or a comma`,
          }
        : null;
    },
  },
];

/** Every rule id the engine can report, for `checked` lists and docs. */
const DESIGN_RULE_IDS: readonly string[] = [
  'color.off-palette',
  'color.generic-utility',
  'color.absolute',
  'radius.arbitrary',
  'radius.hardcoded',
  'spacing.arbitrary',
  'type.font-arbitrary',
  'type.font-family',
  'type.caps-tracking',
  'composition.gradient-text',
  'composition.stock-elevation',
  'composition.emoji-icon',
  'composition.elevation-none',
  'composition.border-elevation',
  'composition.centered-monotony',
  'composition.repeated-block',
  'copy.filler',
  'copy.generic-label',
  'copy.empty-state',
  ...LINE_RULES.map((r) => r.id),
  ...FILE_RULES.map((r) => r.id),
];

const KNOWN_IDS: ReadonlySet<string> = new Set(DESIGN_RULE_IDS);

export function ruleContext(tokens: DesignKitTokens): RuleContext {
  const values = [...Object.values(tokens.light ?? {}), ...Object.values(tokens.dark ?? {})];
  return { gradientKit: values.some((v) => classifyTokenValue(v) === 'gradient') };
}

export interface Waivers {
  file: Set<string>;
  /** 1-based line → waived ids on that line. */
  lines: Map<number, Set<string>>;
}

// The id list ends where the comment does: the `*` of a closing `*/` is not
// the wildcard (it was, and `/* design-ignore: one.rule */` waived everything).
const WAIVER_RE = /design-ignore(-next-line|-file)?:([^\n]*?)(?:\*\/|-->|$)/;

export function parseWaivers(lines: readonly string[]): Waivers {
  const out: Waivers = { file: new Set(), lines: new Map() };
  lines.forEach((text, i) => {
    const m = WAIVER_RE.exec(text);
    if (!m) return;
    const ids = (m[2] ?? '')
      .split(/[\s,]+/)
      .map((s) => s.trim())
      // Only real rule ids: a misspelt waiver must not look like it worked.
      .filter((s) => s === '*' || KNOWN_IDS.has(s));
    if (ids.length === 0) return;
    if (m[1] === '-file') {
      for (const id of ids) out.file.add(id);
      return;
    }
    const line = m[1] === '-next-line' ? i + 2 : i + 1;
    const set = out.lines.get(line) ?? new Set<string>();
    for (const id of ids) set.add(id);
    out.lines.set(line, set);
  });
  return out;
}

export function isWaived(w: Waivers, id: string, line: number): boolean {
  if (w.file.has('*') || w.file.has(id)) return true;
  const at = w.lines.get(line);
  return !!at && (at.has('*') || at.has(id));
}

// ── Kit awareness (read from token values, never kit ids) ─────────────────────

/** A hard offset shadow: `4px 4px 0 …` — an offset with no blur. */
const HARD_SHADOW_RE = /^-?\d+px\s+-?\d+px\s+0(\s|$)/;

/**
 * Does this kit express elevation as a hard stamped offset rather than a soft
 * shadow?
 *
 * Border + elevation is only a conflict when the elevation is SOFT — two ways of
 * saying "this floats". When the kit's own ramp is a zero-blur offset
 * (`pixel-8bit`, `grunge-press`, `neo-brutalist`), border + offset IS the kit's
 * signature, and flagging it would make the engine fight the kit it is enforcing.
 * Read from the token values, so no kit id or tag list is needed.
 */
export function usesHardShadows(tokens: DesignKitTokens): boolean {
  for (const set of [tokens.light, tokens.dark]) {
    if (!set) continue;
    // Only the ramp steps feed the `shadow-2…4` utilities. The BASE `shadow`
    // key is a separate token that names no scale step, and `readTokens()`
    // merges the foundations scale under every kit — so a base-hard kit
    // (comic-pop) still resolves `shadow-2/3` to the foundations SOFT
    // defaults, which is exactly the float the stacked rule exists to catch.
    // Sanctioning off the base key suppressed that finding.
    for (const key of ['shadow-2', 'shadow-3', 'shadow-4']) {
      const value = set[key]?.trim();
      if (value && HARD_SHADOW_RE.test(value)) return true;
    }
  }
  return false;
}

/**
 * A kit that expresses no elevation at all — every ramp step is `none`
 * (`flat-design`). Under such a kit `shadow-3` is a valid token name that
 * resolves to nothing, so "two elevation strategies stacked" is the wrong thing
 * to say: there is one border and one no-op. Measured on a probe screen.
 */
export function usesNoElevation(tokens: DesignKitTokens): boolean {
  for (const set of [tokens.light, tokens.dark]) {
    if (!set) continue;
    const steps = ['shadow-2', 'shadow-3', 'shadow-4'].map((k) => set[k]?.trim().toLowerCase());
    const declared = steps.filter((v) => v !== undefined);
    if (declared.length > 0 && declared.every((v) => v === 'none')) return true;
  }
  return false;
}

/**
 * A project that redefines the STOCK shadow utilities (`--shadow-sm`… in an
 * `@theme` block — what the capture pipeline records as raw markers) makes
 * `shadow-lg` & co. resolve to the project's own ramp: flagging them as
 * "stock Tailwind elevation" fights the project's own system. Kit bases never
 * define the stock names (kits use `shadow-1…shadow-4`), so the presence of
 * any stock name in the token values marks a remap. Read from token values —
 * no kit id, tag list, or file walk needed.
 */
export function remapsStockElevation(tokens: DesignKitTokens): boolean {
  const STOCK_SHADOWS = [
    'shadow-2xs',
    'shadow-xs',
    'shadow-sm',
    'shadow-md',
    'shadow-lg',
    'shadow-xl',
    'shadow-2xl',
  ];
  for (const set of [tokens.light, tokens.dark]) {
    if (!set) continue;
    for (const name of STOCK_SHADOWS) {
      if (set[name] !== undefined) return true;
    }
  }
  return false;
}
