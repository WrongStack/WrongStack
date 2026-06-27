/**
 * Heuristic adherence check: does generated UI code actually use the active
 * kit's palette, or did the model drift to off-palette hardcoded colors?
 *
 * Pure over file contents (the tool does the globbing/reading). For each file it
 * scans color literals (`#hex`, `oklch()`, `rgb()`) and generic Tailwind color
 * utilities (`bg-blue-500`), then flags any that don't resolve to a kit token
 * (directly, or via the materialized CSS var / Tailwind token name). It can't
 * prove adherence — it surfaces likely drift to steer a correction pass.
 */

import { colorToHex, isColorToken } from './design-color.js';
import type { DesignKitTokens } from '../types/design-kit.js';

export interface DesignViolation {
  file: string;
  line: number;
  snippet: string;
  reason: string;
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
}

const HEX_RE = /#[0-9a-fA-F]{3,8}\b/g;
const FUNC_COLOR_RE = /\b(?:oklch|rgb|rgba|hsl|hsla)\([^)]*\)/gi;
// Generic Tailwind palette utilities (bg-/text-/border-/ring-/from-/to-/via- + named scale).
const TW_GENERIC_RE =
  /\b(?:bg|text|border|ring|from|to|via|fill|stroke|decoration|outline|shadow|accent|caret|divide)-(?:slate|gray|grey|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|100|200|300|400|500|600|700|800|900|950)\b/g;

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

  const violations: DesignViolation[] = [];
  let onPalette = 0;
  let offPalette = 0;

  for (const { path, text } of files) {
    const lines = text.split('\n');
    lines.forEach((lineText, i) => {
      const lineNo = i + 1;
      const flag = (snippet: string, reason: string) => {
        violations.push({ file: path, line: lineNo, snippet: snippet.slice(0, 80), reason });
      };

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
            flag(lit, 'off-palette hardcoded color (not a kit token)');
          }
          // non-color funcs (e.g. transform) silently ignored — hex null
        }
      }

      // Generic Tailwind palette utilities → drift.
      TW_GENERIC_RE.lastIndex = 0;
      for (const m of lineText.matchAll(TW_GENERIC_RE)) {
        offPalette++;
        flag(m[0], 'generic Tailwind palette utility — use kit token colors');
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
  };
}
