/**
 * Ecosystem-aware project structure detection.
 *
 * The Code Atlas groups files into "packages". That grouping used to be two
 * hardcoded npm-monorepo rules (`packages/<x>` → `@wrongstack/<x>`, `apps/<x>` →
 * `app:<x>`), which put every Go, Python, Rust or JVM file of any other repo
 * into a single `(root)` blob with no internal structure.
 *
 * This module derives the grouping from the markers each ecosystem actually
 * uses, and — importantly — at the granularity that ecosystem's developers
 * think in:
 *
 * | ecosystem | marker                      | one package node is…            |
 * |-----------|-----------------------------|---------------------------------|
 * | npm       | `package.json`              | the package (marker directory)  |
 * | Cargo     | `Cargo.toml`                | the crate (marker directory)    |
 * | Go        | `go.mod`                    | **a directory** — Go's own unit |
 * | Python    | `pyproject.toml`/`setup.py` | the dotted package (`a.b.c`)    |
 * | Maven     | `pom.xml`                   | the project                     |
 * | Gradle    | `build.gradle[.kts]`        | the project                     |
 * | .NET      | `*.csproj`                  | the project                     |
 *
 * Detection runs once per index over the already-discovered (and already
 * gitignore-filtered) file list, so it costs a bounded number of reads rather
 * than a second tree walk.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { detectLang } from './languages.js';
import type { SymbolLang } from './schema.js';

/** Package-manager ecosystem a module root belongs to. */
type ModuleRootKind = 'npm' | 'cargo' | 'go' | 'python' | 'maven' | 'gradle' | 'dotnet';

interface ModuleRoot {
  /** Absolute directory holding the marker file, forward-slash normalized. */
  dir: string;
  kind: ModuleRootKind;
  /** Human-facing grouping label, e.g. `@scope/pkg`, `crate:parser`. */
  name: string;
  /**
   * Import prefix this root owns, when its ecosystem has one:
   * the `module` line of `go.mod`, the crate name for Cargo, the distribution
   * name for Python. `undefined` when imports are not prefixed by the root.
   */
  importPath?: string | undefined;
  /**
   * Directories imports resolve against, forward-slash normalized absolute
   * paths. JVM layouts put this at `src/main/java`; Python projects commonly
   * use `src/`; most ecosystems just use the root directory itself.
   */
  sourceRoots: string[];
}

/** Everything the resolver and the package labeller need, computed once. */
export interface ProjectStructure {
  projectRoot: string;
  /** Sorted longest-dir-first so a nearest-ancestor lookup is a linear scan. */
  roots: ModuleRoot[];
}

// ─── Marker parsing ───────────────────────────────────────────────────────────

/** Normalize to forward slashes; every path in this module is compared this way. */
export function toPortablePath(file: string): string {
  return file.replace(/\\/g, '/');
}

async function readTextIfPresent(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}

function parsePackageJsonName(source: string): string | undefined {
  try {
    const parsed = JSON.parse(source) as { name?: unknown };
    return typeof parsed.name === 'string' && parsed.name ? parsed.name : undefined;
  } catch {
    return undefined;
  }
}

/** First `module <path>` directive of a go.mod, ignoring comments. */
function parseGoModulePath(source: string): string | undefined {
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.replace(/\/\/.*$/, '').trim();
    const match = /^module\s+(\S+)/.exec(line);
    if (match?.[1]) return match[1].replace(/^["']|["']$/g, '');
  }
  return undefined;
}

/**
 * `name = "…"` inside a given TOML table. Deliberately a scanner rather than a
 * TOML parse: we need two keys out of files that may use any TOML feature, and
 * pulling in a parser for that is not worth the dependency.
 */
function parseTomlTableName(source: string, tables: string[]): string | undefined {
  let current = '';
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    // `[[…]]` opens an array-of-tables element — a context none of the tracked
    // tables live in. Without resetting `current`, a `name = "…"` inside the
    // block (Poetry's `[[tool.poetry.authors]]` carries author names) would
    // leak out as the package name.
    if (line.startsWith('[[')) {
      current = '\u0000'; // sentinel no tracked table name can equal
      continue;
    }
    const table = /^\[([^\]]+)\]$/.exec(line);
    if (table?.[1]) {
      current = table[1].trim();
      continue;
    }
    if (!tables.includes(current)) continue;
    const match = /^name\s*=\s*["']([^"']+)["']/.exec(line);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

/**
 * `<artifactId>` of the project itself. The `<parent>` block declares one too
 * and appears first in most poms, so it is removed before matching.
 */
function parsePomArtifactId(source: string): string | undefined {
  const withoutParent = source.replace(/<parent>[\s\S]*?<\/parent>/g, '');
  return /<artifactId>\s*([^<\s]+)\s*<\/artifactId>/.exec(withoutParent)?.[1];
}

// ─── Root detection ───────────────────────────────────────────────────────────

/** Languages whose roots we bother probing for, keyed by the marker's ecosystem. */
const LANGS_BY_KIND: Readonly<Record<ModuleRootKind, readonly SymbolLang[]>> = {
  npm: ['ts', 'tsx', 'js', 'jsx', 'vue', 'svelte'],
  cargo: ['rs'],
  go: ['go'],
  python: ['py'],
  maven: ['java', 'kotlin', 'scala'],
  gradle: ['java', 'kotlin', 'scala'],
  dotnet: ['csharp'],
};

/** Ancestor directories of `dir` up to and including `stopAt`. */
function ancestorsOf(dir: string, stopAt: string): string[] {
  const out: string[] = [];
  let current = dir;
  for (;;) {
    out.push(current);
    if (current === stopAt || current.length <= stopAt.length) break;
    const parent = path.posix.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return out;
}

interface MarkerProbe {
  kind: ModuleRootKind;
  /** Marker filename, read relative to the candidate directory. */
  file: string;
  /** Build a root from the marker's contents; `undefined` skips the candidate. */
  build: (dir: string, source: string) => Omit<ModuleRoot, 'dir' | 'kind'> | undefined;
}

const MARKER_PROBES: readonly MarkerProbe[] = [
  {
    kind: 'npm',
    file: 'package.json',
    build: (dir, source) => {
      const name = parsePackageJsonName(source) ?? path.posix.basename(dir);
      return { name, importPath: name, sourceRoots: [dir] };
    },
  },
  {
    kind: 'cargo',
    file: 'Cargo.toml',
    build: (dir, source) => {
      const name = parseTomlTableName(source, ['package']);
      // A virtual manifest ([workspace] with no [package]) is not a crate.
      if (!name) return undefined;
      return {
        name: `crate:${name}`,
        // Rust paths use underscores where crate names often use dashes.
        importPath: name.replace(/-/g, '_'),
        sourceRoots: [path.posix.join(dir, 'src')],
      };
    },
  },
  {
    kind: 'go',
    file: 'go.mod',
    build: (dir, source) => {
      const modulePath = parseGoModulePath(source);
      if (!modulePath) return undefined;
      return { name: `go:${modulePath}`, importPath: modulePath, sourceRoots: [dir] };
    },
  },
  {
    kind: 'python',
    file: 'pyproject.toml',
    build: (dir, source) => {
      const name =
        parseTomlTableName(source, ['project', 'tool.poetry']) ?? path.posix.basename(dir);
      return {
        name: `py:${name}`,
        importPath: undefined,
        // `src/` layout is the packaging-guide default; the root itself covers
        // the flat layout. Both are probed, missing ones simply never match.
        sourceRoots: [path.posix.join(dir, 'src'), dir],
      };
    },
  },
  {
    kind: 'python',
    file: 'setup.py',
    build: (dir) => ({
      name: `py:${path.posix.basename(dir)}`,
      importPath: undefined,
      sourceRoots: [path.posix.join(dir, 'src'), dir],
    }),
  },
  {
    kind: 'maven',
    file: 'pom.xml',
    build: (dir, source) => {
      const artifactId = parsePomArtifactId(source) ?? path.posix.basename(dir);
      return {
        name: `mvn:${artifactId}`,
        importPath: undefined,
        sourceRoots: [
          path.posix.join(dir, 'src/main/java'),
          path.posix.join(dir, 'src/main/kotlin'),
          path.posix.join(dir, 'src/main/scala'),
          path.posix.join(dir, 'src/test/java'),
        ],
      };
    },
  },
  {
    kind: 'gradle',
    file: 'build.gradle',
    build: (dir) => buildGradleRoot(dir),
  },
  {
    kind: 'gradle',
    file: 'build.gradle.kts',
    build: (dir) => buildGradleRoot(dir),
  },
];

function buildGradleRoot(dir: string): Omit<ModuleRoot, 'dir' | 'kind'> {
  return {
    name: `gradle:${path.posix.basename(dir)}`,
    importPath: undefined,
    sourceRoots: [
      path.posix.join(dir, 'src/main/java'),
      path.posix.join(dir, 'src/main/kotlin'),
      path.posix.join(dir, 'src/main/scala'),
    ],
  };
}

/** `*.csproj` needs a directory listing rather than a fixed filename. */
async function probeDotnetRoot(dir: string): Promise<ModuleRoot | undefined> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return undefined;
  }
  const project = entries.find((entry) => entry.toLowerCase().endsWith('.csproj'));
  if (!project) return undefined;
  const name = project.slice(0, -'.csproj'.length);
  return {
    dir,
    kind: 'dotnet',
    name: `csproj:${name}`,
    importPath: undefined,
    sourceRoots: [dir],
  };
}

/**
 * Detect every module root reachable from the indexed file set.
 *
 * Candidate directories are the ancestors of directories that actually contain
 * files of the relevant language, so a repo with no Go code never stats a
 * single `go.mod`.
 */
export async function detectModuleRoots(
  projectRoot: string,
  files: readonly string[],
): Promise<ProjectStructure> {
  const root = toPortablePath(projectRoot).replace(/\/+$/, '');

  // Directory → languages present directly in it.
  const langsByDir = new Map<string, Set<SymbolLang>>();
  for (const file of files) {
    const portable = toPortablePath(file);
    const lang = detectLang(portable);
    if (!lang) continue;
    const dir = path.posix.dirname(portable);
    let langs = langsByDir.get(dir);
    if (!langs) {
      langs = new Set();
      langsByDir.set(dir, langs);
    }
    langs.add(lang);
  }

  // Candidate directory → languages present in it or anywhere beneath it.
  const candidates = new Map<string, Set<SymbolLang>>();
  for (const [dir, langs] of langsByDir) {
    for (const ancestor of ancestorsOf(dir, root)) {
      let merged = candidates.get(ancestor);
      if (!merged) {
        merged = new Set();
        candidates.set(ancestor, merged);
      }
      for (const lang of langs) merged.add(lang);
    }
  }

  const roots: ModuleRoot[] = [];
  await Promise.all(
    [...candidates].map(async ([dir, langs]) => {
      for (const probe of MARKER_PROBES) {
        if (!LANGS_BY_KIND[probe.kind].some((lang) => langs.has(lang))) continue;
        const source = await readTextIfPresent(path.posix.join(dir, probe.file));
        if (source === undefined) continue;
        const built = probe.build(dir, source);
        if (built) roots.push({ dir, kind: probe.kind, ...built });
      }
      if (LANGS_BY_KIND.dotnet.some((lang) => langs.has(lang))) {
        const dotnet = await probeDotnetRoot(dir);
        if (dotnet) roots.push(dotnet);
      }
    }),
  );

  // Deepest first: nearest-ancestor lookups become a linear scan with an
  // early exit, and a nested package always wins over its workspace root.
  roots.sort((a, b) => b.dir.length - a.dir.length || a.dir.localeCompare(b.dir));
  return { projectRoot: root, roots };
}

// ─── Package labelling ────────────────────────────────────────────────────────

/** Nearest module root that contains `file`, preferring the deepest match. */
export function findOwningRoot(
  structure: ProjectStructure,
  file: string,
  kinds?: readonly ModuleRootKind[],
): ModuleRoot | undefined {
  const portable = toPortablePath(file);
  for (const root of structure.roots) {
    if (kinds && !kinds.includes(root.kind)) continue;
    if (portable === root.dir || portable.startsWith(`${root.dir}/`)) return root;
  }
  return undefined;
}

/**
 * Legacy npm-monorepo fallback, kept for repos with no manifest at all (and for
 * the existing tests that assert on it). Only consulted when marker detection
 * finds no owning root.
 */
export function derivePackageFromLayout(filePath: string): string | undefined {
  const portable = toPortablePath(filePath);
  const packagesIdx = portable.indexOf('/packages/');
  if (packagesIdx !== -1) {
    const segment = portable.slice(packagesIdx + '/packages/'.length).split('/')[0];
    if (segment) return `@wrongstack/${segment}`;
  }
  const appsIdx = portable.indexOf('/apps/');
  if (appsIdx !== -1) {
    const segment = portable.slice(appsIdx + '/apps/'.length).split('/')[0];
    if (segment) return `app:${segment}`;
  }
  return undefined;
}

/**
 * Dotted Python package for a file, derived from the `__init__.py` chain.
 * `pkg/sub/mod.py` under a source root becomes `pkg.sub`.
 */
function pythonPackageLabel(
  structure: ProjectStructure,
  file: string,
  initDirs: ReadonlySet<string>,
): string | undefined {
  const portable = toPortablePath(file);
  const dir = path.posix.dirname(portable);
  if (!initDirs.has(dir)) return undefined;

  const segments: string[] = [];
  let current = dir;
  while (initDirs.has(current) && current.length > structure.projectRoot.length) {
    segments.unshift(path.posix.basename(current));
    current = path.posix.dirname(current);
  }
  return segments.length > 0 ? `py:${segments.join('.')}` : undefined;
}

/**
 * Assign every indexed file its Code Atlas package label.
 *
 * Go is grouped per directory because that is Go's compilation unit — one node
 * per module would collapse an entire repository into a single dot. Python is
 * grouped by its dotted package for the same reason. Every other ecosystem is
 * grouped by its manifest directory.
 */
export function assignPackageLabels(
  structure: ProjectStructure,
  files: readonly string[],
): Map<string, string> {
  // Directories that are Python packages (contain __init__.py).
  const initDirs = new Set<string>();
  for (const file of files) {
    const portable = toPortablePath(file);
    if (path.posix.basename(portable) === '__init__.py') {
      initDirs.add(path.posix.dirname(portable));
    }
  }

  const labels = new Map<string, string>();
  for (const file of files) {
    const portable = toPortablePath(file);
    const lang = detectLang(portable);

    if (lang === 'go') {
      // A Go package is a directory. Label it by its import path when the
      // owning module is known, so the node reads the way an import does.
      const owner = findOwningRoot(structure, portable, ['go']);
      const dir = path.posix.dirname(portable);
      if (owner?.importPath) {
        const relative = path.posix.relative(owner.dir, dir);
        labels.set(file, relative ? `${owner.importPath}/${relative}` : owner.importPath);
      } else {
        labels.set(file, `go:${path.posix.relative(structure.projectRoot, dir) || '.'}`);
      }
      continue;
    }

    if (lang === 'py') {
      const dotted = pythonPackageLabel(structure, portable, initDirs);
      if (dotted) {
        labels.set(file, dotted);
        continue;
      }
    }

    const owner = findOwningRoot(structure, portable);
    const label = owner?.name ?? derivePackageFromLayout(portable) ?? '(root)';
    labels.set(file, label);
  }
  return labels;
}
