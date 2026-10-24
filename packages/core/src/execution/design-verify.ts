/**
 * Heuristic adherence check: does generated UI code actually use the active
 * kit's palette, or did the model drift to off-palette hardcoded colors?
 *
 * `verifyFiles` is pure over file contents; `runDesignVerify` adds the node-side
 * file collection (explicit list or a bounded UI-file walk) so the `design` tool
 * and the WebUI handler share identical rules. For each file it scans color
 * literals (`#hex`, `oklch()`, `rgb()`) and generic Tailwind color utilities
 * (`bg-blue-500`), then flags any that don't resolve to a kit token (directly or
 * via the materialized CSS var / token name). It can't prove adherence — it
 * surfaces likely drift to steer a correction pass.
 */

import type { DesignKitTokens } from '@wrongstack/contracts/types/design-kit';
import { colorToHex, contrastRatio, isColorToken } from './design-color.js';
import {
  type DesignSeverity,
  FILE_RULES,
  isWaived,
  LINE_RULES,
  parseWaivers,
  remapsStockElevation,
  ruleContext,
  usesHardShadows,
  usesNoElevation,
} from './design-verify-rules.js';

/**
 * Which design axis a violation belongs to.
 *
 * `composition` is the taste axis: patterns that pass every token check and
 * still read as generated-by-default UI (gradient-filled headings, stock
 * elevation, emoji standing in for icons, four identical centered sections,
 * marketing filler copy). Token adherence and taste are independent failures —
 * a screen can score 100% on-palette and still be slop.
 */
export type DesignAxis = 'color' | 'radius' | 'spacing' | 'type' | 'motion' | 'composition';

export interface DesignViolation {
  file: string;
  line: number;
  snippet: string;
  reason: string;
  /** The design axis this drift belongs to. Defaults to 'color' (legacy). */
  axis?: DesignAxis;
  /** Stable rule id (see design-verify-rules.ts); waivers name it. */
  id?: string;
  /** FAIL = definite accessibility defect; WARN = fix or defend. */
  severity?: DesignSeverity;
}

export interface DesignVerifyReport {
  filesScanned: number;
  /** Normalized kit palette (hex). */
  palette: string[];
  /** Kit color token names (for var/utility matching). */
  tokenNames: string[];
  violations: DesignViolation[];
  /** 0..1 — share of color signals that are on-palette. 1 when no signals. */
  score: number;
  ok: boolean;
  /**
   * Files that carried no class attribute and no color literal at all — the
   * scanner had nothing to read in them.
   *
   * This is not a detail: a react-native / flutter / swiftui / compose screen
   * expresses the kit as theme constants and a numeric scale, so it scores a
   * clean 100% no matter what it looks like. Without this count, "0 violations"
   * on a native stack silently reads as "clean" when it means "not checked".
   */
  filesWithNoSignal: number;
}

// ── WCAG AA token-pair gate ──────────────────────────────────────────────────

/** A readable-text pair whose contrast falls below the WCAG floor. */
export interface KitContrastIssue {
  theme: 'light' | 'dark';
  /** The failing pair: 'fg/bg' (body text) or 'primary/bg' (primary action). */
  pair: string;
  ratio: number;
}

/** The pairs the gate checks — body copy and the primary action on `bg`. */
const CONTRAST_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['fg', 'bg'],
  ['primary', 'bg'],
];

/**
 * Check a kit's (override-applied) token pairs against the WCAG 2.x AA floor
 * (4.5:1) for BOTH themes. Pure; unparseable tokens are skipped — the bundled
 * corpus contract guards their parseability separately. The `design` tool runs
 * this at use/materialize time so a contrast-breaking override is named before
 * it ships, and the WebUI gallery can reuse it the same way.
 */
export function kitContrastIssues(tokens: DesignKitTokens, floor = 4.5): KitContrastIssue[] {
  const issues: KitContrastIssue[] = [];
  for (const theme of ['light', 'dark'] as const) {
    const set = tokens[theme];
    if (!set) continue;
    for (const [a, b] of CONTRAST_PAIRS) {
      const ratio = contrastRatio(set[a] ?? '', set[b] ?? '');
      if (ratio !== null && ratio < floor) {
        issues.push({ theme, pair: `${a}/${b}`, ratio });
      }
    }
  }
  return issues;
}

const HEX_RE = /#[0-9a-fA-F]{3,8}\b/g;
const FUNC_COLOR_RE = /\b(?:oklch|rgb|rgba|hsl|hsla)\([^)]*\)/gi;
// Arbitrary-value Tailwind utilities BYPASS the token scale — a strong drift
// signal regardless of the exact value. Radius: `rounded-[7px]`. Spacing:
// `p-[13px]`, `mt-[5px]`, `gap-[10px]`. Utilities like `rounded-lg` / `p-4`
// resolve to the kit's `@theme` scale, so they are NOT flagged.
const ARBITRARY_RADIUS_RE = /\brounded(?:-[a-z]+)?-\[[^\]]+\]/g;
const ARBITRARY_SPACING_RE =
  /\b(?:p|px|py|pt|pr|pb|pl|m|mx|my|mt|mr|mb|ml|gap(?:-[xy])?|space-[xy])-\[[^\]]+\]/g;
// Raw hardcoded `border-radius:` length (CSS/inline style) that isn't a token
// var or a trivial value (0, 50%, 9999px, full-round).
const RAW_RADIUS_RE = /border-radius:\s*([^;{}]+)/gi;
// Generic Tailwind palette utilities (bg-/text-/border-/ring-/from-/to-/via- + named scale).
const TW_GENERIC_RE =
  /\b(?:bg|text|border|ring|from|to|via|fill|stroke|decoration|outline|shadow|accent|caret|divide)-(?:slate|gray|grey|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|100|200|300|400|500|600|700|800|900|950)\b/g;

// ── Composition ("slop") signals ─────────────────────────────────────────────
// These source signals can run without knowing which kit is pinned. They are
// prompts for contextual review, not proof of visual failure. Kit-sanctioned looks (glass panels
// under `soft-glass`, aurora washes under `aurora-gradient`) are deliberately
// NOT encoded here — judging those needs the kit body, which is the
// `design-critique` skill's job, not a regex's.

/** `bg-clip-text` + `text-transparent` — gradient-filled headline. */
const GRADIENT_TEXT_CLIP_RE = /\bbg-clip-text\b/;
const GRADIENT_TEXT_FILL_RE = /\btext-transparent\b/;
/** Stock Tailwind elevation instead of the kit's `shadow-1…shadow-4` ramp. */
const TW_ELEVATION_RE = /\bshadow-(?:sm|md|lg|xl|2xl)\b/g;
/** Hardcoded font family (CSS declaration or arbitrary Tailwind value). */
const FONT_DECL_RE = /font-family:\s*([^;{}]+)/gi;
const TW_FONT_ARBITRARY_RE = /\bfont-\[[^\]]+\]/g;
/** Placeholder / launch-copy boilerplate that ships as if it were product copy. */
const FILLER_COPY_RE =
  /(lorem ipsum|seamlessly integrat\w*|unlock the (?:power|potential)|to the next level|game[-\s]?chang\w+|revolutioniz\w+|cutting[-\s]?edge|elevate your|supercharge your|transform the way you)/gi;
/**
 * An emoji sitting where an icon belongs (first child of a heading/control).
 *
 * Deliberately narrowed to the pictographic planes. An earlier draft also swept
 * U+2190–U+27BF and caught `→ ← ↵ ▸ ◀ ✗ ⚠ ★ ● ≈` plus `⌘K` across a real dense
 * operator UI — those are typographic symbols doing legitimate work, not emoji
 * standing in for an icon set. A pictograph that is explicitly decorative
 * (`aria-hidden`) is also exempt; it is already handled correctly.
 */
const EMOJI_ICON_RE =
  /<(?:h[1-6]|button|li|a|span|p|div)\b[^>]*>\s*\{?\s*['"`]?\s*([\u{1F300}-\u{1FAFF}])/gu;
/** File-level monotony signals. */
const TEXT_CENTER_RE = /\btext-center\b/g;
const SECTION_TAG_RE = /<section\b/g;
const CLASS_ATTR_RE = /(?:className|class)=["']([^"']{40,})["']/g;
/**
 * A repeated class string only counts as a repeated *block* when it describes a
 * container. Without this, a long label class (`text-[11px] uppercase
 * text-muted-foreground`) reused on four dropdown labels reads as a copy-pasted
 * card grid, which it is not — measured against a real 404-file UI.
 */
const CONTAINER_CLASS_RE = /\b(?:rounded|border|bg-|p-|px-|py-|grid|flex)/;
/**
 * A line that is entirely a comment — JS/TS line comment, block-comment body,
 * or a CSS comment opener. Scanning those produces findings about prose rather
 * than about markup: a doc-comment naming `shadow-sm` was itself reported as
 * stock elevation during a real run.
 */
/**
 * Mark every line that is entirely a comment.
 *
 * A single line regex was not enough, and the gap was found by dogfooding: JSX
 * comments open with `{/*`, which `^\s*\/\*` never matches, so every
 * `{/* … *␣/}` in a React file was scanned as markup. Multi-line block comments
 * leaked for the same reason — their middle lines match no opener pattern, they
 * need state. Measured after the fix: across 1079 React/TUI files it removes 12
 * false findings, most of them hex-shaped text like `= #121318` or `issue #323`.
 *
 * Exported because measurement must use the same rule as enforcement. Auditing
 * a screen, a plain `grep -c "gap-px"` reported a utility that was not there —
 * the only match was a comment saying it had been removed. Any script that
 * counts design patterns should import this rather than re-derive it; a second
 * copy drifts from this one silently.
 *
 * A trailing comment on a line of real code is deliberately NOT stripped: the
 * code on that line is still code, and loosening it would blind the scan to
 * `<div className="shadow-lg"> {/* ok *␣/}`.
 */
export function markCommentLines(lines: string[]): boolean[] {
  const flags: boolean[] = [];
  let inBlock = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (inBlock) {
      flags.push(true);
      if (line.includes('*/')) inBlock = false;
      continue;
    }
    if (line.startsWith('//')) {
      flags.push(true);
      continue;
    }
    const opensBlock = line.startsWith('/*') || line.startsWith('{/*');
    if (opensBlock || line.startsWith('*')) {
      flags.push(true);
      if (opensBlock && !line.includes('*/')) inBlock = true;
      continue;
    }
    flags.push(false);
  }
  return flags;
}
/**
 * Pure black / pure white surfaces. `TW_GENERIC_RE` lists only the named
 * scales, so these slipped through — and they are the most untuned default of
 * all: every kit's neutrals carry a little chroma, and `bg-white` next to them
 * reads dead.
 */
const ABSOLUTE_COLOR_RE = /\b(?:bg|text|border|ring|fill|stroke|divide)-(?:white|black)\b/g;
/** Any class attribute on one line — no length floor, unlike `CLASS_ATTR_RE`. */
const CLASS_ATTR_LINE_RE = /(?:className|class)=["']([^"']+)["']/g;
/** Caps at default tracking read as a mistake; caps need opened letter-spacing. */
const UPPERCASE_RE = /\buppercase\b/;
const TRACKING_RE = /\btracking-/;
/**
 * A border AND a heavy kit elevation on one surface = two elevation strategies
 * at once. Scoped to the kit ramp (`shadow-2`…`shadow-4`) on purpose: stock
 * Tailwind shadows are already reported by `TW_ELEVATION_RE`, and flagging them
 * twice would just be noise.
 */
const KIT_ELEVATION_RE = /\bshadow-[2-4]\b/;
const BORDER_UTILITY_RE = /\bborder(?:-[trblxy])?\b/;
/**
 * Anything the scanner can actually read. A file with none of these was not
 * checked, however clean its result looks — see `filesWithNoSignal`.
 */
const SCANNABLE_SIGNAL_RE = /className=|class=|#[0-9a-fA-F]{3,8}\b|oklch\(|rgba?\(|hsla?\(/;
/** Control labels that name the mechanism instead of the action. */
const GENERIC_LABEL_RE = />\s*(Submit|Click here)\s*</g;
/**
 * An empty state that says nothing. Matches only when the generic phrase is the
 * WHOLE label — "No data available for this range, try widening it" is a good
 * empty state and must not be flagged.
 */
const EMPTY_STATE_FILLER_RE =
  />\s*(No data(?: available)?|No items|Nothing here|No results(?: found)?|No records)\s*<|["'](No data(?: available)?|No items|Nothing here|No results(?: found)?|No records)["']/gi;
/** How many centered sections / identical blocks before it reads as a template. */
const CENTERED_SECTION_LIMIT = 4;
const REPEATED_BLOCK_LIMIT = 4;

function kebab(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/_/g, '-')
    .toLowerCase();
}

function buildPalette(tokens: DesignKitTokens): { hexes: Set<string>; names: string[] } {
  const hexes = new Set<string>();
  const names = new Set<string>();
  for (const set of [tokens.light, tokens.dark]) {
    if (!set) continue;
    for (const [k, v] of Object.entries(set)) {
      if (!isColorToken(v)) continue;
      names.add(k);
      const hex = colorToHex(v);
      if (hex) hexes.add(hex.toLowerCase().slice(0, 7)); // ignore alpha for matching
    }
  }
  return { hexes, names: [...names] };
}

/**
 * Verify a batch of file contents against a kit's (override-applied) tokens.
 */
export function verifyFiles(
  tokens: DesignKitTokens,
  files: { path: string; text: string }[],
): DesignVerifyReport {
  const { hexes, names } = buildPalette(tokens);
  // Files that reference token names via CSS var / Tailwind token utility are
  // "token-driven" — we don't flag their literal-free color usage.
  const tokenNamePatterns = names.map((n) => kebab(n));
  // Kits whose elevation ramp is a hard stamped offset sanction border+shadow.
  const hardShadowKit = usesHardShadows(tokens);
  // Kits with no elevation at all need a different message entirely.
  const noElevationKit = usesNoElevation(tokens);
  // A project that remaps the stock shadow-* utilities via @theme: those
  // utilities are token-driven, so "stock Tailwind elevation" is not drift.
  const stockElevationRemapped = remapsStockElevation(tokens);
  const ruleCtx = ruleContext(tokens);

  const violations: DesignViolation[] = [];
  let onPalette = 0;
  let offPalette = 0;

  let filesWithNoSignal = 0;
  for (const { path, text } of files) {
    const lines = text.split('\n');
    const commentLine = markCommentLines(lines);
    if (!lines.some((line, i) => !commentLine[i] && SCANNABLE_SIGNAL_RE.test(line))) {
      filesWithNoSignal++;
    }
    const waivers = parseWaivers(lines);
    const flagAt = (
      lineNo: number,
      snippet: string,
      reason: string,
      axis: DesignAxis,
      id: string,
      severity: DesignSeverity = 'WARN',
    ) => {
      if (isWaived(waivers, id, lineNo)) return;
      violations.push({
        file: path,
        line: lineNo,
        snippet: snippet.slice(0, 80),
        reason,
        axis,
        id,
        severity,
      });
    };
    lines.forEach((lineText, i) => {
      if (commentLine[i]) return; // prose about the code, not the code
      const lineNo = i + 1;
      const flag = (snippet: string, reason: string, axis: DesignAxis, id: string) =>
        flagAt(lineNo, snippet, reason, axis, id);

      // Hardcoded hex + function colors → on/off palette.
      for (const re of [HEX_RE, FUNC_COLOR_RE]) {
        re.lastIndex = 0;
        for (const m of lineText.matchAll(re)) {
          const lit = m[0];
          const hex = colorToHex(lit);
          if (hex && hexes.has(hex.toLowerCase().slice(0, 7))) {
            onPalette++;
          } else if (hex) {
            offPalette++;
            flag(
              lit,
              'off-palette hardcoded color (not a kit token)',
              'color',
              'color.off-palette',
            );
          }
          // non-color funcs (e.g. transform) silently ignored — hex null
        }
      }

      // Generic Tailwind palette utilities → drift.
      TW_GENERIC_RE.lastIndex = 0;
      for (const m of lineText.matchAll(TW_GENERIC_RE)) {
        offPalette++;
        flag(
          m[0],
          'generic Tailwind palette utility — use kit token colors',
          'color',
          'color.generic-utility',
        );
      }

      // Pure black / white — the same class of drift, missed by the named scales.
      ABSOLUTE_COLOR_RE.lastIndex = 0;
      for (const m of lineText.matchAll(ABSOLUTE_COLOR_RE)) {
        offPalette++;
        flag(
          m[0],
          'pure black/white — use the kit surface + foreground tokens (its neutrals ' +
            'carry chroma; absolute values read untuned beside them)',
          'color',
          'color.absolute',
        );
      }

      // ── Non-color axes: radius / spacing bypass ──────────────────────────
      // These push violations but do NOT affect the color `score` (which stays
      // a pure palette-adherence ratio); consumers break down by `axis`.
      ARBITRARY_RADIUS_RE.lastIndex = 0;
      for (const m of lineText.matchAll(ARBITRARY_RADIUS_RE)) {
        if (/\[var\(--[\w-]+\)\]$/.test(m[0])) continue;
        flag(
          m[0],
          'arbitrary radius — use a kit radius scale token (rounded-sm…rounded-full)',
          'radius',
          'radius.arbitrary',
        );
      }
      ARBITRARY_SPACING_RE.lastIndex = 0;
      for (const m of lineText.matchAll(ARBITRARY_SPACING_RE)) {
        if (/\[var\(--[\w-]+\)\]$/.test(m[0])) continue;
        flag(
          m[0],
          'arbitrary spacing — use a kit spacing scale token (p-1…p-12)',
          'spacing',
          'spacing.arbitrary',
        );
      }
      RAW_RADIUS_RE.lastIndex = 0;
      for (const m of lineText.matchAll(RAW_RADIUS_RE)) {
        const val = (m[1] ?? '').trim();
        if (!val || val.startsWith('var(')) continue;
        if (/^(0|0px|9999px|50%|inherit|initial|unset|full)$/i.test(val)) continue;
        flag(
          `border-radius: ${val}`,
          'hardcoded radius — use var(--radius-*) / a kit radius token',
          'radius',
          'radius.hardcoded',
        );
      }

      // ── Composition axis: token-clean code that still reads as generated ──
      if (GRADIENT_TEXT_CLIP_RE.test(lineText) && GRADIENT_TEXT_FILL_RE.test(lineText)) {
        flag(
          lineText.trim(),
          'gradient-filled text — review readability and hierarchy against the brief; ' +
            'use size/weight/measure when the gradient has no product purpose',
          'composition',
          'composition.gradient-text',
        );
      }
      TW_ELEVATION_RE.lastIndex = 0;
      if (!stockElevationRemapped) {
        for (const m of lineText.matchAll(TW_ELEVATION_RE)) {
          flag(
            m[0],
            "stock Tailwind elevation — use the kit's elevation ramp (shadow-1…shadow-4)",
            'composition',
            'composition.stock-elevation',
          );
        }
      }
      EMOJI_ICON_RE.lastIndex = 0;
      for (const m of lineText.matchAll(EMOJI_ICON_RE)) {
        if (/aria-hidden/.test(m[0])) continue; // explicitly decorative — fine
        flag(
          m[0].trim(),
          'emoji used as UI iconography — use a real icon set (emoji render per-platform ' +
            'and carry no accessible name)',
          'composition',
          'composition.emoji-icon',
        );
      }
      FILLER_COPY_RE.lastIndex = 0;
      for (const m of lineText.matchAll(FILLER_COPY_RE)) {
        flag(
          m[0],
          'filler / launch-copy boilerplate — write copy that says what the product does',
          'composition',
          'copy.filler',
        );
      }
      GENERIC_LABEL_RE.lastIndex = 0;
      for (const m of lineText.matchAll(GENERIC_LABEL_RE)) {
        flag(
          m[0].trim(),
          `"${m[1]}" names the mechanism, not the action — label the control with its ` +
            'verb ("Create workspace")',
          'composition',
          'copy.generic-label',
        );
      }

      EMPTY_STATE_FILLER_RE.lastIndex = 0;
      for (const m of lineText.matchAll(EMPTY_STATE_FILLER_RE)) {
        flag(
          (m[1] ?? m[2] ?? m[0]).trim(),
          'empty state that says nothing — say what belongs here, why it is empty, and ' +
            'the one action that fills it',
          'composition',
          'copy.empty-state',
        );
      }

      // Per-class-attribute craft rules.
      CLASS_ATTR_LINE_RE.lastIndex = 0;
      for (const m of lineText.matchAll(CLASS_ATTR_LINE_RE)) {
        const cls = m[1] ?? '';
        if (UPPERCASE_RE.test(cls) && !TRACKING_RE.test(cls)) {
          flag(
            cls.slice(0, 60),
            'all-caps at default tracking — caps need opened letter-spacing (tracking-wide)',
            'type',
            'type.caps-tracking',
          );
        }
        if (!hardShadowKit && KIT_ELEVATION_RE.test(cls)) {
          if (noElevationKit) {
            flag(
              cls.slice(0, 60),
              "this kit's elevation ramp is `none` — the shadow utility resolves to nothing; " +
                'separate surfaces with a fill difference instead',
              'composition',
              'composition.elevation-none',
            );
          } else if (BORDER_UTILITY_RE.test(cls)) {
            flag(
              cls.slice(0, 60),
              'border and heavy elevation stacked — pick one elevation strategy; if both, ' +
                'the shadow should be near-invisible',
              'composition',
              'composition.border-elevation',
            );
          }
        }
      }
      // Type axis: the kit owns the typeface; a literal family bypasses it.
      TW_FONT_ARBITRARY_RE.lastIndex = 0;
      for (const m of lineText.matchAll(TW_FONT_ARBITRARY_RE)) {
        flag(
          m[0],
          'hardcoded font family — use the kit font tokens (font-sans/display/mono)',
          'type',
          'type.font-arbitrary',
        );
      }
      FONT_DECL_RE.lastIndex = 0;
      for (const m of lineText.matchAll(FONT_DECL_RE)) {
        const val = (m[1] ?? '').trim();
        if (!val || val.includes('var(') || /^(inherit|initial|unset|revert)$/i.test(val)) continue;
        flag(
          `font-family: ${val}`,
          'hardcoded font family — use var(--font-*) / the kit font tokens',
          'type',
          'type.font-family',
        );
      }

      // Catalogue additions (design-verify-rules.ts), next code line as context.
      const next = lines.slice(i + 1).find((l, k) => !commentLine[i + 1 + k] && l.trim()) ?? '';
      for (const rule of LINE_RULES) {
        const hit = rule.match(lineText, next, ruleCtx);
        if (hit) flagAt(lineNo, hit, rule.reason, rule.axis, rule.id, rule.severity);
      }

      // Count token-name usages as on-palette signals (var(--primary), bg-primary…).
      for (const tn of tokenNamePatterns) {
        if (tn.length < 2) continue;
        if (
          lineText.includes(`--${tn}`) ||
          new RegExp(`\\b(?:bg|text|border|ring|fill|stroke)-${tn}\\b`).test(lineText)
        ) {
          onPalette++;
        }
      }
    });

    // ── File-level composition: monotony a per-line scan cannot see ──────────
    // Comment lines are blanked rather than dropped, so the line COUNT — and
    // every line number derived from an offset below — still matches the file.
    const codeLines = lines.map((l, i) => (commentLine[i] ? '' : l));
    const codeText = codeLines.join('\n');
    for (const rule of FILE_RULES) {
      const hit = rule.match(codeLines, ruleCtx);
      if (hit) flagAt(hit.line, hit.snippet, hit.reason, rule.axis, rule.id, rule.severity);
    }
    const centered = [...codeText.matchAll(TEXT_CENTER_RE)].length;
    const sections = [...codeText.matchAll(SECTION_TAG_RE)].length;
    if (centered >= CENTERED_SECTION_LIMIT && sections >= 2) {
      const at = codeLines.findIndex((l) => /\btext-center\b/.test(l));
      flagAt(
        at + 1,
        `text-center ×${centered}`,
        `${centered} centered blocks across ${sections} sections — review content priorities; ` +
          'vary layout when roles differ, and retain consistent alignment when it helps scanning',
        'composition',
        'composition.centered-monotony',
      );
    }
    // Line numbers come from the match offset, not from a substring search.
    // `lines.findIndex((l) => l.includes(cls))` reported the first line merely
    // CONTAINING the class — which is routinely a different, longer class
    // attribute: AnalyticsDashboard's ×6 panel group starts at line 346 but was
    // reported at 149, the StatCard whose class has the group's string as a prefix.
    const lineStarts = [0];
    for (let i = 0; i < codeText.length; i++) {
      if (codeText[i] === '\n') lineStarts.push(i + 1);
    }
    const lineOf = (offset: number): number => {
      let lo = 0;
      let hi = lineStarts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if ((lineStarts[mid] ?? 0) <= offset) lo = mid;
        else hi = mid - 1;
      }
      return lo + 1;
    };
    const blocks = new Map<string, { count: number; firstLine: number }>();
    for (const m of codeText.matchAll(CLASS_ATTR_RE)) {
      const cls = m[1] ?? '';
      const seen = blocks.get(cls);
      if (seen) seen.count++;
      else blocks.set(cls, { count: 1, firstLine: lineOf(m.index ?? 0) });
    }
    for (const [cls, { count, firstLine }] of blocks) {
      if (count < REPEATED_BLOCK_LIMIT) continue;
      if (!CONTAINER_CLASS_RE.test(cls)) continue; // a repeated label is not a repeated block
      flagAt(
        firstLine,
        `${cls.slice(0, 60)} ×${count}`,
        `identical block repeated ${count}× — review whether these items have equal roles. ` +
          'Keep consistent rows/cards for comparable content; vary emphasis only when content priority differs',
        'composition',
        'composition.repeated-block',
      );
    }
  }

  const total = onPalette + offPalette;
  const score = total === 0 ? 1 : onPalette / total;
  return {
    filesScanned: files.length,
    palette: [...hexes],
    tokenNames: names,
    violations,
    score,
    ok: violations.length === 0,
    filesWithNoSignal,
  };
}
