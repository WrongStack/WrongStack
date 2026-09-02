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

import type { DesignKitTokens } from '../types/design-kit.js';
import { colorToHex, isColorToken } from './design-color.js';

/** Which design axis a violation belongs to. */
export type DesignAxis = 'color' | 'radius' | 'spacing' | 'type' | 'motion';

export interface DesignViolation {
  file: string;
  line: number;
  snippet: string;
  reason: string;
  /** The design axis this drift belongs to. Defaults to 'color' (legacy). */
  axis?: DesignAxis;
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
      const flag = (snippet: string, reason: string, axis: DesignAxis = 'color') => {
        violations.push({ file: path, line: lineNo, snippet: snippet.slice(0, 80), reason, axis });
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

      // ── Non-color axes: radius / spacing bypass ──────────────────────────
      // These push violations but do NOT affect the color `score` (which stays
      // a pure palette-adherence ratio); consumers break down by `axis`.
      ARBITRARY_RADIUS_RE.lastIndex = 0;
      for (const m of lineText.matchAll(ARBITRARY_RADIUS_RE)) {
        flag(
          m[0],
          'arbitrary radius — use a kit radius scale token (rounded-sm…rounded-full)',
          'radius',
        );
      }
      ARBITRARY_SPACING_RE.lastIndex = 0;
      for (const m of lineText.matchAll(ARBITRARY_SPACING_RE)) {
        flag(m[0], 'arbitrary spacing — use a kit spacing scale token (p-1…p-12)', 'spacing');
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
        );
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

// ── Project-level verify (node IO) ───────────────────────────────────────────

const UI_EXT_RE = /\.(css|scss|sass|less|tsx|jsx|vue|svelte|astro|html?)$/i;
const SKIP_DIR = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'out',
  'coverage',
  '.wrongstack',
  '.design',
]);

/** Bounded recursive walk for frontend files under a project root. */
async function walkUiFiles(root: string, max = 200): Promise<string[]> {
  const { default: fs } = await import('node:fs/promises');
  const { default: nodePath } = await import('node:path');
  const found: string[] = [];
  async function rec(dir: string, depth: number): Promise<void> {
    if (found.length >= max || depth > 8) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = (await fs.readdir(dir, { withFileTypes: true })) as import('node:fs').Dirent[];
    } catch {
      return;
    }
    for (const e of entries) {
      if (found.length >= max) return;
      if (e.isDirectory()) {
        if (SKIP_DIR.has(e.name) || e.name.startsWith('.')) continue;
        await rec(nodePath.join(dir, e.name), depth + 1);
      } else if (UI_EXT_RE.test(e.name)) {
        found.push(nodePath.join(dir, e.name));
      }
    }
  }
  await rec(root, 0);
  return found;
}

/**
 * Resolve + read UI files (explicit list, or a bounded walk) and verify them
 * against a kit's tokens. Shared by the `design` tool and the WebUI handler so
 * the file-collection rules stay identical.
 */
export async function runDesignVerify(
  projectRoot: string,
  tokens: DesignKitTokens,
  explicitFiles?: string[] | undefined,
): Promise<DesignVerifyReport> {
  const { default: fs } = await import('node:fs/promises');
  const { default: nodePath } = await import('node:path');
  const abs =
    explicitFiles && explicitFiles.length > 0
      ? explicitFiles.map((f) => (nodePath.isAbsolute(f) ? f : nodePath.join(projectRoot, f)))
      : await walkUiFiles(projectRoot);
  const files: { path: string; text: string }[] = [];
  for (const a of abs) {
    try {
      files.push({ path: nodePath.relative(projectRoot, a), text: await fs.readFile(a, 'utf8') });
    } catch {
      // unreadable — skip
    }
  }
  return verifyFiles(tokens, files);
}
