import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const srcRoot = path.resolve(import.meta.dirname, '../../src');

/**
 * These files render into isolated color systems rather than the themed WebUI.
 * Keep this list exact and documented; do not add broad directories or globs.
 */
const ISOLATED_COLOR_SURFACES = new Set([
  'components/CommandPalette/export-utils.ts', // Standalone exported HTML document.
  'components/DesignGalleryView.tsx', // Previews arbitrary user-selected design-kit tokens.
  'components/KanbanContractGraphDashboard.tsx', // Rendered SVG contract graph nodes.
  'components/KanbanContractGraphView.ts', // Graph canvas node colors and canvas backgrounds.
  'components/KanbanWorkbench.tsx', // Kanban status badge highlights.
  'components/SetupScreen/ProviderKeyCard.tsx', // QR encoder requires explicit dark/light colors.
  'components/TerminalPanel.tsx', // xterm owns a complete terminal ANSI palette.
  'components/vector-memory-panel/index.tsx', // Data-viz heatmap: similarity scores map to an inline grayscale+blue-tint HSL ramp independent of the theme.
  'components/monaco-theme.ts', // Monaco owns a complete editor/syntax palette.
  'hooks/ws-handlers/misc-handlers.ts', // Serializes graph colors received by a separate renderer.
  'lib/favicon.ts', // Generates a self-contained SVG favicon data URL.
  'lib/palettes.ts', // Defines the literal two-color swatches shown by the palette picker.
  'lib/tool-icon.ts', // Maps externally supplied icon colors to stable color names.
  'syntax-highlight.css', // Highlight.js owns paired light/dark syntax colors.
]);

const NAMED_TAILWIND_PALETTE =
  /\b(?:bg|text|border|ring|fill|stroke|from|to|via)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|100|200|300|400|500|600|700|800|900|950)(?:\/[0-9]+)?\b/g;
const HEX_COLOR = /#[0-9a-fA-F]{8}\b|#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{4}\b|#[0-9a-fA-F]{3}\b/g;
const RGB_COLOR = /\brgba?\s*\(/g;
const NUMERIC_HSL_COLOR = /\bhsla?\s*\(\s*(?:\d|\.\d)/g;

interface ColorRule {
  name: string;
  pattern: RegExp;
}

const COLOR_RULES: readonly ColorRule[] = [
  { name: 'named Tailwind palette utility', pattern: NAMED_TAILWIND_PALETTE },
  { name: 'hardcoded hex color', pattern: HEX_COLOR },
  { name: 'hardcoded rgb/rgba color', pattern: RGB_COLOR },
  { name: 'hardcoded numeric hsl/hsla color', pattern: NUMERIC_HSL_COLOR },
];

function webUiSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return webUiSourceFiles(absolutePath);
    return /\.(?:ts|tsx|css)$/.test(entry.name) ? [absolutePath] : [];
  });
}

function uncommentedLines(source: string): Array<{ line: number; text: string }> {
  let inBlockComment = false;
  let quote: "'" | '"' | '`' | null = null;
  let escaped = false;

  return source.split(/\r?\n/).map((line, index) => {
    let code = '';
    for (let cursor = 0; cursor < line.length; cursor += 1) {
      const char = line[cursor];
      const next = line[cursor + 1];

      if (inBlockComment) {
        if (char === '*' && next === '/') {
          inBlockComment = false;
          cursor += 1;
        }
        continue;
      }
      if (quote !== null) {
        code += char;
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === quote) {
          quote = null;
        }
        continue;
      }
      if (char === '/' && next === '*') {
        inBlockComment = true;
        cursor += 1;
        continue;
      }
      if (char === '/' && next === '/') break;
      if (char === "'" || char === '"' || char === '`') quote = char;
      code += char;
    }
    if (quote !== '`') quote = null;
    escaped = false;
    return { line: index + 1, text: code };
  });
}

function colorViolations(relativePath: string, source: string): string[] {
  return uncommentedLines(source).flatMap(({ line, text }) =>
    COLOR_RULES.flatMap(({ name, pattern }) => {
      pattern.lastIndex = 0;
      return [...text.matchAll(pattern)].map(
        (match) => `${relativePath}:${line} -> ${name}: ${match[0]}`,
      );
    }),
  );
}

describe('WebUI theme color boundaries', () => {
  it('detects each forbidden color syntax without flagging semantic tokens', () => {
    const fixture = [
      "const named = 'bg-blue-500 text-red-400/80';",
      "const hex = '#3b82f6';",
      "const rgb = 'rgba(59, 130, 246, 0.5)';",
      "const hsl = 'hsl(217, 91%, 60%)';",
      "const url = 'https://example.test/#fff';",
      "const escaped = 'quote\\' // #abc';",
      "// const ignored = '#fff';",
      "const semantic = 'bg-primary text-success hsl(var(--warning))'; /* #000 */",
    ].join('\n');

    expect(colorViolations('fixture.ts', fixture)).toEqual([
      'fixture.ts:1 -> named Tailwind palette utility: bg-blue-500',
      'fixture.ts:1 -> named Tailwind palette utility: text-red-400/80',
      'fixture.ts:2 -> hardcoded hex color: #3b82f6',
      'fixture.ts:3 -> hardcoded rgb/rgba color: rgba(',
      'fixture.ts:4 -> hardcoded numeric hsl/hsla color: hsl(2',
      'fixture.ts:5 -> hardcoded hex color: #fff',
      'fixture.ts:6 -> hardcoded hex color: #abc',
    ]);
  });

  it('keeps isolated color-surface exceptions explicit, valid, and necessary', () => {
    const sourceFiles = new Map(
      webUiSourceFiles(srcRoot).map((file) => [
        path.relative(srcRoot, file).replaceAll('\\', '/'),
        file,
      ]),
    );
    const missing = [...ISOLATED_COLOR_SURFACES].filter((file) => !sourceFiles.has(file));
    const unnecessary = [...ISOLATED_COLOR_SURFACES].filter((file) => {
      const absolutePath = sourceFiles.get(file);
      return (
        absolutePath !== undefined &&
        colorViolations(file, readFileSync(absolutePath, 'utf8')).length === 0
      );
    });

    expect(missing).toEqual([]);
    expect(unnecessary).toEqual([]);
  });

  it('uses semantic theme tokens instead of hardcoded or named palette colors', () => {
    const violations = webUiSourceFiles(srcRoot).flatMap((file) => {
      const relativePath = path.relative(srcRoot, file).replaceAll('\\', '/');
      if (relativePath === 'index.css' || ISOLATED_COLOR_SURFACES.has(relativePath)) return [];
      return colorViolations(relativePath, readFileSync(file, 'utf8'));
    });

    expect(violations).toEqual([]);
  });
});
