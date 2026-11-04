import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = fileURLToPath(new URL('../', import.meta.url));
const root = resolve(app, '../..');

/** The WebUI's `@theme` body, read with brace matching so nested blocks cannot end it early. */
function themeBody(css: string): string {
  const start = css.indexOf('@theme {');
  if (start < 0) throw Error('The WebUI stylesheet has no @theme block');
  let depth = 0;
  for (let i = css.indexOf('{', start); i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(css.indexOf('{', start) + 1, i);
  }
  throw Error('The WebUI @theme block is not closed');
}
/** Light, dark and palette token blocks mapped onto the desktop's appearance attributes. */
function scope(base: string, palette: string | undefined): string {
  const dark = base === '.dark' ? '[data-mode="dark"]' : '';
  const accent = palette ? `[data-palette="${palette}"]` : '';
  return `:root${dark}${accent} .ws-surfaces`;
}

/**
 * The shared project surfaces are WebUI components styled with the WebUI theme. Their tokens
 * (`--card`, `--border`, `--muted-foreground`…) are HSL triples, while the desktop's own
 * variables of the same names are complete colors, so the WebUI values apply only inside a
 * `.ws-surfaces` container, and `@theme inline` makes each utility read them where it is used.
 */
export function surfaceThemeCss(indexCss: string): string {
  const css = indexCss.replace(/\/\*[\s\S]*?\*\//g, '');
  const blocks: string[] = [];
  for (const match of css.matchAll(
    /(:root|\.dark)(?:\[data-palette="([^"]+)"\])?\s*\{([^{}]+)\}/g,
  )) {
    const declarations = [...match[3]!.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(
      (declaration) => `  ${declaration[1]}: ${declaration[2]!.trim()};`,
    );
    if (declarations.length)
      blocks.push(`${scope(match[1]!, match[2])} {\n${declarations.join('\n')}\n}`);
  }
  if (!blocks.length) throw Error('The WebUI stylesheet has no token blocks');
  return [
    '/* Generated from packages/webui/src/index.css by scripts/sync-surface-theme.ts. Do not edit. */',
    `@theme inline {${themeBody(css)}}`,
    ...blocks,
    '',
  ].join('\n');
}
export function syncSurfaceTheme() {
  // index.css holds the theme and tokens; workbench.css adds the motion and edge variables
  // its component classes read.
  const source = ['index.css', 'workbench.css']
    .map((file) => readFileSync(join(root, 'packages/webui/src', file), 'utf8'))
    .join('\n');
  writeFileSync(join(app, 'src/surface-theme.css'), surfaceThemeCss(source));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  syncSurfaceTheme();
