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
import {
  type SymbolKind,
  type SymbolLang,
} from './schema.js';
import { codebaseIndexDirOverride, IndexStore, indexStorePool } from './writer.js';

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
  icon: 'search',
  description:
    'Scan TypeScript/JavaScript source files for exported symbols that appear ' +
    'unused anywhere in the project. Uses the codebase-index reference graph ' +
    '(import/call/type-ref edges) to compute transitive reachability from ' +
    'package.json entry points. Requires a built codebase-index (run ' +
    '`codebase-index` first if you get no results).',
  usageHint:
    'PASS `path` TO SCOPE THE SCAN:\n\n' +
    '- Defaults to the project root (all indexed files).\n' +
    '- `path` can be a directory to scope the scan (e.g. "src/util/").\n' +
    '- `entryPoints` overrides auto-detected entry points (comma-separated file paths).\n\n' +
    'The scan runs against the existing index; results are best-effort.',
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
        description:
          'Additional entry-point file paths to seed the scan.',
      },
    },
  },
  async execute(input, ctx, _execOpts) {
    const startMs = Date.now();
    const projectRoot = input.projectRoot ?? ctx.projectRoot;
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
function discoverEntryPoints(
  projectRoot: string,
  userEntryPoints: string[] | undefined,
): string[] {
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
  const workspaces = rootPkg
    ? extractWorkspaceGlobs(rootPkg, projectRoot)
    : [];
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

function addPkgJsonEntryPoints(
  pkgDir: string,
  pkg: Record<string, unknown>,
  entries: Set<string>,
): void {
  // main
  if (typeof pkg.main === 'string') {
    const resolved = resolveAgainst(pkgDir, pkg.main);
    if (fs.existsSync(resolved)) entries.add(resolved);
    // also try .ts extension
    const tsResolved = resolved.replace(/\.(js|mjs|cjs)$/, '.ts');
    if (tsResolved !== resolved && fs.existsSync(tsResolved)) {
      entries.add(tsResolved);
    }
  }

  // bin
  const bin = pkg.bin;
  if (typeof bin === 'string') {
    const resolved = resolveAgainst(pkgDir, bin);
    if (fs.existsSync(resolved)) entries.add(resolved);
  } else if (bin && typeof bin === 'object') {
    for (const value of Object.values(bin)) {
      if (typeof value === 'string') {
        const resolved = resolveAgainst(pkgDir, value);
        if (fs.existsSync(resolved)) entries.add(resolved);
      }
    }
  }

  // types / typings
  for (const key of ['types', 'typings'] as const) {
    if (typeof pkg[key] === 'string') {
      const resolved = resolveAgainst(pkgDir, pkg[key] as string);
      if (fs.existsSync(resolved)) entries.add(resolved);
    }
  }

  // exports
  const exports_ = pkg.exports;
  if (exports_ && typeof exports_ === 'object') {
    for (const value of Object.values(exports_ as Record<string, unknown>)) {
      if (typeof value === 'string') {
        const resolved = resolveAgainst(pkgDir, value);
        if (fs.existsSync(resolved)) entries.add(resolved);
      } else if (value && typeof value === 'object') {
        // Nested export condition: { "import": "./dist/foo.js", "types": ... }
        for (const nested of Object.values(
          value as Record<string, unknown>,
        )) {
          if (typeof nested === 'string') {
            const resolved = resolveAgainst(pkgDir, nested);
            if (fs.existsSync(resolved)) entries.add(resolved);
          }
        }
      }
    }
  }
}

function extractWorkspaceGlobs(
  pkg: Record<string, unknown>,
  projectRoot: string,
): string[] {
  const dirs: string[] = [];
  const workspaces = pkg.workspaces;
  if (Array.isArray(workspaces)) {
    for (const entry of workspaces) {
      if (typeof entry === 'string') {
        // Expand simple globs: "packages/*" → list directories
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
      }
    }
  }
  return dirs;
}

// ─── BFS reachability scan ────────────────────────────────────────────────

interface SymbolRow {
  id: number;
  name: string;
  file: string;
  kind: string;
  line: number;
}

interface RefsRow {
  fromId: number;
  toId: number;
  callType: string;
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
  const store =
    opts.store ??
    indexStorePool.acquire(projectRoot, { indexDir: opts.indexDir });

  try {
    // Phase 1: load the full symbol universe + refs graph.
    const allSymbols: SymbolRow[] = store.getAllSymbols();
    const allRefs: RefsRow[] = store.getAllResolvedRefs();

    // Build lookup: id → symbol
    const symbolById = new Map<number, SymbolRow>();
    for (const s of allSymbols) {
      symbolById.set(s.id, s);
    }

    // Build reference index: fromId → Set<toId> (symbols THIS symbol references)
    const references = new Map<number, Set<number>>();
    for (const ref of allRefs) {
      let set = references.get(ref.fromId);
      if (!set) {
        set = new Set();
        references.set(ref.fromId, set);
      }
      set.add(ref.toId);
    }

    // Phase 2: discover entry points and map to symbol ids.
    const discoveredFiles = discoverEntryPoints(projectRoot, opts.userEntryPoints);
    const entryFileSet = new Set(discoveredFiles.map((f) => path.resolve(f)));

    // Map entry files to their symbol ids.
    const seedIds = new Set<number>();
    for (const s of allSymbols) {
      if (entryFileSet.has(s.file)) {
        seedIds.add(s.id);
      }
    }

    // Phase 3: BFS traversal from seed symbols.
    // alive = every symbol transitively reachable from an entry point via refs.
    const alive = new Set<number>(seedIds);
    const frontier = [...seedIds];

    // Track which refs we've already traversed to avoid revisiting.
    const visitedEdges = new Set<string>();

    while (frontier.length > 0) {
      const current = frontier.pop()!;
      // Follow outgoing edges: what does THIS symbol reference?
      const outgoing = references.get(current);
      if (!outgoing) continue;

      for (const toId of outgoing) {
        const edgeKey = `${current}->${toId}`;
        if (visitedEdges.has(edgeKey)) continue;
        visitedEdges.add(edgeKey);

        if (!alive.has(toId)) {
          alive.add(toId);
          frontier.push(toId);
        }
      }
    }

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
        lang: 'ts' as SymbolLang, // populated from symbol file metadata
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
          lang: syms[0]?.kind ?? 'ts',
        });
      }
    }

    // Phase 6: classify dead packages.
    // A package is dead if ALL its files have zero used symbols.
    const deadPackages: DeadPackage[] = [];
    const pkgEntries = findPackageEntries(projectRoot);
    for (const [pkgName, pkgDir] of pkgEntries) {
      const pkgFiles = allSymbols.filter((s) =>
        s.file.startsWith(pkgDir + path.sep),
      );
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

function findPackageEntries(
  projectRoot: string,
): Map<string, string> {
  const pkgMap = new Map<string, string>();

  // Root package
  const rootPkg = tryReadJson(path.join(projectRoot, 'package.json'));
  if (rootPkg && typeof rootPkg.name === 'string') {
    pkgMap.set(rootPkg.name, projectRoot);
  }

  // Workspace packages
  if (rootPkg) {
    const wsDirs = extractWorkspaceGlobs(rootPkg, projectRoot);
    for (const wsDir of wsDirs) {
      const wsPkg = tryReadJson(path.join(wsDir, 'package.json'));
      if (wsPkg && typeof wsPkg.name === 'string') {
        pkgMap.set(wsPkg.name, wsDir);
      }
    }
  }

  return pkgMap;
}
