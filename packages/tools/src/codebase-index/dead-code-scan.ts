/**
 * `dead-code-scan` tool — find unused symbols using the codebase-index refs graph.
 *
 * How it works:
 * 1. Opens a pooled connection to the existing codebase-index SQLite store.
 * 2. Discovers entry-point symbols from package.json (bin, main, exports, types)
 *    plus conventional entry files (src/index.ts, src/main.ts, index.ts).
 * 3. BFS-traverses the reference graph from those entry points to find every
 *    symbol that is transitively reachable through imports, calls, type refs,
 *    inheritance, and implementation edges.
 * 4. Everything NOT reached is a dead-code candidate.
 *
 * Known limitations (false positives possible):
 * - Dynamic imports / `require()` with computed paths are invisible.
 * - External consumers (npm installers, CI tools) can't be seen.
 * - Config-driven registration (plugin manifests, DI containers) won't appear.
 * - Type-only exports consumed only at the type level are still marked alive
 *   because the refs graph tracks `type_ref` edges.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Tool } from '@wrongstack/core/types';
import { detectLang } from './languages.js';
import type { SymbolKind, SymbolLang } from './schema.js';
import { codebaseIndexDirOverride, type IndexStore, indexStorePool } from './writer.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface DeadCodeScanInput {
  /** Project root (defaults to ctx.projectRoot). */
  projectRoot?: string | undefined;
  /**
   * Override the index directory. Normally auto-resolved from projectRoot.
   */
  indexDir?: string | undefined;
  /**
   * Additional entry-point file paths (absolute or relative to projectRoot)
   * to seed the reachability scan. These augment auto-discovered entry points.
   */
  entryPoints?: string[] | undefined;
}

export interface DeadSymbol {
  name: string;
  kind: SymbolKind;
  lang: SymbolLang;
  file: string;
  line: number;
  /** Why this symbol is considered dead. */
  reason: 'unreferenced' | 'unreferenced-export';
}

export interface DeadFile {
  file: string;
  symbolCount: number;
  lang: string;
}

export interface DeadPackage {
  package: string;
  path: string;
  fileCount: number;
}

export interface DeadCodeScanOutput {
  /** Symbols found dead. Sorted: unreferenced-export first, then by file. */
  deadSymbols: DeadSymbol[];
  /** Files where every defined symbol is dead (likely orphaned modules). */
  deadFiles: DeadFile[];
  /** Packages in the workspace with zero used symbols. */
  deadPackages: DeadPackage[];
  /** Entry points used as traversal roots. */
  entryPoints: string[];
  stats: {
    totalSymbols: number;
    alive: number;
    dead: number;
    durationMs: number;
  };
}

// ─── Tool definition ───────────────────────────────────────────────────────

export const deadCodeScanTool: Tool<DeadCodeScanInput, DeadCodeScanOutput> = {
  name: 'dead-code-scan',
  category: 'Project',
  icon: 'index',
  description:
    'Scan TypeScript/JavaScript source files for exported symbols that appear ' +
    'unused anywhere in the project. Uses the codebase-index reference graph ' +
    '(import/call/type-ref edges) to compute transitive reachability from ' +
    'package.json entry points. Requires a built codebase-index (run ' +
    '`codebase-index` first if you get no results).',
  usageHint:
    'SCANS ALL INDEXED FILES UNDER THE PROJECT ROOT:\n\n' +
    '- `projectRoot` defaults to the current project root; `indexDir` overrides the resolved index location.\n' +
    '- `entryPoints` is an array of file paths that AUGMENTS the auto-discovered entry points (package.json bin/main/exports/types plus conventional src/index.ts-style files) — it does not replace them.\n\n' +
    'The scan runs against the existing index; results are best-effort (dynamic imports, external consumers, and config-driven registration are invisible).',
  permission: 'auto',
  mutating: false,
  capabilities: ['fs.read'],
  timeoutMs: 60_000,
  inputSchema: {
    type: 'object',
    properties: {
      projectRoot: {
        type: 'string',
        description: 'Project root (defaults to ctx.projectRoot).',
      },
      indexDir: {
        type: 'string',
        description: 'Override index directory.',
      },
      entryPoints: {
        type: 'array',
        items: { type: 'string' },
        description: 'Additional entry-point file paths to seed the scan.',
      },
    },
  },
  async execute(input, ctx, _execOpts) {
    const startMs = Date.now();
    const projectRoot = input.projectRoot ?? ctx.projectRoot ?? ctx.cwd ?? process.cwd();
    const indexDir = input.indexDir ?? codebaseIndexDirOverride(ctx) ?? undefined;

    const result = runDeadCodeScan(projectRoot, {
      indexDir,
      userEntryPoints: input.entryPoints,
    });

    return {
      ...result,
      stats: { ...result.stats, durationMs: Date.now() - startMs },
    };
  },
};

// ─── Entry-point discovery ─────────────────────────────────────────────────

/**
 * Read a JSON file safely, returning null on any error.
 */
function tryReadJson(filePath: string): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Resolve a potentially relative path against a base directory.
 */
function resolveAgainst(base: string, relative: string): string {
  if (path.isAbsolute(relative)) return relative;
  return path.resolve(base, relative);
}

/**
 * Walk the workspace and discover entry-point files from package.json(s).
 */
function discoverEntryPoints(projectRoot: string, userEntryPoints: string[] | undefined): string[] {
  const entries = new Set<string>();

  // 1. User-provided entry points.
  if (userEntryPoints) {
    for (const ep of userEntryPoints) {
      const resolved = resolveAgainst(projectRoot, ep);
      if (fs.existsSync(resolved)) entries.add(resolved);
    }
  }

  // 2. Root package.json.
  const rootPkg = tryReadJson(path.join(projectRoot, 'package.json'));
  if (rootPkg) {
    addPkgJsonEntryPoints(projectRoot, rootPkg, entries);
  }

  // 3. Workspace packages if this is a monorepo.
  let workspaces: string[];
  if (rootPkg) {
    workspaces = extractWorkspaceGlobs(rootPkg, projectRoot);
    // Fall back to pnpm-workspace.yaml when package.json has no workspaces field
    // (pnpm's default layout for modern monorepos).
    if (workspaces.length === 0) {
      workspaces = extractPnpmWorkspaceDirs(projectRoot);
    }
  } else {
    workspaces = [];
  }
  for (const wsDir of workspaces) {
    const pkgJsonPath = path.join(wsDir, 'package.json');
    const pkg = tryReadJson(pkgJsonPath);
    if (pkg) {
      addPkgJsonEntryPoints(wsDir, pkg, entries);
      // Convention: src/index.ts
      const convention1 = path.join(wsDir, 'src', 'index.ts');
      if (fs.existsSync(convention1)) entries.add(convention1);
      const convention2 = path.join(wsDir, 'src', 'main.ts');
      if (fs.existsSync(convention2)) entries.add(convention2);
      const convention3 = path.join(wsDir, 'index.ts');
      if (fs.existsSync(convention3)) entries.add(convention3);
    }
  }

  // 4. Root conventions (for non-package projects).
  if (!rootPkg || !workspaces.length) {
    for (const name of ['src/index.ts', 'src/main.ts', 'index.ts']) {
      const convention = path.join(projectRoot, name);
      if (fs.existsSync(convention)) entries.add(convention);
    }
  }

  return [...entries];
}

/**
 * Known build-output directory names that may have equivalent source
 * directories under `src/`. Used by {@link trySourceEquivalent} to map
 * compiled paths back to their source files.
 */
const BUILD_OUTPUT_DIRS = ['dist', 'out', 'build', 'release'] as const;

/**
 * Known build-output directory names. Used by {@link trySourceEquivalent}.
 */
const BUILD_OUTPUT_DIR_NAMES = BUILD_OUTPUT_DIRS.map((d) => `${path.sep}${d}${path.sep}`);

/**
 * Given a resolved path that points into a build-output directory (e.g.
 * `<pkgDir>/dist/main/main.js`), try to find the corresponding source file
 * under `src/` with a `.ts` extension.
 *
 * Examples:
 *   `<pkgDir>/dist/main/main.js` → `<pkgDir>/src/main/main.ts`
 *   `<pkgDir>/out/index.mjs`     → `<pkgDir>/src/index.ts`
 *   `<pkgDir>/build/cli.cjs`     → `<pkgDir>/src/cli.ts`
 *
 * Returns the first existing source path, or null if none is found.
 */
function trySourceEquivalent(resolved: string): string | null {
  // Normalize path separators so BUILD_OUTPUT_DIR_NAMES (built with path.sep)
  // matches regardless of how paths are stored in the index or config.
  resolved = resolved.replace(/[/\\]/g, path.sep);
  for (const marker of BUILD_OUTPUT_DIR_NAMES) {
    const idx = resolved.indexOf(marker);
    if (idx === -1) continue;

    // `marker` already includes leading and trailing path.sep (e.g. `/dist/`),
    // so `idx` points to that leading separator. The character `idx - 1` is
    // the last char of the parent directory — NOT a separator — so checking
    // `idx > 0 && resolved[idx - 1] !== path.sep` would *always* reject valid
    // matches. The leading+trailing separators in the marker already enforce
    // segment boundaries: `/my-dist/` would map to a non-existent `src/` path
    // which `fs.existsSync` catches harmlessly below.
    const base = resolved.replace(marker, `${path.sep}src${path.sep}`);

    // 1. Replace .js/.mjs/.cjs → .ts
    const candidate = base.replace(/\.(js|mjs|cjs)$/, '.ts');
    if (candidate !== base && fs.existsSync(candidate)) {
      return candidate;
    }

    // 2. Strip .d.ts first, then append .ts (catches e.g. dist/index.d.ts → src/index.ts)
    const dtsStripped = base.replace(/\.d\.ts$/, '');
    const candidateDts = dtsStripped + '.ts';
    if (candidateDts !== base && candidateDts !== candidate && fs.existsSync(candidateDts)) {
      return candidateDts;
    }

    // 3. Plain `.ts` appended when path had no JS extension (e.g. dist/main → src/main.ts).
    // Skips when branch 2 already checked this same path (no .d.ts extension).
    const candidateNoExt = base + '.ts';
    if (
      candidate !== candidateNoExt &&
      candidateNoExt !== candidateDts &&
      fs.existsSync(candidateNoExt)
    ) {
      return candidateNoExt;
    }
  }
  return null;
}

/**
 * Resolve a path string from a package.json field, add it to entries if it
 * exists, and also try the src/ equivalent when the path points to a
 * build-output directory (dist/out/build/release).
 */
function tryAddEntryPath(pkgDir: string, rawPath: string, entries: Set<string>): void {
  const resolved = resolveAgainst(pkgDir, rawPath);
  if (fs.existsSync(resolved)) entries.add(resolved);

  // Try .ts extension (for .js/.mjs/.cjs paths).
  const tsResolved = resolved.replace(/\.(js|mjs|cjs)$/, '.ts');
  if (tsResolved !== resolved && fs.existsSync(tsResolved)) {
    entries.add(tsResolved);
  }

  // Try source equivalent under src/ (e.g. dist/main/main.js → src/main/main.ts).
  // This catches packages like Electron apps whose "main" field points to the
  // compiled output rather than the TypeScript source.
  // Runs even when the .ts sibling check above succeeded, because the build-output
  // dir might contain a stale .d.ts while the real source lives under src/.
  const srcAlt = trySourceEquivalent(resolved);
  if (srcAlt) entries.add(srcAlt);
}

function addPkgJsonEntryPoints(
  pkgDir: string,
  pkg: Record<string, unknown>,
  entries: Set<string>,
): void {
  // main
  if (typeof pkg.main === 'string') {
    tryAddEntryPath(pkgDir, pkg.main, entries);
  }

  // bin
  const bin = pkg.bin;
  if (typeof bin === 'string') {
    tryAddEntryPath(pkgDir, bin, entries);
  } else if (bin && typeof bin === 'object') {
    for (const value of Object.values(bin)) {
      if (typeof value === 'string') {
        tryAddEntryPath(pkgDir, value, entries);
      }
    }
  }

  // types / typings
  for (const key of ['types', 'typings'] as const) {
    if (typeof pkg[key] === 'string') {
      tryAddEntryPath(pkgDir, pkg[key] as string, entries);
    }
  }

  // exports
  const exports_ = pkg.exports;
  if (exports_ && typeof exports_ === 'object') {
    for (const value of Object.values(exports_ as Record<string, unknown>)) {
      if (typeof value === 'string') {
        tryAddEntryPath(pkgDir, value, entries);
      } else if (value && typeof value === 'object') {
        // Nested export condition: { "import": "./dist/foo.js", "types": ... }
        for (const nested of Object.values(value as Record<string, unknown>)) {
          if (typeof nested === 'string') {
            tryAddEntryPath(pkgDir, nested, entries);
          }
        }
      }
    }
  }
}

function expandGlobPattern(entry: string, projectRoot: string): string[] {
  const dirs: string[] = [];
  if (entry.includes('*')) {
    const base = entry.replace(/\/\*+$/, '');
    const baseDir = path.resolve(projectRoot, base);
    try {
      const children = fs.readdirSync(baseDir, { withFileTypes: true });
      for (const child of children) {
        if (child.isDirectory()) {
          dirs.push(path.join(baseDir, child.name));
        }
      }
    } catch {
      // ignore missing dirs
    }
  } else {
    dirs.push(path.resolve(projectRoot, entry));
  }
  return dirs;
}

function extractWorkspaceGlobs(pkg: Record<string, unknown>, projectRoot: string): string[] {
  const dirs: string[] = [];
  const workspaces = pkg.workspaces;
  if (Array.isArray(workspaces)) {
    for (const entry of workspaces) {
      if (typeof entry === 'string') {
        dirs.push(...expandGlobPattern(entry, projectRoot));
      }
    }
  }
  return dirs;
}

/**
 * Read workspace directories from `pnpm-workspace.yaml` when the root
 * package.json does not have a `workspaces` field (pnpm default layout).
 * Parses the `packages:` list — each entry is a glob string that gets
 * expanded the same way as package.json workspaces entries.
 *
 * Uses a line-by-line context tracker so only list items nested under
 * the `packages:` key are collected — items under other top-level keys
 * (e.g. `onlyBuiltDependencies:`) are correctly ignored.
 */
function extractPnpmWorkspaceDirs(projectRoot: string): string[] {
  const yamlPath = path.join(projectRoot, 'pnpm-workspace.yaml');
  if (!fs.existsSync(yamlPath)) return [];

  try {
    const content = fs.readFileSync(yamlPath, 'utf8');
    const dirs: string[] = [];
    let inPackages = false;
    const lines = content.split('\n');
    // Regex for a list item: whitespace, dash, optional space, then optional
    // quoted or bare value.
    const itemRe = /^\s+-\s+"([^"]+)"|^\s+-\s+'([^']+)'|^\s+-\s+(\S+)/;
    for (const line of lines) {
      const trimmed = line.trim();

      // Detect `packages:` key at any indent level.
      if (/^packages\s*:\s*$/.test(trimmed)) {
        inPackages = true;
        continue;
      }

      // Any other top-level key (no leading whitespace) ends the packages section.
      if (inPackages && trimmed.length > 0 && !line.startsWith(' ') && !line.startsWith('\t')) {
        if (!trimmed.startsWith('-')) {
          inPackages = false;
          continue;
        }
      }

      // Collect list items when inside the packages block.
      if (inPackages) {
        const m = itemRe.exec(line);
        if (m) {
          const entry = m[1] ?? m[2] ?? m[3];
          if (entry) {
            dirs.push(...expandGlobPattern(entry, projectRoot));
          }
        }
      }
    }
    return dirs;
  } catch {
    return [];
  }
}

// ─── BFS reachability scan ────────────────────────────────────────────────

interface SymbolRow {
  id: number;
  name: string;
  file: string;
  kind: string;
  line: number;
}

/**
 * Try to resolve a relative module specifier (e.g. './foo', '../bar/index.js')
 * against an importing file's directory to find an indexed source file.
 *
 * Tries these extensions in order: .ts, .tsx, .js, .jsx, /index.ts, /index.tsx,
 * /index.js, /index.jsx.  Strips .js/.jsx/.mjs/.cjs → .ts/.tsx for the common pattern
 * where source is TypeScript but the import specifier references the compiled
 * output (e.g. `import { X } from './foo.js'` → resolves to `./foo.ts`).
 *
 * Returns the absolute paths of all matching indexed files, or an empty array.
 */
function resolveModulePath(
  importerPath: string,
  moduleSpecifier: string,
  indexedFiles: ReadonlySet<string>,
): string[] {
  // Only handle relative paths — bare specifiers (package names) can't be
  // resolved locally.
  if (!moduleSpecifier.startsWith('.')) return [];

  const dir = path.dirname(importerPath);
  const base = path.resolve(dir, moduleSpecifier);
  const results: string[] = [];

  // Strip common extensions → bare base so we try cross-extension equivalents.
  // Include .ts/.tsx so specifiers like `./foo.ts` are handled the same way
  // as `./foo.js`.
  const stripped = base.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, '');
  // When the original path already has one of the known extensions we try
  // below, skip the `base` iteration — `stripped` already covers all the
  // extension variants, and retrying with the original extension appended
  // (e.g. `foo.ts.ts`) would only produce pointless Set.has() misses.
  const skipBase = stripped !== base && /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(base);
  const candidates = skipBase ? [stripped] : [base];

  for (const candidate of candidates) {
    if (indexedFiles.has(candidate + '.ts')) results.push(candidate + '.ts');
    if (indexedFiles.has(candidate + '.tsx')) results.push(candidate + '.tsx');
    if (indexedFiles.has(candidate + '.js')) results.push(candidate + '.js');
    if (indexedFiles.has(candidate + '.jsx')) results.push(candidate + '.jsx');
    if (indexedFiles.has(candidate + '.mjs')) results.push(candidate + '.mjs');
    if (indexedFiles.has(candidate + '.cjs')) results.push(candidate + '.cjs');

    // Try /index.{ts,tsx,js,jsx,mjs,cjs}
    if (indexedFiles.has(path.join(candidate, 'index.ts')))
      results.push(path.join(candidate, 'index.ts'));
    if (indexedFiles.has(path.join(candidate, 'index.tsx')))
      results.push(path.join(candidate, 'index.tsx'));
    if (indexedFiles.has(path.join(candidate, 'index.js')))
      results.push(path.join(candidate, 'index.js'));
    if (indexedFiles.has(path.join(candidate, 'index.jsx')))
      results.push(path.join(candidate, 'index.jsx'));
    if (indexedFiles.has(path.join(candidate, 'index.mjs')))
      results.push(path.join(candidate, 'index.mjs'));
    if (indexedFiles.has(path.join(candidate, 'index.cjs')))
      results.push(path.join(candidate, 'index.cjs'));
  }

  return [...new Set(results)];
}

/**
 * Parse the specific symbol names from a named re-export statement like:
 *   export { X, Y } from './M'           → ['X', 'Y']
 *   export { X as Y, type Z } from './M' → ['X', 'Z']
 *   export type { X } from './M'         → ['X']
 *
 * Returns `null` for wildcard re-exports (`export * from './M'` or
 * `export * as X from './M'`) since those legitimately re-export all symbols.
 */
function parseNamedExportSymbols(matchText: string): string[] | null {
  const braceStart = matchText.indexOf('{');
  if (braceStart === -1) return null; // wildcard export

  const braceEnd = matchText.indexOf('}', braceStart);
  if (braceEnd === -1) return null;

  const inner = matchText.slice(braceStart + 1, braceEnd);
  const symbols: string[] = [];

  for (const part of inner.split(',')) {
    let s = part.trim();
    if (!s) continue;
    // Strip inline 'type ' modifier (e.g. "type X" → "X")
    s = s.replace(/^type\s+/, '');
    // Handle 'X as Y' — extract X (the source symbol name)
    const asIdx = s.search(/\s+as\s+/);
    if (asIdx !== -1) {
      s = s.slice(0, asIdx).trim();
    }
    if (s) symbols.push(s);
  }

  return symbols;
}

export function runDeadCodeScan(
  projectRoot: string,
  opts: {
    indexDir?: string | undefined;
    userEntryPoints?: string[] | undefined;
    // Allow injecting a store for testing.
    store?: IndexStore | undefined;
  } = {},
): DeadCodeScanOutput {
  const store = opts.store ?? indexStorePool.acquire(projectRoot, { indexDir: opts.indexDir });

  try {
    // Phase 1: load the full symbol universe (for classification, not traversal).
    const allSymbols: SymbolRow[] = store.getAllSymbols();

    // Build lookup: id → symbol
    const symbolById = new Map<number, SymbolRow>();
    for (const s of allSymbols) {
      symbolById.set(s.id, s);
    }

    // Phase 2: discover entry points and map to symbol ids.
    const discoveredFiles = discoverEntryPoints(projectRoot, opts.userEntryPoints);
    const entryFileSet = new Set(discoveredFiles.map((f) => path.resolve(f)));

    // Build a set of all indexed files for module-path resolution.
    const indexedFiles = new Set<string>();
    for (const s of allSymbols) indexedFiles.add(s.file);
    for (const fm of store.getAllFileMetas()) indexedFiles.add(fm.file);

    // Map entry files to their symbol ids.
    const seedIds = new Set<number>();
    for (const s of allSymbols) {
      if (entryFileSet.has(s.file)) {
        seedIds.add(s.id);
      }
    }

    // ── Pre-build lookups for O(1) access ───────────────────────────
    const fileToSymbolIds = new Map<string, number[]>();
    for (const s of allSymbols) {
      let byFile = fileToSymbolIds.get(s.file);
      if (!byFile) {
        byFile = [];
        fileToSymbolIds.set(s.file, byFile);
      }
      byFile.push(s.id);
    }

    // ── Recursive barrel-file scanner ─────────────────────────────────
    // (unchanged — this part needs file I/O, not graph traversal)
    const scannedBarrels = new Set<string>();
    const barrelWorkList = [...entryFileSet];
    while (barrelWorkList.length > 0) {
      const epFile = barrelWorkList.pop()!;
      if (scannedBarrels.has(epFile)) continue;
      scannedBarrels.add(epFile);

      try {
        const content = fs.readFileSync(epFile, 'utf8');
        const strippedContent = content
          .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
          .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
        const reExportRe =
          /export\s+(?:(?:type\s+)?\{[\s\S]*?\}\s+from|\*\s+as\s+\w+\s+from|\*\s+from)\s+['"]([^'"]+)['"]/g;
        for (;;) {
          const match = reExportRe.exec(strippedContent);
          if (match === null) break;
          const moduleSpec = match[1]!;
          const resolvedFiles = resolveModulePath(epFile, moduleSpec, indexedFiles);
          for (const rf of resolvedFiles) {
            const fileSyms = fileToSymbolIds.get(rf);
            if (fileSyms) {
              const namedSymbols = parseNamedExportSymbols(match[0]);
              if (namedSymbols) {
                const nameSet = new Set(namedSymbols);
                for (const sid of fileSyms) {
                  const sym = symbolById.get(sid);
                  if (sym && nameSet.has(sym.name)) seedIds.add(sid);
                }
              } else {
                for (const sid of fileSyms) seedIds.add(sid);
              }
            }
            if (!scannedBarrels.has(rf)) {
              barrelWorkList.push(rf);
            }
          }
        }
      } catch (err) {
        if (err instanceof Error && (err as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.warn(
            JSON.stringify({
              level: 'warn',
              event: 'dead_code_scan_barrel_read_failed',
              message: err.message,
              file: epFile,
              timestamp: new Date().toISOString(),
            }),
          );
        }
      }
    }

    // Phase 3: CTE-based reachability scan (replaces in-memory BFS).
    // Instead of loading ALL refs into JS memory and traversing with a
    // Map<number, Set<number>>, we delegate to a native SQLite recursive CTE.
    // The CTE stays inside SQLite's optimized query engine, avoiding
    // hundreds of MB of JS heap for large monorepos.
    const alive = store.findReachableSymbolIds([...seedIds]);

    // Phase 4: classify dead symbols.
    const dead: DeadSymbol[] = [];
    const symbolsByFile = new Map<string, SymbolRow[]>();
    const usedFiles = new Set<string>();

    for (const s of allSymbols) {
      if (alive.has(s.id)) {
        usedFiles.add(s.file);
        continue;
      }
      // Only report symbols that are exported or could be externally relevant.
      // Skip pure-internal things like parameters, local vars that can't be "dead".
      if (s.kind === 'parameter') continue;
      if (s.kind === 'let' || s.kind === 'var') {
        // Local variables are only dead if the whole file is dead — handled by deadFiles.
        continue;
      }

      const reason: DeadSymbol['reason'] = 'unreferenced';
      dead.push({
        name: s.name,
        kind: s.kind as SymbolKind,
        lang: detectLang(s.file) ?? ('ts' as SymbolLang),
        file: s.file,
        line: s.line,
        reason,
      });

      let fileSymbols = symbolsByFile.get(s.file);
      if (!fileSymbols) {
        fileSymbols = [];
        symbolsByFile.set(s.file, fileSymbols);
      }
      fileSymbols.push(s);
    }

    // Phase 5: classify dead files (all their symbols are dead).
    const deadFiles: DeadFile[] = [];
    for (const [file, syms] of symbolsByFile) {
      // Check if any symbol from this file is alive.
      let anyAlive = false;
      for (const s of allSymbols) {
        if (s.file === file && alive.has(s.id)) {
          anyAlive = true;
          break;
        }
      }
      if (!anyAlive) {
        deadFiles.push({
          file,
          symbolCount: syms.length,
          lang: detectLang(file) ?? 'ts',
        });
      }
    }

    // Phase 6: classify dead packages.
    // A package is dead if ALL its files have zero used symbols.
    const deadPackages: DeadPackage[] = [];
    const pkgEntries = findPackageEntries(projectRoot);
    for (const [pkgName, pkgDir] of pkgEntries) {
      const pkgFiles = allSymbols.filter((s) => s.file.startsWith(pkgDir + path.sep));
      if (pkgFiles.length === 0) continue;
      const pkgUsed = pkgFiles.filter((s) => alive.has(s.id));
      if (pkgUsed.length === 0) {
        // All files in this package are dead.
        const uniqueFiles = new Set(pkgFiles.map((s) => s.file));
        deadPackages.push({
          package: pkgName,
          path: pkgDir,
          fileCount: uniqueFiles.size,
        });
      }
    }

    // Sort: unreferenced-export first, then by file path.
    dead.sort((a, b) => {
      if (a.reason !== b.reason) return a.reason === 'unreferenced-export' ? -1 : 1;
      return a.file.localeCompare(b.file) || a.line - b.line;
    });

    return {
      deadSymbols: dead,
      deadFiles,
      deadPackages,
      entryPoints: discoveredFiles,
      stats: {
        totalSymbols: allSymbols.length,
        alive: alive.size,
        dead: dead.length,
        durationMs: 0,
      },
    };
  } finally {
    if (!opts.store) {
      indexStorePool.release(store);
    }
  }
}

// ─── Package discovery helpers ─────────────────────────────────────────────

function findPackageEntries(projectRoot: string): Map<string, string> {
  const pkgMap = new Map<string, string>();

  // Root package
  const rootPkg = tryReadJson(path.join(projectRoot, 'package.json'));
  if (rootPkg && typeof rootPkg.name === 'string') {
    pkgMap.set(rootPkg.name, projectRoot);
  }

  // Workspace packages
  if (rootPkg) {
    let wsDirs = extractWorkspaceGlobs(rootPkg, projectRoot);
    if (wsDirs.length === 0) {
      wsDirs = extractPnpmWorkspaceDirs(projectRoot);
    }
    for (const wsDir of wsDirs) {
      const wsPkg = tryReadJson(path.join(wsDir, 'package.json'));
      if (wsPkg && typeof wsPkg.name === 'string') {
        pkgMap.set(wsPkg.name, wsDir);
      }
    }
  }

  return pkgMap;
}
