/**
 * Design-token parity: HQ and the project WebUI must render the same product.
 *
 * `packages/webui/src/index.css` is the SINGLE SOURCE OF TRUTH for the palette,
 * typography and geometry tokens. `packages/webui-hq/src/styles/tokens.css` is a
 * verbatim copy of that file's token region, kept as a copy (rather than a
 * cross-package `@import`) so neither Vite build reaches into the other's source
 * tree.
 *
 * This test is the drift guard for that copy. When it fails, the fix is NOT to
 * edit the HQ file by hand: change `packages/webui/src/index.css`, then re-copy
 * its `@theme` + `@layer base` token region into `src/styles/tokens.css`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const HQ_TOKENS = path.resolve(import.meta.dirname, '../src/styles/tokens.css');
const WEBUI_TOKENS = path.resolve(import.meta.dirname, '../../webui/src/index.css');

/** Selector prefixes that carry design tokens. Everything else (component
 * layers, resets, `.ws-*` helpers) is WebUI-only and deliberately not mirrored. */
const TOKEN_SELECTOR = /^(?:@theme|:root|\.dark)/;

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Flatten a stylesheet into `"<selector>|--token"` -> `"value"`.
 *
 * `@layer` wrappers are transparent (they group but do not scope), so the key
 * for `@layer base { :root { --x: 1 } }` is `:root|--x`. `@theme` is a real
 * scope and keeps its own key.
 */
function extractTokenMap(css: string): Map<string, string> {
  const source = stripComments(css);
  const tokens = new Map<string, string>();
  const stack: string[] = [];
  let buffer = '';

  const scope = (): string => stack.filter((entry) => entry.length > 0).join(' ');

  const flushDeclaration = (): void => {
    const declaration = buffer.trim();
    buffer = '';
    if (!declaration.startsWith('--')) return;
    const separator = declaration.indexOf(':');
    if (separator === -1) return;
    const name = declaration.slice(0, separator).trim();
    const value = declaration
      .slice(separator + 1)
      .replace(/\s+/g, ' ')
      .trim();
    const selector = scope();
    if (!TOKEN_SELECTOR.test(selector)) return;
    tokens.set(`${selector}|${name}`, value);
  };

  for (const character of source) {
    if (character === '{') {
      const prelude = buffer.replace(/\s+/g, ' ').trim();
      buffer = '';
      // `@layer` (and any other grouping at-rule) does not scope declarations.
      stack.push(prelude.startsWith('@layer') || prelude.startsWith('@media') ? '' : prelude);
    } else if (character === '}') {
      flushDeclaration();
      stack.pop();
    } else if (character === ';') {
      flushDeclaration();
    } else {
      buffer += character;
    }
  }

  return tokens;
}

describe('HQ ↔ WebUI design-token parity', () => {
  const hq = extractTokenMap(readFileSync(HQ_TOKENS, 'utf8'));
  const webui = extractTokenMap(readFileSync(WEBUI_TOKENS, 'utf8'));

  it('extracts a non-trivial token set from both stylesheets', () => {
    // Guards the parser itself: a regression that made extraction return {}
    // would otherwise make every assertion below vacuously pass.
    expect(hq.size).toBeGreaterThan(100);
    expect(webui.size).toBeGreaterThan(100);
  });

  it('mirrors every WebUI design token, byte for byte', () => {
    const drift = [...webui.entries()]
      .filter(([key, value]) => hq.get(key) !== value)
      .map(([key, value]) => `${key}: webui="${value}" hq="${hq.get(key) ?? '<missing>'}"`);

    expect(drift).toEqual([]);
  });

  it('adds no HQ-only token that the WebUI does not define', () => {
    const extra = [...hq.keys()].filter((key) => !webui.has(key));

    expect(extra).toEqual([]);
  });

  it('carries the brand signals and the zero-radius geometry', () => {
    // Spot-checks so a parser that silently matched nothing still fails loudly.
    expect(hq.get(':root|--primary')).toBe('344.8 74.6% 47.8%');
    expect(hq.get('.dark|--primary')).toBe('345.9 99% 58.8%');
    expect(hq.get(':root|--brand-orange')).toBe('32.1 94.6% 43.7%');
    expect(hq.get('@theme|--radius-lg')).toBe('0');
    expect(hq.get('@theme|--color-primary')).toBe('hsl(var(--primary))');
  });

  it('mirrors every optional palette', () => {
    // Eleven named palettes have their own block; the twelfth ("signal") is the
    // default and needs none — it IS the base `:root` / `.dark` token set.
    const palettes = new Set(
      [...hq.keys()]
        .map((key) => /\[data-palette="([^"]+)"\]/.exec(key)?.[1])
        .filter((name): name is string => name !== undefined),
    );

    expect([...palettes].sort()).toEqual([
      'arctic-ember',
      'blue-navy',
      'coral-mint',
      'cyan-teal',
      'emerald-gold',
      'indigo-amber',
      'moss-rust',
      'purple-pink',
      'rose-copper',
      'sage-sand',
      'slate-violet',
    ]);
  });
});
