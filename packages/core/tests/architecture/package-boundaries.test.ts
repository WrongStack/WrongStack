import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Module-relative so the suite passes from any vitest root (the package
// `test` script runs vitest with --root ../.. from the package directory).
const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../../..', import.meta.url)));
const CORE_SRC = path.resolve(REPO_ROOT, 'packages/core/src');

/**
 * Allowed self-imports when scanning for @wrongstack/* workspace imports.
 * @wrongstack/core is always allowed (re-export barrel).
 * @wrongstack/kernel and @wrongstack/observability will be added once extracted.
 */
const ALLOWED_SELF_IMPORTS = new Set([
  '@wrongstack/core',
  '@wrongstack/core/utils/dispatcher-types', // dispatcher-types.d.ts re-exports from itself in JSDoc examples
  // Re-export subpaths added when DefaultTaskStore was promoted to the
  // public API. The exports field only declares the whole `./tasking`
  // subpath, so re-exports of individual files inside `./tasking/` have
  // to use these deeper paths until either (a) the exports field is
  // widened to `./tasking/*`, or (b) the file moves to `./index.ts`.
  '@wrongstack/core/tasking/task-tracker.js',
  '@wrongstack/core/tasking/task-store.js',
  // @wrongstack/kanban and @wrongstack/persistence sit below Core in the
  // workspace graph. Kanban itself depends only on persistence.
  // Note: @wrongstack/sdd stays ABOVE core (it depends on core) and must not
  // appear here — core reaches it only via lazy createRequire in goal/.
  '@wrongstack/kanban',
  '@wrongstack/persistence',
]);

/**
 * Core subdirectories that form the internal layer graph.
 * Listed from lowest level (kernel) to highest (application).
 */
const LAYERS = [
  'kernel',
  'types',
  'infrastructure',
  'core',
  'models',
  'security',
  'registry',
  'execution',
  'storage',
  'coordination',
  'plugin',
  'extension',
  'observability',
  'sdd',
  'skills',
] as const;

type LayerName = (typeof LAYERS)[number];

function layerOf(filePath: string): LayerName | null {
  const rel = path.relative(CORE_SRC, filePath);
  const seg = rel.split(path.sep)[0]!;
  return (LAYERS as readonly string[]).includes(seg) ? (seg as LayerName) : null;
}

function isUpwardRuntimeImport(
  sourceLayer: LayerName,
  targetLayer: LayerName,
  typeOnly: boolean,
): boolean {
  return !typeOnly && LAYERS.indexOf(sourceLayer) < LAYERS.indexOf(targetLayer);
}

/**
 * Matches import specifiers: `from '...'`, `import '...'`, `import(...)`.
 * Captures the specifier string (without quotes).
 */
const IMPORT_RE =
  /(?:from\s+['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\))/g;

/**
 * Returns the import specifier if the match is a relative internal import
 * (starts with '../'), otherwise null.
 */
function relativeImport(spec: string): string | null {
  return spec.startsWith('../') ? spec : null;
}

/**
 * Given a relative import path like '../types/errors.js', resolves it to the
 * source subdirectory name (e.g. 'types'). Returns null if it cannot be
 * determined.
 */
function importTargetDir(relativePath: string): string | null {
  // '../types/errors.js' → 'types'
  const segments = relativePath.replace(/^\.\.\//, '').split('/');
  return segments[0] ?? null;
}

/**
 * Checks whether an import line uses `import type` (type-only import).
 * Type-only imports are erased at runtime and do not create runtime coupling.
 */
function isTypeOnlyImport(line: string): boolean {
  // Remove comments first to avoid false positives
  const withoutComments = line.replace(/\/\/.*$/, '').replace(/\/\*[\s\S]*?\*\//g, '');
  return /\bimport\s+type\b/.test(withoutComments);
}

async function walk(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(full)));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

// ── Cross-package boundary tests ───────────────────────────────────────────────

describe('core cross-package boundaries', () => {
  const FORBIDDEN_WORKSPACE_IMPORT =
    /(?:from\s+['"]|import\s+['"]|import\s*\(\s*['"])(@wrongstack\/[^'"]+)/g;

  it('does not import higher-level WrongStack packages', async () => {
    const files = await walk(CORE_SRC);
    const violations: string[] = [];

    for (const file of files) {
      const text = await fs.readFile(file, 'utf8');
      for (const match of text.matchAll(FORBIDDEN_WORKSPACE_IMPORT)) {
        const specifier = match[1];
        if (!specifier || ALLOWED_SELF_IMPORTS.has(specifier)) continue;
        violations.push(`${path.relative(process.cwd(), file)} -> ${specifier}`);
      }
    }

    expect(violations).toEqual([]);
  });
});

// ── Internal layer rule tests ──────────────────────────────────────────────────

/**
 * Internal layer dependency rules (from docs/architecture-rules.md):
 *
 * Rule 2  kernel/  may import runtime values only from types/.
 *           All other imports from other subdirs must be `import type`.
 *           Exception: WrongStackError from types/ is a permitted runtime import.
 *
 * Rule 3  core/    may not import runtime values from execution/,
 *           storage/, or coordination/.
 *
 * Rule 4  observability/ may not import runtime values from core/,
 *           execution/, storage/, or coordination/.
 *
 * Rule 5  security/ may not import from execution/, storage/, or coordination/.
 *
 * Rule 6  registry/ may not import from execution/, storage/, or coordination/.
 *
 * "Runtime import" means an import that is NOT `import type`.
 * `import type` from any subdir is always allowed (type-only imports
 * are erased at compile time and create no runtime coupling).
 */

describe('core internal layer rules', () => {
  it('classifies general upward runtime imports without rejecting type-only or downward imports', () => {
    expect(isUpwardRuntimeImport('plugin', 'skills', false)).toBe(true);
    expect(isUpwardRuntimeImport('plugin', 'skills', true)).toBe(false);
    expect(isUpwardRuntimeImport('skills', 'plugin', false)).toBe(false);
  });

  /**
   * Collects all violations for a single file. A violation is a runtime import
   * from a forbidden subdirectory, given the file's own layer.
   */
  async function collectViolations(file: string): Promise<string[]> {
    const myLayer = layerOf(file);
    if (!myLayer) return [];

    const text = await fs.readFile(file, 'utf8');
    const violations: string[] = [];
    const importLines: Array<{ line: string; spec: string }> = [];

    // Collect import lines for context
    for (const importLine of text.split('\n')) {
      IMPORT_RE.lastIndex = 0;
      for (const match of importLine.matchAll(IMPORT_RE)) {
        const spec = match[1] ?? match[2] ?? match[3];
        if (!spec) continue;
        const rel = relativeImport(spec);
        if (!rel) continue;
        importLines.push({ line: importLine.trim(), spec: rel });
      }
    }

    for (const { line, spec } of importLines) {
      const targetDir = importTargetDir(spec);
      if (!targetDir) continue;
      const targetLayer = (LAYERS as readonly string[]).includes(targetDir)
        ? (targetDir as LayerName)
        : null;
      if (!targetLayer) continue;
      if (targetLayer === myLayer) continue; // same subdir — always ok

      const typeOnly = isTypeOnlyImport(line);

      // ── Rule 2: kernel/ ───────────────────────────────────────────────────
      if (myLayer === 'kernel') {
        // Only WrongStackError from types/ is allowed as a runtime import.
        // All other cross-samedir imports must be type-only.
        if (!typeOnly && targetLayer !== 'types') {
          violations.push(
            `kernel imports runtime value from '${targetDir}/' — only 'types/' (WrongStackError) is permitted`,
          );
        }
        if (!typeOnly && targetLayer === 'types' && !line.includes('WrongStackError')) {
          // Example: kernel importing something else from types/ as a value
          // WrongStackError is explicitly allowed; other value imports are violations
          violations.push(
            `kernel imports runtime value '${targetDir}/' — only WrongStackError from types/ is permitted`,
          );
        }
        continue;
      }

      // ── Rule 3: core/ ─────────────────────────────────────────────────────
      if (myLayer === 'core') {
        const forbidden = new Set<LayerName>(['execution', 'storage', 'coordination']);
        if (forbidden.has(targetLayer) && !typeOnly) {
          violations.push(`core/ imports runtime value from '${targetDir}/' — forbidden by Rule 3`);
        }
        continue;
      }

      // ── Rule 4: observability/ ────────────────────────────────────────────
      if (myLayer === 'observability') {
        const forbidden = new Set<LayerName>(['core', 'execution', 'storage', 'coordination']);
        if (forbidden.has(targetLayer) && !typeOnly) {
          violations.push(
            `observability/ imports runtime value from '${targetDir}/' — forbidden by Rule 4`,
          );
        }
        continue;
      }

      // ── Rule 5: security/ ─────────────────────────────────────────────────
      if (myLayer === 'security') {
        const forbidden = new Set<LayerName>(['execution', 'storage', 'coordination']);
        if (forbidden.has(targetLayer) && !typeOnly) {
          violations.push(
            `security/ imports runtime value from '${targetDir}/' — forbidden by Rule 5`,
          );
        }
        continue;
      }

      // ── Rule 6: registry/ ─────────────────────────────────────────────────
      if (myLayer === 'registry') {
        const forbidden = new Set<LayerName>(['execution', 'storage', 'coordination']);
        if (forbidden.has(targetLayer) && !typeOnly) {
          violations.push(
            `registry/ imports runtime value from '${targetDir}/' — forbidden by Rule 6`,
          );
        }
        continue;
      }

      // ── Rule 7: infrastructure/ ────────────────────────────────────────────
      // infrastructure/ is the system integration layer (logger, token counter,
      // path resolver, etc.). It must not reach into domain/execution/storage/
      // coordination layers at runtime level. Type-only imports from any layer
      // are always fine.
      if (myLayer === 'infrastructure') {
        const forbidden = new Set<LayerName>([
          'core',
          'models',
          'security',
          'registry',
          'execution',
          'storage',
          'coordination',
          'plugin',
          'extension',
          'observability',
          'sdd',
          'skills',
        ]);
        if (forbidden.has(targetLayer) && !typeOnly) {
          violations.push(
            `infrastructure/ imports runtime value from '${targetDir}/' — forbidden by Rule 7`,
          );
        }
        continue;
      }

      // ── Rule 8: models/ ───────────────────────────────────────────────────
      // models/ (ModelSelector, ModelsRegistry, ModeStore) must not import
      // runtime values from execution/, storage/, or coordination/.
      if (myLayer === 'models') {
        const forbidden = new Set<LayerName>(['execution', 'storage', 'coordination']);
        if (forbidden.has(targetLayer) && !typeOnly) {
          violations.push(
            `models/ imports runtime value from '${targetDir}/' — forbidden by Rule 8`,
          );
        }
        continue;
      }

      // ── Rule 9: extension/ ─────────────────────────────────────────────────
      // extension/ (ExtensionRegistry) must not import runtime values from
      // execution/, storage/, or coordination/.
      if (myLayer === 'extension') {
        const forbidden = new Set<LayerName>(['execution', 'storage', 'coordination']);
        if (forbidden.has(targetLayer) && !typeOnly) {
          violations.push(
            `extension/ imports runtime value from '${targetDir}/' — forbidden by Rule 9`,
          );
        }
        continue;
      }

      // ── General upward-import check ──────────────────────────────────────
      // Layers without a narrower rule above still cannot import runtime
      // values from a higher layer. Type-only imports remain allowed.
      if (isUpwardRuntimeImport(myLayer, targetLayer, typeOnly)) {
        violations.push(
          `layer '${myLayer}' imports runtime value from '${targetDir}/' (higher layer) — general upward-import violation`,
        );
      }
    }

    return violations;
  }

  it('kernel/ only imports runtime values from types/ (WrongStackError)', async () => {
    const kernelFiles = (await walk(CORE_SRC)).filter((f) => layerOf(f) === 'kernel');
    const allViolations: string[] = [];

    for (const file of kernelFiles) {
      const violations = await collectViolations(file);
      for (const v of violations) {
        allViolations.push(`${path.relative(process.cwd(), file)}: ${v}`);
      }
    }

    expect(allViolations).toEqual([]);
  });

  it('core/ does not import runtime values from execution/, storage/, or coordination/', async () => {
    const coreFiles = (await walk(CORE_SRC)).filter((f) => layerOf(f) === 'core');
    const allViolations: string[] = [];

    for (const file of coreFiles) {
      const violations = await collectViolations(file);
      for (const v of violations) {
        allViolations.push(`${path.relative(process.cwd(), file)}: ${v}`);
      }
    }

    expect(allViolations).toEqual([]);
  });

  it('observability/ does not import runtime values from core/, execution/, storage/, or coordination/', async () => {
    const obsFiles = (await walk(CORE_SRC)).filter((f) => layerOf(f) === 'observability');
    const allViolations: string[] = [];

    for (const file of obsFiles) {
      const violations = await collectViolations(file);
      for (const v of violations) {
        allViolations.push(`${path.relative(process.cwd(), file)}: ${v}`);
      }
    }

    expect(allViolations).toEqual([]);
  });

  it('security/ does not import runtime values from execution/, storage/, or coordination/', async () => {
    const secFiles = (await walk(CORE_SRC)).filter((f) => layerOf(f) === 'security');
    const allViolations: string[] = [];

    for (const file of secFiles) {
      const violations = await collectViolations(file);
      for (const v of violations) {
        allViolations.push(`${path.relative(process.cwd(), file)}: ${v}`);
      }
    }

    expect(allViolations).toEqual([]);
  });

  it('registry/ does not import runtime values from execution/, storage/, or coordination/', async () => {
    const regFiles = (await walk(CORE_SRC)).filter((f) => layerOf(f) === 'registry');
    const allViolations: string[] = [];

    for (const file of regFiles) {
      const violations = await collectViolations(file);
      for (const v of violations) {
        allViolations.push(`${path.relative(process.cwd(), file)}: ${v}`);
      }
    }

    expect(allViolations).toEqual([]);
  });

  it('infrastructure/ does not import runtime values from domain/execution/storage/coordination layers', async () => {
    const infraFiles = (await walk(CORE_SRC)).filter((f) => layerOf(f) === 'infrastructure');
    const allViolations: string[] = [];

    for (const file of infraFiles) {
      const violations = await collectViolations(file);
      for (const v of violations) {
        allViolations.push(`${path.relative(process.cwd(), file)}: ${v}`);
      }
    }

    expect(allViolations).toEqual([]);
  });

  it('models/ does not import runtime values from execution/, storage/, or coordination/', async () => {
    const modelFiles = (await walk(CORE_SRC)).filter((f) => layerOf(f) === 'models');
    const allViolations: string[] = [];

    for (const file of modelFiles) {
      const violations = await collectViolations(file);
      for (const v of violations) {
        allViolations.push(`${path.relative(process.cwd(), file)}: ${v}`);
      }
    }

    expect(allViolations).toEqual([]);
  });

  it('extension/ does not import runtime values from execution/, storage/, or coordination/', async () => {
    const extFiles = (await walk(CORE_SRC)).filter((f) => layerOf(f) === 'extension');
    const allViolations: string[] = [];

    for (const file of extFiles) {
      const violations = await collectViolations(file);
      for (const v of violations) {
        allViolations.push(`${path.relative(process.cwd(), file)}: ${v}`);
      }
    }

    expect(allViolations).toEqual([]);
  });
});

// ── Bidirectional coupling detection ─────────────────────────────────────────

type DirectedEdge = `${LayerName}→${LayerName}`;

/**
 * Scans all files in CORE_SRC and builds a map of all directed runtime
 * import edges between layers. An edge A→B means at least one file in
 * layer A has a runtime (non-type-only) import from layer B.
 */
async function buildRuntimeEdgeSet(): Promise<Set<DirectedEdge>> {
  const edges = new Set<DirectedEdge>();
  const files = await walk(CORE_SRC);

  for (const file of files) {
    const myLayer = layerOf(file);
    if (!myLayer) continue;

    const text = await fs.readFile(file, 'utf8');
    const importLines: Array<{ line: string; spec: string }> = [];

    for (const importLine of text.split('\n')) {
      IMPORT_RE.lastIndex = 0;
      for (const match of importLine.matchAll(IMPORT_RE)) {
        const spec = match[1] ?? match[2] ?? match[3];
        if (!spec) continue;
        const rel = relativeImport(spec);
        if (!rel) continue;
        importLines.push({ line: importLine.trim(), spec: rel });
      }
    }

    for (const { line, spec } of importLines) {
      const targetDir = importTargetDir(spec);
      if (!targetDir) continue;
      const targetLayer = (LAYERS as readonly string[]).includes(targetDir)
        ? (targetDir as LayerName)
        : null;
      if (!targetLayer) continue;
      if (targetLayer === myLayer) continue;
      if (isTypeOnlyImport(line)) continue; // type-only = no runtime edge

      const edge = `${myLayer}→${targetLayer}` as DirectedEdge;
      edges.add(edge);
    }
  }

  return edges;
}

describe('core bidirectional coupling', () => {
  /**
   * layers excluded from the bidirectional check:
   *
   * types/    — public-type barrel for the whole package. Its index.ts
   *              re-exports from nearly every other layer (e.g. types/index.ts
   *              → execution/tool-executor.js). Treating those re-exports as
   *              "types → X" edges produces false positives: every layer that
   *              imports from types/ would appear to have a reverse edge back
   *              through the barrel. types/ is the shared contract surface,
   *              not a domain layer.
   *
   * defaults/ is also a compatibility barrel, but it is intentionally absent
   * from LAYERS, so layerOf() skips it before this graph is built.
   */
  const EXCLUDED = new Set<LayerName>(['types']);

  it('no two layers should have mutual runtime dependencies', async () => {
    const edges = await buildRuntimeEdgeSet();
    const violations: string[] = [];

    for (const edge of edges) {
      const [from, to] = edge.split('→') as [LayerName, LayerName];
      if (EXCLUDED.has(from) || EXCLUDED.has(to)) continue;
      const reverse = `${to}→${from}` as DirectedEdge;
      if (edges.has(reverse)) {
        violations.push(`${from} ↔ ${to}: bidirectional runtime coupling detected`);
      }
    }

    expect(violations).toEqual([]);
  });

  it('no layer cycle should exist in the runtime dependency graph', async () => {
    const edges = await buildRuntimeEdgeSet();

    // Build adjacency list: node → Set of outgoing neighbours
    const adj = new Map<LayerName, Set<LayerName>>();
    for (const edge of edges) {
      const [from, to] = edge.split('→') as [LayerName, LayerName];
      if (EXCLUDED.has(from) || EXCLUDED.has(to)) continue;
      if (!adj.has(from)) adj.set(from, new Set());
      adj.get(from)!.add(to);
    }

    // DFS with three colours: white=unvisited, gray=in-current-path, black=done.
    // Any gray→gray edge during DFS signals a cycle.
    const WHITE = 0;
    const GRAY = 1;
    const BLACK = 2;
    const colour = new Map<LayerName, number>();
    for (const node of adj.keys()) colour.set(node, WHITE);

    const cycles: string[] = [];
    function dfs(node: LayerName, path: LayerName[]): void {
      if (colour.get(node) === GRAY) {
        const cycleStart = path.indexOf(node);
        const cycle = [...path.slice(cycleStart), node];
        cycles.push(cycle.join(' → '));
        return;
      }
      if (colour.get(node) === BLACK) return;
      colour.set(node, GRAY);
      for (const neighbour of adj.get(node) ?? []) {
        dfs(neighbour, [...path, node]);
      }
      colour.set(node, BLACK);
    }

    for (const node of adj.keys()) {
      if (colour.get(node) === WHITE) dfs(node, []);
    }

    expect(cycles).toEqual([]);
  });
});

// ── P0/P1 manifest regression ────────────────────────────────────────────────

/**
 * Pin the manifest contracts sealed by PR-08 and PR-10: core no longer
 * declares `@wrongstack/security-scanner` (PR-08) or
 * `@wrongstack/sdd` (PR-10) as workspace dependencies. The cross-package
 * boundary test above only scans runtime imports in core/src, so a future
 * contributor could silently restore either edge by re-adding the entry
 * to package.json without any import. These assertions keep the
 * workspace-DAG PR-11 contract honest and break loudly if either edge
 * creeps back.
 */
describe('P0/P1 manifest regression (PR-08 + PR-10)', () => {
  it('core does not declare forbidden workspace dependencies in package.json', async () => {
    const pkgRaw = await fs.readFile(
      path.resolve(REPO_ROOT, 'packages/core/package.json'),
      'utf8',
    );
    const pkg = JSON.parse(pkgRaw) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const FORBIDDEN = ['@wrongstack/security-scanner', '@wrongstack/sdd'] as const;
    const edges: Array<{ field: string; spec: string }> = [];
    for (const [field, set] of [
      ['dependencies', pkg.dependencies],
      ['optionalDependencies', pkg.optionalDependencies],
      ['peerDependencies', pkg.peerDependencies],
      ['devDependencies', pkg.devDependencies],
    ] as const) {
      for (const spec of Object.keys(set ?? {})) {
        if ((FORBIDDEN as readonly string[]).includes(spec)) {
          edges.push({ field, spec });
        }
      }
    }
    expect(edges).toEqual([]);
  });
});

// ── Workspace DAG assertion (PR-11) ──────────────────────────────────────────

/**
 * The workspace package graph (dependencies + optionalDependencies +
 * peerDependencies) must be a DAG. Before PR-08 + PR-10, two cycles
 * existed (core↔sdd and core↔security-scanner); both are now broken.
 * This test prevents them from silently creeping back.
 */
describe('workspace DAG (PR-11)', () => {
  const WORKSPACE_PACKAGES_DIR = path.resolve(REPO_ROOT, 'packages');

  async function collectWorkspaceGraphEdges(): Promise<Set<string>> {
    const entries = await fs.readdir(WORKSPACE_PACKAGES_DIR, { withFileTypes: true });
    const edges = new Set<string>();
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const pkgPath = path.join(WORKSPACE_PACKAGES_DIR, entry.name, 'package.json');
      if (!existsSync(pkgPath)) continue;
      const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8')) as {
        name: string;
        dependencies?: Record<string, string>;
        optionalDependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
      };
      const depFields = [pkg.dependencies, pkg.optionalDependencies, pkg.peerDependencies];
      for (const field of depFields) {
        for (const depName of Object.keys(field ?? {})) {
          if (depName.startsWith('@wrongstack/')) {
            edges.add(`${pkg.name} → ${depName}`);
          }
        }
      }
    }
    return edges;
  }

  it('the workspace dependency graph has no cycles', async () => {
    const edges = await collectWorkspaceGraphEdges();

    // Build adjacency list.
    const adj = new Map<string, Set<string>>();
    const nodeSet = new Set<string>();
    for (const edge of edges) {
      const [from, to] = edge.split(' → ');
      nodeSet.add(from!);
      nodeSet.add(to!);
      if (!adj.has(from!)) adj.set(from!, new Set());
      adj.get(from!)!.add(to!);
    }

    // DFS cycle detection (white-gray-black).
    const WHITE = 0,
      GRAY = 1,
      BLACK = 2;
    const colour = new Map<string, number>();
    for (const n of nodeSet) colour.set(n, WHITE);
    const cycles: string[] = [];

    function dfs(node: string, path: string[]): void {
      colour.set(node, GRAY);
      const neighbours = adj.get(node) ?? new Set<string>();
      for (const next of neighbours) {
        if (colour.get(next) === GRAY) {
          const cyclePath = [...path, node, next].join(' → ');
          cycles.push(cyclePath);
          return;
        }
        if (colour.get(next) === WHITE) {
          dfs(next, [...path, node]);
        }
      }
      colour.set(node, BLACK);
    }

    for (const node of [...nodeSet].sort()) {
      if (colour.get(node) === WHITE) {
        dfs(node, []);
      }
    }

    expect(cycles).toEqual([]);
  });
});
