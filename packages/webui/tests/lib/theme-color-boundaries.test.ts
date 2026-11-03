import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every themed package whose `src` tree must stay free of hardcoded colors.
 * Allowlist keys are `<package>/<path-relative-to-that-package's-src>`.
 */
const SCAN_ROOTS = [
  { package: 'webui', root: path.resolve(import.meta.dirname, '../../src') },
  // Surfaces the WebUI shares with the desktop app follow the same theme rules.
  {
    package: 'project-surfaces',
    root: path.resolve(import.meta.dirname, '../../../project-surfaces/src'),
  },
] as const;

/**
 * These files render into isolated color systems rather than a themed surface.
 * Keep this list exact and documented; do not add broad directories or globs.
 * The staleness test below fails if a listed file loses its violations, so an
 * exemption cannot silently outlive the reason it was granted.
 */
const ISOLATED_COLOR_SURFACES = new Map<string, string>([
  // ---- webui ----
  ['webui/components/CommandPalette/export-utils.ts', 'Standalone exported HTML document.'],
  ['webui/components/DesignGalleryView.tsx', 'Previews arbitrary user-selected design-kit tokens.'],
  ['webui/components/KanbanContractGraphDashboard.tsx', 'Rendered SVG contract graph nodes.'],
  [
    'webui/components/KanbanContractGraphView.ts',
    'Graph canvas node colors and canvas backgrounds.',
  ],
  ['webui/components/KanbanWorkbench.tsx', 'Kanban status badge highlights.'],
  [
    'webui/components/RepositoryHistoryView.tsx',
    'Git topology graph lanes and branch/tag badge tones.',
  ],
  [
    'webui/components/RepositoryCommitDetail.tsx',
    'Branch/tag badge tones and merge marker of the git history view (split from RepositoryHistoryView).',
  ],
  [
    'webui/components/ProviderLogo.tsx',
    'Brand-mark tiles keep fixed white (dark for Kimi) backgrounds in both themes so original logo colors stay legible.',
  ],
  [
    'webui/components/SetupScreen/ProviderKeyCard.tsx',
    'QR encoder requires explicit dark/light colors.',
  ],
  ['webui/components/TerminalPanel.tsx', 'xterm owns a complete terminal ANSI palette.'],
  [
    'project-surfaces/sage/vector/VectorMemoryPanel.tsx',
    'Data-viz heatmap: similarity scores map to an inline grayscale+blue-tint HSL ramp independent of the theme.',
  ],
  [
    'project-surfaces/sage/vector/vector-memory-panel.css',
    'The same heatmap ramp and its focus outlines (moved out of index.css with the panel).',
  ],
  ['webui/components/monaco-theme.ts', 'Monaco owns a complete editor/syntax palette.'],
  [
    'webui/hooks/ws-handlers/misc-handlers.ts',
    'Serializes graph colors received by a separate renderer.',
  ],
  ['webui/lib/favicon.ts', 'Generates a self-contained SVG favicon data URL.'],
  ['webui/lib/palettes.ts', 'Defines the literal two-color swatches shown by the palette picker.'],
  ['webui/lib/tool-icon.ts', 'Maps externally supplied icon colors to stable color names.'],
  ['webui/syntax-highlight.css', 'Highlight.js owns paired light/dark syntax colors.'],
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

/** Resolve `<package>/<rel>` to an absolute path, or undefined if unknown. */
function resolveSurface(key: string): string | undefined {
  const root = SCAN_ROOTS.find((entry) => key.startsWith(`${entry.package}/`));
  if (!root) return undefined;
  return path.join(root.root, key.slice(root.package.length + 1));
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(absolutePath);
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
    const missing = [...ISOLATED_COLOR_SURFACES.keys()].filter((key) => !resolveSurface(key));
    const unnecessary = [...ISOLATED_COLOR_SURFACES.keys()].filter((key) => {
      const absolutePath = resolveSurface(key);
      return (
        absolutePath !== undefined &&
        colorViolations(key, readFileSync(absolutePath, 'utf8')).length === 0
      );
    });

    expect(missing).toEqual([]);
    expect(unnecessary).toEqual([]);
  });

  it('uses semantic theme tokens instead of hardcoded or named palette colors', () => {
    const violations = SCAN_ROOTS.flatMap(({ package: pkg, root }) =>
      sourceFiles(root).flatMap((file) => {
        const relative = `${pkg}/${path.relative(root, file).replaceAll('\\', '/')}`;
        // index.css is exempt by name: it declares the palette tokens.
        if (relative === 'webui/index.css' || ISOLATED_COLOR_SURFACES.has(relative)) return [];
        return colorViolations(relative, readFileSync(file, 'utf8'));
      }),
    );

    expect(violations).toEqual([]);
  });
});
