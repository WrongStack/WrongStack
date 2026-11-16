/**
 * Dead-code analysis: reachability over the resolved module graph, then
 * export-level usage resolved through re-export chains.
 *
 * Two graphs share one edge set: the production graph walks from entries
 * (package.json, HTML, config references, tools, shebangs), the test graph
 * from test files. A file only the test graph reaches is test-only; one
 * neither reaches is unreachable. An export counts as used only when a
 * REACHABLE file imports it — an import inside dead code keeps nothing alive.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { compilePathGlob, resolveWstackPaths } from '@wrongstack/core/utils';
import { expandBraceAlternation } from '../_glob-braces.js';
import { scanUnusedDependencies } from './dependencies.js';
import { discoverEntries, type EntryInfo, type EntryKind } from './entries.js';
import {
  classifyFile,
  compileIgnore,
  discoverPackages,
  type FileRole,
  listProjectFiles,
  owningPackage,
  type PackageInfo,
} from './files.js';
import { extractModuleFacts, loadTypescript, type ModuleFacts } from './parse.js';
import { DeadCodeResolver } from './resolve.js';
import type {
  DeadCodeCategory,
  DeadCodeConfidence,
  DeadCodeFinding,
  DeadCodeScanOptions,
  DeadCodeScanResult,
} from './types.js';

/** Bump when ModuleFacts' shape or extraction semantics change. */
const FACTS_VERSION = 12;

const USE_PROD = 1;
const USE_TEST = 2;
const USE_PUBLIC = 4;

const UI_KIT_DIR = /(?:^|\/)components\/ui\//;

const TYPE_LIKE_KINDS: ReadonlySet<string> = new Set(['interface', 'type', 'class', 'enum']);

/** Entry kinds whose exports are consumed by something outside the repo / a tool. */
const EXPORT_CONSUMING_ENTRY: ReadonlySet<EntryKind> = new Set(['tool', 'user']);

export interface ProjectDeadCodeConfig {
  entries?: string[] | undefined;
  ignore?: string[] | undefined;
  ignoreExports?: string[] | undefined;
  ignoreDependencies?: string[] | undefined;
  includePublicApi?: boolean | undefined;
}

/** `.wrongstack/dead-code.json` — narrows findings only; it cannot widen what is reported. */
export function readProjectDeadCodeConfig(projectRoot: string): ProjectDeadCodeConfig {
  try {
    const raw = JSON.parse(
      fs
        .readFileSync(path.join(projectRoot, '.wrongstack', 'dead-code.json'), 'utf8')
        .replace(/^\uFEFF/, ''),
    ) as Record<string, unknown>;
    const strings = (v: unknown): string[] | undefined =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;
    return {
      entries: strings(raw.entries),
      ignore: strings(raw.ignore),
      ignoreExports: strings(raw.ignoreExports),
      ignoreDependencies: strings(raw.ignoreDependencies),
      includePublicApi: raw.includePublicApi === true,
    };
  } catch {
    return {};
  }
}

// ─── Facts cache ─────────────────────────────────────────────────────────

interface FactsCacheFile {
  version: number;
  files: Record<string, { hash: string; facts: ModuleFacts }>;
}

function cachePath(projectRoot: string): string {
  return path.join(resolveWstackPaths({ projectRoot }).projectDir, 'dead-code', 'facts.json');
}

function loadCache(projectRoot: string): FactsCacheFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath(projectRoot), 'utf8')) as FactsCacheFile;
    if (parsed.version === FACTS_VERSION && parsed.files) return parsed;
  } catch {
    // Missing or corrupt cache: rebuild.
  }
  return { version: FACTS_VERSION, files: {} };
}

function saveCache(projectRoot: string, cache: FactsCacheFile): void {
  try {
    const file = cachePath(projectRoot);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache));
    fs.renameSync(tmp, file);
  } catch {
    // A cache that cannot be written only costs the next scan its speed.
  }
}

export function hashContent(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

/** Stable id: the same dead thing keeps its id across scans. */
export function findingId(category: DeadCodeCategory, file: string, name = ''): string {
  return createHash('sha1').update(`${category}\0${file}\0${name}`).digest('hex').slice(0, 12);
}

// ─── Graph ───────────────────────────────────────────────────────────────

interface ResolvedImport {
  targets: string[];
  names: ModuleFacts['imports'][number]['names'];
  kind: ModuleFacts['imports'][number]['kind'];
}

interface ResolvedReExport {
  targets: string[];
  fact: ModuleFacts['reexports'][number];
}

interface FileNode {
  rel: string;
  role: FileRole;
  facts: ModuleFacts;
  pkg: PackageInfo | undefined;
  imports: ResolvedImport[];
  reexports: ResolvedReExport[];
  /** Files kept alive by path literals / dynamic-import prefixes / globs (no names). */
  extraEdges: string[];
}

export interface DeadCodeAnalysis extends DeadCodeScanResult {
  /** Facts per file — the fixer re-checks against them. */
  readonly nodes: ReadonlyMap<string, FileNode>;
}

function bfs(roots: Iterable<string>, nodes: Map<string, FileNode>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const r of roots) {
    if (nodes.has(r) && !seen.has(r)) {
      seen.add(r);
      queue.push(r);
    }
  }
  while (queue.length > 0) {
    const node = nodes.get(queue.pop()!)!;
    const next = (t: string): void => {
      if (!seen.has(t) && nodes.has(t)) {
        seen.add(t);
        queue.push(t);
      }
    };
    for (const imp of node.imports) for (const t of imp.targets) next(t);
    for (const re of node.reexports) for (const t of re.targets) next(t);
    for (const t of node.extraEdges) next(t);
  }
  return seen;
}

export async function analyzeDeadCode(
  projectRoot: string,
  options: DeadCodeScanOptions = {},
): Promise<DeadCodeAnalysis> {
  const started = Date.now();
  const config = readProjectDeadCodeConfig(projectRoot);
  const ts = await loadTypescript();
  const warnings: string[] = [];

  const ignoreGlobs = [...(config.ignore ?? []), ...(options.ignore ?? [])];
  const { all, code } = await listProjectFiles(projectRoot, ignoreGlobs);
  const packages = discoverPackages(projectRoot, all);

  // ── Parse (cached by content hash) ─────────────────────────────────────
  const cache = options.noCache ? { version: FACTS_VERSION, files: {} } : loadCache(projectRoot);
  const nextCache: FactsCacheFile = { version: FACTS_VERSION, files: {} };
  const fileHashes: Record<string, string> = {};
  const shebangs = new Set<string>();
  const nodes = new Map<string, FileNode>();
  let parsedFiles = 0;
  let cachedFiles = 0;
  for (const rel of code) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(projectRoot, rel), 'utf8');
    } catch {
      continue;
    }
    const hash = hashContent(text);
    fileHashes[rel] = hash;
    if (text.startsWith('#!')) shebangs.add(rel);
    const cached = cache.files[rel];
    let facts: ModuleFacts;
    if (cached && cached.hash === hash) {
      facts = cached.facts;
      cachedFiles++;
    } else {
      facts = extractModuleFacts(ts, rel, text);
      parsedFiles++;
    }
    nextCache.files[rel] = { hash, facts };
    nodes.set(rel, {
      rel,
      role: classifyFile(rel),
      facts,
      pkg: owningPackage(packages, rel),
      imports: [],
      reexports: [],
      extraEdges: [],
    });
  }
  if (!options.noCache) saveCache(projectRoot, nextCache);

  // ── Resolve edges ──────────────────────────────────────────────────────
  const resolver = new DeadCodeResolver(ts, projectRoot, [...nodes.keys()], packages);
  const externalUse = new Map<string, Set<string>>();
  let unresolvedRelative = 0;
  const opaqueDynamicFiles: string[] = [];
  const codeList = [...nodes.keys()];
  /** Bare specifiers name a dependency whether or not they resolve in-repo (workspace deps do). */
  const recordBare = (node: FileNode, spec: string): void => {
    if (/^[./#]/.test(spec) || spec.startsWith('node:')) return;
    const parts = spec.split('/');
    const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
    const key = node.pkg?.dir ?? '';
    let set = externalUse.get(key);
    if (!set) {
      set = new Set();
      externalUse.set(key, set);
    }
    set.add(name);
  };
  for (const node of nodes.values()) {
    const { facts } = node;
    for (const imp of facts.imports) {
      if (imp.kind === 'glob') {
        // Vite globs alternate with `{ts,tsx}`; the path glob compiler does not.
        for (const spec of expandBraceAlternation(imp.spec)) {
          if (spec.startsWith('/')) {
            // Vite root-absolute glob ('/src/routes/*.ts'): the leading slash
            // anchors at the project root — the same convention resolve() and
            // entries.ts apply to leading-slash specifiers — not at the
            // importing file's directory. The owning package root is tried too;
            // extra edges only keep files alive, so the union errs safe.
            for (const base of [node.pkg?.dir ?? '', '']) {
              const re = compilePathGlob(path.posix.join(base, spec.slice(1)));
              node.extraEdges.push(...codeList.filter((f) => re.test(f)));
            }
            continue;
          }
          const pattern = path.posix.join(path.posix.dirname(node.rel), spec);
          const re = compilePathGlob(pattern.replace(/^\.\//, ''));
          node.extraEdges.push(...codeList.filter((f) => re.test(f)));
        }
        continue;
      }
      recordBare(node, imp.spec);
      const res = resolver.resolve(node.rel, imp.spec);
      if (res.type === 'file') {
        node.imports.push({ targets: res.files, names: imp.names, kind: imp.kind });
      } else if (res.type === 'unresolved' && imp.spec.startsWith('.')) {
        unresolvedRelative++;
      }
    }
    for (const re of facts.reexports) {
      recordBare(node, re.spec);
      const res = resolver.resolve(node.rel, re.spec);
      if (res.type === 'file') node.reexports.push({ targets: res.files, fact: re });
    }
    for (const lit of facts.pathLiterals) {
      node.extraEdges.push(...resolver.resolvePathLiteral(node.rel, lit));
    }
    for (const prefix of facts.dynamicPrefixes) {
      const dirPrefix = path.posix.join(path.posix.dirname(node.rel), prefix);
      node.extraEdges.push(...codeList.filter((f) => f.startsWith(dirPrefix)));
    }
    if (facts.opaqueDynamicImports > 0) opaqueDynamicFiles.push(node.rel);
  }

  // ── Entries & reachability ─────────────────────────────────────────────
  const userEntries = [...(config.entries ?? []), ...(options.entries ?? [])];
  const userEntryMatch = compileIgnore(userEntries.filter((e) => e.includes('*')));
  const entries = discoverEntries({
    projectRoot,
    allFiles: all,
    codeFiles: codeList,
    packages,
    resolver,
    userEntries,
    matchesUserEntry: userEntryMatch,
    isShebang: (rel) => shebangs.has(rel),
  });
  const prodRoots: string[] = [];
  const testRoots: string[] = [];
  for (const node of nodes.values()) {
    if (node.role === 'test') testRoots.push(node.rel);
    else if (entries.has(node.rel)) prodRoots.push(node.rel);
  }
  const prodReach = bfs(prodRoots, nodes);
  const testReach = bfs(testRoots, nodes);

  // ── Export usage ───────────────────────────────────────────────────────
  const usage = new Map<string, number>();
  const allUsed = new Map<string, number>();
  const mark = (key: string, bits: number): void => {
    usage.set(key, (usage.get(key) ?? 0) | bits);
  };

  const markAll = (file: string, bits: number, seen: Set<string>): void => {
    const visitKey = `${file}\0*`;
    if (seen.has(visitKey)) return;
    seen.add(visitKey);
    const node = nodes.get(file);
    if (!node) return;
    allUsed.set(file, (allUsed.get(file) ?? 0) | bits);
    for (const re of node.reexports) {
      if (re.fact.star || re.fact.namespace) {
        for (const t of re.targets) markAll(t, bits, seen);
        continue;
      }
      for (const n of re.fact.names) {
        mark(`${file}\0re:${n.exported}`, bits);
        for (const t of re.targets) useExport(t, n.imported, bits, seen);
      }
    }
  };

  /** Mark `name` used in `file`; returns whether `file` provides `name` at all. */
  const useExport = (file: string, name: string, bits: number, seen: Set<string>): boolean => {
    const visitKey = `${file}\0${name}`;
    if (seen.has(visitKey)) return true;
    seen.add(visitKey);
    const node = nodes.get(file);
    if (!node) return false;
    if (node.facts.commonJs) {
      allUsed.set(file, (allUsed.get(file) ?? 0) | bits);
      return true;
    }
    let found = false;
    if (node.facts.exports.some((e) => e.name === name)) {
      mark(`${file}\0${name}`, bits);
      found = true;
    }
    for (const re of node.reexports) {
      if (re.fact.namespace === name) {
        mark(`${file}\0re:${name}`, bits);
        for (const t of re.targets) markAll(t, bits, seen);
        found = true;
        continue;
      }
      for (const n of re.fact.names) {
        if (n.exported !== name) continue;
        mark(`${file}\0re:${name}`, bits);
        for (const t of re.targets) useExport(t, n.imported, bits, seen);
        found = true;
      }
    }
    if (!found && name !== 'default') {
      for (const re of node.reexports) {
        if (!re.fact.star) continue;
        for (const t of re.targets) {
          if (useExport(t, name, bits, seen)) found = true;
        }
      }
    }
    return found;
  };

  const isTestish = (n: FileNode): boolean => n.role === 'test' || n.role === 'test-support';
  for (const node of nodes.values()) {
    const reachable = prodReach.has(node.rel) || testReach.has(node.rel);
    if (!reachable) continue;
    const bits = !isTestish(node) && prodReach.has(node.rel) ? USE_PROD : USE_TEST;
    for (const imp of node.imports) {
      for (const t of imp.targets) {
        if (imp.names === 'all') markAll(t, bits, new Set());
        else for (const n of imp.names) useExport(t, n.imported, bits, new Set());
      }
    }
    for (const t of node.extraEdges) {
      // A path reference loads the module; any export may be read off it.
      markAll(t, bits, new Set());
    }
  }
  for (const [file, info] of entries) {
    const node = nodes.get(file);
    if (!node) continue;
    if ([...info.kinds].some((k) => EXPORT_CONSUMING_ENTRY.has(k)))
      markAll(file, USE_PROD, new Set());
    if (info.kinds.has('package-public')) {
      // Published packages are consumed outside the repo; private ones are not.
      markAll(file, node.pkg && !node.pkg.private ? USE_PUBLIC : 0, new Set());
    }
  }

  // ── Findings ───────────────────────────────────────────────────────────
  const findings: DeadCodeFinding[] = [];
  const includePublicApi = options.includePublicApi ?? config.includePublicApi ?? false;
  const ignoreExport = compileIgnore(config.ignoreExports ?? []);
  // A computed `import(x)` can load any sibling of its file (`import(path.join(dir, name))`),
  // so findings under that directory lose confidence — not the whole package.
  const opaqueDirs = [...new Set(opaqueDynamicFiles.map((f) => path.posix.dirname(f)))];
  const underOpaqueDir = (file: string): boolean =>
    opaqueDirs.some((d) => d === '.' || file.startsWith(`${d}/`));

  const push = (f: Omit<DeadCodeFinding, 'id'>): void => {
    // A component kit (`components/ui/`, shadcn-style) is a library surface:
    // unused parts are kept on purpose often enough that removal needs a look.
    const kit = UI_KIT_DIR.test(f.file) && f.confidence === 'high';
    findings.push({
      id: findingId(f.category, f.file, f.name),
      ...f,
      ...(kit
        ? { confidence: 'medium' as const, reason: `${f.reason} Part of a UI component kit.` }
        : {}),
    });
  };

  for (const node of nodes.values()) {
    if (node.role === 'test' || node.facts.ignoreFile) continue;
    const file = node.rel;
    const pkgName = node.pkg?.name;
    const pkgHasOpaque = underOpaqueDir(file);
    const inProd = prodReach.has(file);
    const inTest = testReach.has(file);
    const pkgDir = node.pkg?.dir ?? '';
    const inPkg = pkgDir ? file.slice(pkgDir.length + 1) : file;
    // Scripts, benches and loose files at a package root are often run by hand.
    const scriptLike =
      /^(?:scripts?|bin|tools?|bench(?:marks?)?|perf)\//.test(inPkg) ||
      (!inPkg.includes('/') && node.facts.exports.length === 0);

    if (!inProd && !inTest) {
      let confidence: DeadCodeConfidence = 'high';
      let reason = 'No entry point, import, dynamic import or path reference reaches this file.';
      if (node.role === 'test-support') {
        const hasExports = node.facts.exports.length > 0 || node.facts.reexports.length > 0;
        confidence = hasExports ? 'medium' : 'low';
        reason = hasExports
          ? 'Test helper that no test file, test setup or config imports.'
          : 'Standalone script under a test directory that nothing runs or imports — it may still be run by hand.';
      } else if (scriptLike) {
        confidence = 'low';
        reason =
          'Standalone script not referenced by any package.json script, CI workflow, config or code — it may still be run by hand.';
      } else if (pkgHasOpaque) {
        confidence = 'medium';
        reason += ' Its package has computed dynamic imports the scanner cannot follow.';
      }
      push({
        category: 'unreachable-file',
        confidence,
        file,
        package: pkgName,
        reason,
        fix: 'delete-file',
      });
      continue;
    }

    if (!inProd && node.role === 'source') {
      push({
        category: 'test-only-file',
        confidence: pkgHasOpaque || scriptLike ? 'low' : 'medium',
        file,
        package: pkgName,
        reason: 'Only test files reach this module; production code never loads it.',
        manualReason: 'Tests import it — delete those tests too, or move the module under tests/.',
      });
      continue;
    }

    const fileAll = allUsed.get(file) ?? 0;
    const entryInfo: EntryInfo | undefined = entries.get(file);
    if (node.facts.commonJs) continue;

    // `export { impl, impl as alias }`: a used alias keeps the binding alive.
    const liveLocals = new Set<string>();
    for (const exp of node.facts.exports) {
      const b = (usage.get(`${file}\0${exp.name}`) ?? 0) | fileAll;
      if (exp.local && b & (USE_PROD | USE_TEST | USE_PUBLIC)) liveLocals.add(exp.local);
    }
    for (const exp of node.facts.exports) {
      if (exp.keep || ignoreExport(`${file}#${exp.name}`) || ignoreExport(file)) continue;
      const bits = (usage.get(`${file}\0${exp.name}`) ?? 0) | fileAll;
      if (bits & (USE_PROD | (node.role === 'source' ? 0 : USE_TEST))) continue;
      const base = {
        file,
        line: exp.line,
        endLine: exp.endLine,
        name: exp.name,
        kind: exp.kind,
        typeOnly: exp.typeOnly,
        package: pkgName,
      };
      const confidence: DeadCodeConfidence = pkgHasOpaque || entryInfo ? 'medium' : 'high';
      if (bits & USE_TEST) {
        push({
          ...base,
          category: 'test-only-export',
          confidence: 'medium',
          reason: 'Only test files import this export.',
          manualReason: 'Tests use it — remove or rewrite those tests first.',
        });
        continue;
      }
      if (bits & USE_PUBLIC) {
        if (!includePublicApi) continue;
        push({
          ...base,
          category: 'unused-public-export',
          confidence: 'low',
          reason: `Part of ${pkgName ?? 'the package'}'s published API; nothing in this repository imports it.`,
          manualReason: 'External consumers may depend on published API.',
        });
        continue;
      }
      if (exp.usedLocally || (exp.local !== null && liveLocals.has(exp.local))) {
        // An inferred type in ANOTHER file may still name a type-like
        // declaration (a method returning this interface) — invisible to
        // syntax, caught by the fixer's typecheck.
        const typeLike = TYPE_LIKE_KINDS.has(exp.kind);
        const surfaced = typeLike && exp.surfaced === true;
        push({
          ...base,
          category: 'unused-export',
          confidence: surfaced ? 'low' : typeLike && confidence === 'high' ? 'medium' : confidence,
          reason: surfaced
            ? 'Never imported, but named in an exported signature of its file: code elsewhere can infer it, and declaration emit then needs the export.'
            : typeLike
              ? 'Exported but never imported; only its own file uses it. Inferred types elsewhere may still need the name.'
              : 'Exported but never imported; only its own file uses it.',
          fix: exp.local !== null && !exp.manual ? 'remove-export-keyword' : undefined,
          manualReason: exp.local === null ? 'anonymous default export' : exp.manual,
        });
      } else {
        push({
          ...base,
          category: 'dead-export',
          confidence,
          reason: 'Exported but never imported, and unused inside its own file.',
          fix: exp.manual ? undefined : 'remove-declaration',
          manualReason: exp.manual,
        });
      }
    }

    for (const re of node.reexports) {
      for (const n of re.fact.names) {
        if (ignoreExport(`${file}#${n.exported}`)) continue;
        const bits = (usage.get(`${file}\0re:${n.exported}`) ?? 0) | fileAll;
        if (bits & (USE_PROD | USE_TEST | USE_PUBLIC)) continue;
        push({
          category: 'unused-reexport',
          confidence: pkgHasOpaque || entryInfo ? 'medium' : 'high',
          file,
          line: re.fact.line,
          name: n.exported,
          kind: 're-export',
          typeOnly: n.typeOnly,
          package: pkgName,
          reason: `Re-exported from '${re.fact.spec}' but nothing imports it through this module.`,
          fix: 'remove-reexport',
        });
      }
    }

    for (const local of node.facts.locals) {
      // `_name` is the convention for "unused on purpose" (compile-time assertions…).
      if (local.refs > 0 || local.keep || local.name.startsWith('_')) continue;
      push({
        category: 'unused-local',
        confidence: 'high',
        file,
        line: local.line,
        endLine: local.endLine,
        name: local.name,
        kind: local.kind,
        package: pkgName,
        reason: 'Top-level declaration that nothing in its file references.',
        fix: local.manual ? undefined : 'remove-declaration',
        manualReason: local.manual,
      });
    }
  }

  for (const dep of scanUnusedDependencies({
    projectRoot,
    packages,
    allFiles: all,
    externalUse,
    stringLiterals: (dir) => {
      const out = new Set<string>();
      for (const node of nodes.values()) {
        if ((node.pkg?.dir ?? '') !== dir) continue;
        for (const lit of node.facts.pathLiterals) out.add(lit);
        for (const lit of node.facts.packageLiterals ?? []) out.add(lit);
      }
      return out;
    },
    ignore: config.ignoreDependencies ?? [],
  })) {
    push(dep);
  }

  // ── Warnings & report shaping ──────────────────────────────────────────
  if (opaqueDynamicFiles.length > 0) {
    warnings.push(
      `${opaqueDynamicFiles.length} file(s) use computed dynamic imports the scanner cannot follow (e.g. ${opaqueDynamicFiles.slice(0, 3).join(', ')}); findings in those packages are downgraded to medium confidence.`,
    );
  }
  if (unresolvedRelative > 0) {
    warnings.push(`${unresolvedRelative} relative import(s) point at files that do not exist.`);
  }
  const parseFailures = [...nodes.values()].filter((n) => n.facts.parseErrors > 0).length;
  if (parseFailures > 0)
    warnings.push(`${parseFailures} file(s) have syntax errors; their facts may be partial.`);
  if (prodRoots.length === 0) {
    warnings.push('No entry point was found — every file looks unreachable. Add `entries`.');
  }

  const scopes = (options.paths ?? []).map((p) =>
    p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, ''),
  );
  const scoped = scopes.length
    ? findings.filter((f) =>
        scopes.some((s) => s === '' || f.file === s || f.file.startsWith(`${s}/`)),
      )
    : findings;
  const order: Record<DeadCodeConfidence, number> = { high: 0, medium: 1, low: 2 };
  scoped.sort(
    (a, b) =>
      order[a.confidence] - order[b.confidence] ||
      a.file.localeCompare(b.file) ||
      (a.line ?? 0) - (b.line ?? 0),
  );
  const byCategory: Partial<Record<DeadCodeCategory, number>> = {};
  for (const f of scoped) byCategory[f.category] = (byCategory[f.category] ?? 0) + 1;

  let exportCount = 0;
  for (const n of nodes.values()) exportCount += n.facts.exports.length;

  return {
    projectRoot,
    findings: scoped,
    byCategory,
    warnings,
    stats: {
      files: nodes.size,
      testFiles: testRoots.length,
      entryFiles: prodRoots.length,
      reachableFiles: new Set([...prodReach, ...testReach]).size,
      exports: exportCount,
      parsedFiles,
      cachedFiles,
      durationMs: Date.now() - started,
    },
    fileHashes,
    nodes,
  };
}
