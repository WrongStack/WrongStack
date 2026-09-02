/**
 * Materialize a design kit's tokens into a real, stack-appropriate theme file.
 *
 * This is what turns Design Studio from "the model SHOULD use these colors" into
 * "these colors ARE the source of truth in the codebase": the generated file is
 * committed and imported, so the kit's palette is enforced by the build, not by
 * a prompt. CSS keeps OKLCH verbatim (native); native stacks get sRGB hex/float
 * via `oklchToHex`.
 *
 * Pure: no disk access — returns `{ path, content }`. Callers (the `design`
 * tool, `/design materialize`, the WebUI button) decide how/where to write.
 */

import type { DesignKitTokens, DesignStack } from '../types/design-kit.js';
import { classifyTokenValue, colorToHex, isColorToken } from './design-color.js';

// ── Scale-token axis mapping ─────────────────────────────────────────────────

/** Kebab prefixes that mark a token as belonging to a tunable scale axis. */
const SCALE_PREFIXES = [
  'radius-',
  'space-',
  'text-',
  'leading-',
  'weight-',
  'tracking-',
  'shadow-',
  'border-',
  'duration-',
  'ease-',
  'font-',
] as const;

/** True when a token name is one of the kebab-scale axis tokens (radius-md …). */
function isScaleToken(name: string): boolean {
  return SCALE_PREFIXES.some((p) => name.startsWith(p) && name.length > p.length);
}

/**
 * Map a scale token name to its Tailwind v4 `@theme` variable, so utilities
 * resolve to the kit: `rounded-md` (`--radius-*`), `p-4` (`--spacing-*`),
 * `text-base` (`--text-*`), `font-medium` (`--font-weight-*`), `shadow-2`
 * (`--shadow-*`), `ease-standard` (`--ease-*`), `font-sans` (`--font-*`).
 * Tokens without a utility namespace (`border-*`, `duration-*`) still emit a
 * valid, referenceable variable.
 */
function themeVar(name: string): string {
  if (name.startsWith('space-')) return `--spacing-${name.slice('space-'.length)}`;
  if (name.startsWith('weight-')) return `--font-weight-${name.slice('weight-'.length)}`;
  return `--${name}`;
}

/**
 * Convert a `rem`/`px`/unitless length (or `ms`/`s` duration) to a plain number
 * for native stacks (rem → px at 16px base; s → ms). Returns null for values we
 * can't reduce to a scalar (e.g. `cubic-bezier(...)`, font stacks).
 */
function toNativeNumber(value: string): number | null {
  const v = value.trim();
  let m = /^(-?\d*\.?\d+)rem$/i.exec(v);
  if (m) return Math.round(Number.parseFloat(m[1]!) * 16 * 1000) / 1000;
  m = /^(-?\d*\.?\d+)px$/i.exec(v);
  if (m) return Number.parseFloat(m[1]!);
  m = /^(-?\d*\.?\d+)s$/i.exec(v);
  if (m) return Math.round(Number.parseFloat(m[1]!) * 1000);
  m = /^(-?\d*\.?\d+)ms$/i.exec(v);
  if (m) return Number.parseFloat(m[1]!);
  m = /^-?\d*\.?\d+$/.exec(v);
  if (m) return Number.parseFloat(v);
  return null;
}

/** Native scale constants: name → numeric value, from non-color scalar tokens. */
function scaleNumbers(set: Record<string, string>): [string, number][] {
  const out: [string, number][] = [];
  for (const [k, v] of Object.entries(set)) {
    if (isColorToken(v)) continue;
    const kind = classifyTokenValue(v);
    if (kind !== 'length' && kind !== 'duration' && kind !== 'number') continue;
    const n = toNativeNumber(v);
    if (n !== null) out.push([k, n]);
  }
  return out;
}

export interface MaterializeResult {
  /** Suggested project-relative path. */
  path: string;
  /** File contents. */
  content: string;
  /** Human label for the format. */
  format: string;
}

/** Conventional default output path per stack. */
const DEFAULT_PATHS: Record<DesignStack, string> = {
  web: 'src/styles/design-tokens.css',
  'react-native': 'src/theme/design-tokens.ts',
  flutter: 'lib/theme/design_tokens.dart',
  swiftui: 'Theme/DesignTokens.swift',
  compose: 'ui/theme/DesignTokens.kt',
};

function splitColors(set: Record<string, string>): {
  colors: [string, string][];
  others: [string, string][];
} {
  const colors: [string, string][] = [];
  const others: [string, string][] = [];
  for (const [k, v] of Object.entries(set)) {
    (isColorToken(v) ? colors : others).push([k, v]);
  }
  return { colors, others };
}

/** camelCase / kebab → kebab-case for CSS var names. */
function kebab(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/_/g, '-')
    .toLowerCase();
}

/** PascalCase for Swift/Kotlin identifiers. */
function pascal(name: string): string {
  return name.replace(/(^|[-_])([a-z0-9])/g, (_, __, c: string) => c.toUpperCase());
}

/** camelCase for Dart/Swift identifiers (radius-md → radiusMd). */
function camel(name: string): string {
  const p = pascal(name);
  return p.charAt(0).toLowerCase() + p.slice(1);
}

/** hex `#rrggbb[aa]` → { r,g,b,a } as 0..1 floats. */
function hexToRgbFloat(hex: string): { r: number; g: number; b: number; a: number } {
  const h = hex.replace('#', '');
  const r = Number.parseInt(h.slice(0, 2), 16) / 255;
  const g = Number.parseInt(h.slice(2, 4), 16) / 255;
  const b = Number.parseInt(h.slice(4, 6), 16) / 255;
  const a = h.length >= 8 ? Number.parseInt(h.slice(6, 8), 16) / 255 : 1;
  return { r, g, b, a };
}

/** hex `#rrggbb[aa]` → Android/Compose `0xAARRGGBB` literal. */
function hexToArgb(hex: string): string {
  const h = hex.replace('#', '');
  const aa = h.length >= 8 ? h.slice(6, 8) : 'ff';
  return `0x${(aa + h.slice(0, 6)).toUpperCase()}`;
}

function genWebCss(tokens: DesignKitTokens, kitId: string): string {
  const light = tokens.light ?? {};
  const dark = tokens.dark ?? {};

  // Semantic raw vars (colors, legacy `radius`/`fontSans`/`shadow`, misc) flip
  // via `:root`/`.dark`. Kebab-scale tokens (radius-md, space-4, shadow-2…) are
  // handled separately below so they map onto Tailwind v4's `@theme` namespaces
  // and drive real utilities — this is what makes `rounded-lg` / `p-4` /
  // `text-base` / `shadow-2` resolve to the kit.
  const rawVars = (set: Record<string, string>) =>
    Object.entries(set)
      .filter(([k]) => !isScaleToken(k))
      .map(([k, v]) => `  --${kebab(k)}: ${v};`)
      .join('\n');

  // Colors → `@theme inline` so `bg-bg`, `text-fg`, `border-border` resolve to
  // the raw vars (which flip in `.dark`).
  const colorKeys = Object.keys(light).filter(
    (k) => !isScaleToken(k) && isColorToken(light[k] ?? ''),
  );
  const colorMap = colorKeys.map((k) => `  --color-${kebab(k)}: var(--${kebab(k)});`).join('\n');

  // Scales → `@theme` (namespace-mapped, literal light values). Non-inline
  // `@theme` vars are referenced by the generated utilities, so a `.dark`
  // override of the same var (e.g. shadows) flips them for dark mode.
  const scaleKeys = Object.keys(light).filter(isScaleToken);
  const scaleTheme = scaleKeys.map((k) => `  ${themeVar(k)}: ${light[k]};`).join('\n');
  const scaleDark = scaleKeys
    .filter((k) => dark[k] !== undefined && dark[k] !== light[k])
    .map((k) => `  ${themeVar(k)}: ${dark[k]};`)
    .join('\n');

  const blocks = [
    `/* Design tokens — kit "${kitId}". Generated by WrongStack Design Studio.
   Edit the kit or run \`design materialize\` again to regenerate. */`,
    `:root {\n${rawVars(light)}\n}`,
    `.dark {\n${rawVars(dark)}\n}`,
  ];
  if (colorMap) blocks.push(`@theme inline {\n${colorMap}\n}`);
  if (scaleTheme) blocks.push(`@theme {\n${scaleTheme}\n}`);
  if (scaleDark) blocks.push(`.dark {\n${scaleDark}\n}`);
  return `${blocks.join('\n\n')}\n`;
}

function genTsTheme(tokens: DesignKitTokens, kitId: string): string {
  // Colors + legacy/misc tokens stay in the per-theme objects (colors → hex);
  // kebab-scale tokens move to a theme-agnostic numeric `scale` export (rem→px
  // at 16px, s→ms) so React Native can consume radius/spacing/type directly.
  const conv = (set: Record<string, string>) =>
    Object.entries(set)
      .filter(([k]) => !isScaleToken(k))
      .map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(colorToHex(v) ?? v)},`)
      .join('\n');
  const scaleBlock = scaleNumbers(tokens.light ?? {})
    .map(([k, n]) => `  ${JSON.stringify(camel(k))}: ${n},`)
    .join('\n');
  return `// Design tokens — kit "${kitId}". Generated by WrongStack Design Studio.
// Colors are converted to sRGB hex (React Native does not parse oklch()).
// \`scale\` holds numeric radius/spacing/type/motion (px; durations in ms).

export const lightTheme = {
${conv(tokens.light ?? {})}
} as const;

export const darkTheme = {
${conv(tokens.dark ?? {})}
} as const;

export const scale = {
${scaleBlock}
} as const;

export type ThemeTokens = typeof lightTheme;
`;
}

function genDart(tokens: DesignKitTokens, kitId: string): string {
  const cls = (name: string, set: Record<string, string>) => {
    const { colors } = splitColors(set);
    const fields = colors
      .map(([k, v]) => {
        const hex = colorToHex(v);
        return hex ? `  static const Color ${k} = Color(${hexToArgb(hex)});` : '';
      })
      .filter(Boolean)
      .join('\n');
    return `class ${name} {\n${fields}\n}`;
  };
  const scaleFields = scaleNumbers(tokens.light ?? {})
    .map(([k, n]) => `  static const double ${camel(k)} = ${n};`)
    .join('\n');
  return `// Design tokens — kit "${kitId}". Generated by WrongStack Design Studio.
// AppScale holds radius/spacing/type/motion (logical px; durations in ms).
import 'package:flutter/material.dart';

${cls('AppColorsLight', tokens.light ?? {})}

${cls('AppColorsDark', tokens.dark ?? {})}

class AppScale {
${scaleFields}
}
`;
}

function genSwift(tokens: DesignKitTokens, kitId: string): string {
  const ext = (name: string, set: Record<string, string>) => {
    const { colors } = splitColors(set);
    const fields = colors
      .map(([k, v]) => {
        const hex = colorToHex(v);
        if (!hex) return '';
        const { r, g, b, a } = hexToRgbFloat(hex);
        return `    static let ${k} = Color(red: ${r.toFixed(4)}, green: ${g.toFixed(4)}, blue: ${b.toFixed(4)}, opacity: ${a.toFixed(4)})`;
      })
      .filter(Boolean)
      .join('\n');
    return `enum ${name} {\n${fields}\n}`;
  };
  const scaleFields = scaleNumbers(tokens.light ?? {})
    .map(([k, n]) => `    static let ${camel(k)}: CGFloat = ${n}`)
    .join('\n');
  return `// Design tokens — kit "${kitId}". Generated by WrongStack Design Studio.
// AppScale holds radius/spacing/type/motion (points; durations in ms).
import SwiftUI

${ext('AppColorsLight', tokens.light ?? {})}

${ext('AppColorsDark', tokens.dark ?? {})}

enum AppScale {
${scaleFields}
}
`;
}

function genKotlin(tokens: DesignKitTokens, kitId: string): string {
  const obj = (name: string, set: Record<string, string>) => {
    const { colors } = splitColors(set);
    const fields = colors
      .map(([k, v]) => {
        const hex = colorToHex(v);
        return hex ? `    val ${pascal(k)} = Color(${hexToArgb(hex)})` : '';
      })
      .filter(Boolean)
      .join('\n');
    return `object ${name} {\n${fields}\n}`;
  };
  const scaleFields = scaleNumbers(tokens.light ?? {})
    .map(([k, n]) => `    val ${pascal(k)} = ${n}f`)
    .join('\n');
  return `// Design tokens — kit "${kitId}". Generated by WrongStack Design Studio.
// AppScale holds radius/spacing/type/motion (dp/sp as Float; durations in ms).
import androidx.compose.ui.graphics.Color

${obj('AppColorsLight', tokens.light ?? {})}

${obj('AppColorsDark', tokens.dark ?? {})}

object AppScale {
${scaleFields}
}
`;
}

/**
 * Generate a stack-appropriate theme file from a kit's (override-applied) tokens.
 * `outPath` overrides the conventional default path.
 */
export function materializeTokens(opts: {
  tokens: DesignKitTokens;
  stack: DesignStack;
  kitId: string;
  outPath?: string | undefined;
}): MaterializeResult {
  const { tokens, stack, kitId } = opts;
  let content: string;
  let format: string;
  switch (stack) {
    case 'react-native':
      content = genTsTheme(tokens, kitId);
      format = 'TypeScript theme (hex)';
      break;
    case 'flutter':
      content = genDart(tokens, kitId);
      format = 'Dart ColorScheme constants';
      break;
    case 'swiftui':
      content = genSwift(tokens, kitId);
      format = 'SwiftUI Color constants';
      break;
    case 'compose':
      content = genKotlin(tokens, kitId);
      format = 'Compose Color constants';
      break;
    default:
      content = genWebCss(tokens, kitId);
      format = 'CSS variables + Tailwind v4 @theme (OKLCH)';
      break;
  }
  return { path: opts.outPath?.trim() || DEFAULT_PATHS[stack], content, format };
}

/**
 * Resolve a `materializeTokens` result path to an absolute destination pinned
 * inside `projectRoot`, or throw if it would escape.
 *
 * WS-021/052: `materializeTokens` returns `outPath` verbatim, and each caller
 * was responsible for containing it. The LLM-tool path in
 * `packages/tools/src/design.ts` was hardened for issue #249; the WebSocket
 * handler (`design.materialize`) and the two slash-command paths were not — so
 * a payload-supplied `out` of `../../../.wrongstack/profiles/default/config.json`
 * reached `fs.writeFile` unchecked. One shared resolver so a fix cannot land on
 * one of three sites again.
 *
 * Symlinks are resolved before the check (a `/tmp` that is really
 * `/private/tmp`, a bind mount, or an attacker-planted link would otherwise
 * smuggle a path past a plain prefix test). The destination usually does not
 * exist yet, so the parent is realpath'd and the basename re-joined.
 *
 * On Windows `path.join(absoluteA, absoluteB)` concatenates literally rather
 * than collapsing onto the drive root, so an absolute result path is treated as
 * absolute instead of as a join input — matching the tools-side behaviour.
 */
export async function resolveMaterializeTarget(
  resultPath: string,
  projectRoot: string,
): Promise<string> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');

  const resolveReal = async (p: string): Promise<string> => {
    const resolved = path.resolve(p);
    let probe = resolved;
    const missing: string[] = [];
    for (;;) {
      try {
        return path.resolve(await fs.realpath(probe), ...missing);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          const parent = path.dirname(probe);
          if (parent === probe) return resolved;
          missing.unshift(path.basename(probe));
          probe = parent;
          continue;
        }
        return resolved;
      }
    }
  };

  const root = await resolveReal(projectRoot);
  const absResolved = path.isAbsolute(resultPath)
    ? path.resolve(resultPath)
    : path.resolve(path.join(projectRoot, resultPath));
  const absParent = await resolveReal(path.dirname(absResolved));
  const abs = path.join(absParent, path.basename(absResolved));
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`design: materialize path "${resultPath}" would escape the project root`);
  }
  return abs;
}
