/**
 * Module resolution for the dead-code graph.
 *
 * Covers what a TypeScript monorepo actually writes: relative specifiers with
 * the ESM `.js` → `.ts` convention, directory indexes, tsconfig `paths`
 * aliases (`@/x`), and workspace packages resolved through their package.json
 * `exports` / `main` back to SOURCE files (a workspace import names `dist/`,
 * the graph needs `src/`). Anything else is an external dependency or
 * unresolved — never a guessed edge.
 */

import * as fs from 'node:fs';
import { builtinModules } from 'node:module';
import * as path from 'node:path';
import { owningPackage, type PackageInfo } from './files.js';

type Ts = typeof import('@typescript/typescript6');

export type Resolution =
  | { type: 'file'; files: string[] }
  | { type: 'external'; pkg: string }
  | { type: 'builtin' }
  | { type: 'asset' }
  | { type: 'unresolved' };

const BUILTINS = new Set(builtinModules.flatMap((m) => [m, m.replace(/^node:/, '')]));
const SOURCE_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const JS_TO_SOURCE: Record<string, readonly string[]> = {
  '.js': ['.ts', '.tsx', '.js', '.jsx'],
  '.jsx': ['.tsx', '.jsx'],
  '.mjs': ['.mts', '.mjs', '.ts'],
  '.cjs': ['.cts', '.cjs', '.ts'],
};
const CODE_EXT_RE = /\.(?:[cm]?[jt]sx?)$/i;
export const BUILD_DIRS: readonly string[] = ['dist', 'build', 'out', 'lib', 'esm', 'cjs'];

/** String targets of the `map` entry for `key`: the exact key, else every matching `*` pattern. */
function patternTargets(map: Record<string, unknown>, key: string): string[] {
  const targets: string[] = [];
  const collect = (v: unknown, depth: number, star?: string): void => {
    if (depth > 8 || v == null) return;
    if (typeof v === 'string') targets.push(star === undefined ? v : v.replace(/\*/g, () => star));
    else if (Array.isArray(v)) for (const x of v) collect(x, depth + 1, star);
    else if (typeof v === 'object') for (const x of Object.values(v)) collect(x, depth + 1, star);
  };
  if (key in map) {
    collect(map[key], 0);
    return targets;
  }
  for (const k of Object.keys(map)) {
    const star = k.indexOf('*');
    if (star === -1) continue;
    const prefix = k.slice(0, star);
    const suffix = k.slice(star + 1);
    if (key.startsWith(prefix) && key.endsWith(suffix) && key.length >= k.length - 1) {
      collect(map[k], 0, key.slice(prefix.length, key.length - suffix.length));
    }
  }
  return targets;
}

interface PathsConfig {
  /** Absolute-ish project-relative base for `paths` targets. */
  base: string;
  paths: Array<{ prefix: string; suffix: string; wildcard: boolean; targets: string[] }>;
}

export class DeadCodeResolver {
  private readonly files: ReadonlySet<string>;
  private readonly lowerFiles = new Map<string, string>();
  private readonly packagesByName = new Map<string, PackageInfo>();
  private readonly tsconfigByDir = new Map<string, PathsConfig | null>();

  constructor(
    private readonly ts: Ts,
    private readonly projectRoot: string,
    files: readonly string[],
    private readonly packages: readonly PackageInfo[],
  ) {
    this.files = new Set(files);
    for (const f of files) this.lowerFiles.set(f.toLowerCase(), f);
    for (const pkg of packages) {
      if (typeof pkg.manifest.name === 'string') this.packagesByName.set(pkg.manifest.name, pkg);
    }
  }

  /** The indexed spelling of `rel`, or null. Case-insensitive fallback for Windows/macOS. */
  private has(rel: string): string | null {
    if (this.files.has(rel)) return rel;
    return this.lowerFiles.get(rel.toLowerCase()) ?? null;
  }

  /** Resolve a file-like path (no package semantics) to indexed code files. */
  resolveFileLike(relBase: string): string[] {
    const base = path.posix.normalize(relBase).replace(/^\.\//, '');
    if (base.startsWith('../')) return [];
    const ext = path.posix.extname(base).toLowerCase();
    const out: string[] = [];
    const push = (p: string): void => {
      const hit = this.has(p);
      if (hit && !out.includes(hit)) out.push(hit);
    };
    if (JS_TO_SOURCE[ext]) {
      const stem = base.slice(0, -ext.length);
      for (const e of JS_TO_SOURCE[ext]) push(stem + e);
      if (out.length > 0) return out;
    }
    if (SOURCE_EXTS.includes(ext)) {
      push(base);
      if (out.length > 0) return out;
    }
    for (const e of SOURCE_EXTS) push(base + e);
    if (out.length > 0) return out;
    for (const e of SOURCE_EXTS) push(`${base}/index${e}`);
    return out;
  }

  /** Map a build-output path inside a package back to its source file(s). */
  sourceForPackageTarget(pkgDir: string, target: string): string[] {
    const clean = target.replace(/^\.\//, '');
    const join = (p: string): string => (pkgDir ? `${pkgDir}/${p}` : p);
    const direct = this.resolveFileLike(join(clean.replace(/\.d\.([cm]?)ts$/, '.$1js')));
    if (direct.length > 0) return direct;
    const first = clean.split('/')[0] ?? '';
    if (BUILD_DIRS.includes(first)) {
      const rest = clean.slice(first.length + 1).replace(/\.d\.([cm]?)ts$/, '.$1js');
      for (const candidate of [`src/${rest}`, rest]) {
        const hit = this.resolveFileLike(join(candidate));
        if (hit.length > 0) return hit;
      }
    }
    return [];
  }

  /** Every string target of a package.json `exports` value for one subpath. */
  private exportTargets(manifest: Record<string, unknown>, subpath: string): string[] {
    const exp = manifest.exports;
    if (exp == null || (typeof exp !== 'object' && typeof exp !== 'string')) return [];
    const key = subpath ? `./${subpath}` : '.';
    // Sugar: a string, an array, or conditions at top level (`{ "import": "./x.js" }`).
    const sugar =
      typeof exp === 'string' ||
      Array.isArray(exp) ||
      !Object.keys(exp).some((k) => k.startsWith('.'));
    if (sugar) return key === '.' ? patternTargets({ '.': exp }, '.') : [];
    return patternTargets(exp as Record<string, unknown>, key);
  }

  /** Source files a package (sub)path names — used for imports AND entry discovery. */
  resolvePackageSubpath(pkg: PackageInfo, subpath: string): string[] {
    const out = new Set<string>();
    const add = (files: string[]): void => {
      for (const f of files) out.add(f);
    };
    for (const t of this.exportTargets(pkg.manifest, subpath)) {
      add(this.sourceForPackageTarget(pkg.dir, t));
    }
    if (out.size === 0 && pkg.manifest.exports === undefined) {
      if (subpath === '') {
        for (const field of ['module', 'main', 'types', 'typings', 'browser']) {
          const v = pkg.manifest[field];
          if (typeof v === 'string') add(this.sourceForPackageTarget(pkg.dir, v));
        }
        if (out.size === 0) add(this.sourceForPackageTarget(pkg.dir, 'index'));
        if (out.size === 0) add(this.sourceForPackageTarget(pkg.dir, 'src/index'));
      } else {
        add(this.sourceForPackageTarget(pkg.dir, subpath));
        if (out.size === 0) add(this.sourceForPackageTarget(pkg.dir, `src/${subpath}`));
      }
    }
    return [...out];
  }

  private pathsConfigFor(fromDir: string): PathsConfig | null {
    if (this.tsconfigByDir.has(fromDir)) return this.tsconfigByDir.get(fromDir)!;
    let found: PathsConfig | null = null;
    const file = path.posix.join(fromDir, 'tsconfig.json');
    const abs = path.join(this.projectRoot, file);
    if (fs.existsSync(abs)) {
      found = this.readPathsConfig(abs, 0);
    } else if (fromDir !== '' && fromDir !== '.') {
      const parent = path.posix.dirname(fromDir);
      found = this.pathsConfigFor(parent === '.' ? '' : parent);
    }
    this.tsconfigByDir.set(fromDir, found);
    return found;
  }

  private readPathsConfig(absFile: string, depth: number): PathsConfig | null {
    if (depth > 5) return null;
    let raw: { config?: Record<string, unknown> };
    try {
      raw = this.ts.parseConfigFileTextToJson(absFile, fs.readFileSync(absFile, 'utf8'));
    } catch {
      return null;
    }
    const config = raw.config ?? {};
    const opts = (config.compilerOptions ?? {}) as {
      paths?: Record<string, string[]>;
      baseUrl?: string;
    };
    const dir = path.dirname(absFile);
    if (opts.paths && typeof opts.paths === 'object') {
      const baseAbs = opts.baseUrl ? path.resolve(dir, opts.baseUrl) : dir;
      const base = path.relative(this.projectRoot, baseAbs).split(path.sep).join('/');
      return {
        base,
        paths: Object.entries(opts.paths).map(([pattern, targets]) => {
          const star = pattern.indexOf('*');
          return {
            prefix: star === -1 ? pattern : pattern.slice(0, star),
            suffix: star === -1 ? '' : pattern.slice(star + 1),
            wildcard: star !== -1,
            targets: Array.isArray(targets) ? targets : [],
          };
        }),
      };
    }
    const ext = config.extends;
    for (const parent of Array.isArray(ext) ? ext : ext ? [ext] : []) {
      if (typeof parent !== 'string' || !parent.startsWith('.')) continue;
      const parentFile = path.resolve(dir, parent.endsWith('.json') ? parent : `${parent}.json`);
      if (fs.existsSync(parentFile)) {
        const inherited = this.readPathsConfig(parentFile, depth + 1);
        if (inherited) return inherited;
      }
    }
    return null;
  }

  private resolveAlias(fromFile: string, spec: string): string[] | null {
    const cfg = this.pathsConfigFor(path.posix.dirname(fromFile));
    if (!cfg) return null;
    // TypeScript's choice: an exact pattern, else the wildcard with the longest
    // prefix — not the first declared (`"*"` listed first must not hide `"@/*"`).
    let best: PathsConfig['paths'][number] | undefined;
    for (const entry of cfg.paths) {
      if (!entry.wildcard) {
        if (spec !== entry.prefix) continue;
        best = entry;
        break;
      }
      if (
        spec.length >= entry.prefix.length + entry.suffix.length &&
        spec.startsWith(entry.prefix) &&
        spec.endsWith(entry.suffix) &&
        (!best || entry.prefix.length > best.prefix.length)
      ) {
        best = entry;
      }
    }
    if (!best) return null;
    const star = best.wildcard
      ? spec.slice(best.prefix.length, spec.length - best.suffix.length)
      : null;
    for (const target of best.targets) {
      const t = star === null ? target : target.replace('*', () => star);
      const hit = this.resolveFileLike(path.posix.join(cfg.base, t));
      if (hit.length > 0) return hit;
    }
    return [];
  }

  /** package.json `"imports"` (`#name`, `#lib/*`) of the importing file's package. */
  private resolveSubpathImport(fromFile: string, spec: string): string[] {
    const pkg = owningPackage(this.packages, fromFile);
    const map = pkg?.manifest.imports;
    if (!pkg || !map || typeof map !== 'object' || Array.isArray(map)) return [];
    const targets: string[] = [];
    for (const t of patternTargets(map as Record<string, unknown>, spec)) {
      // A bare target (`"#dep": "some-pkg"`) names a dependency, not a file.
      if (t.startsWith('./')) targets.push(...this.sourceForPackageTarget(pkg.dir, t));
    }
    return [...new Set(targets)];
  }

  resolve(fromFile: string, rawSpec: string): Resolution {
    // Drop a `?query` / `#hash` suffix — a LEADING `#` is a subpath import.
    const spec = rawSpec.replace(/(?!^)[?#].*$/, '');
    if (!spec) return { type: 'unresolved' };
    if (spec.startsWith('.')) {
      const target = path.posix.join(path.posix.dirname(fromFile), spec);
      const files = this.resolveFileLike(target);
      if (files.length > 0) return { type: 'file', files };
      const ext = path.posix.extname(spec).toLowerCase();
      if (ext && !CODE_EXT_RE.test(ext)) return { type: 'asset' };
      return { type: 'unresolved' };
    }
    if (spec.startsWith('/')) {
      const pkg = owningPackage(this.packages, fromFile);
      const root = pkg?.dir ?? '';
      for (const base of [root, root ? `${root}/public` : 'public']) {
        const files = this.resolveFileLike(path.posix.join(base, spec.slice(1)));
        if (files.length > 0) return { type: 'file', files };
      }
      return { type: 'unresolved' };
    }
    if (spec.startsWith('node:') || BUILTINS.has(spec) || BUILTINS.has(spec.split('/')[0]!)) {
      return { type: 'builtin' };
    }
    // A `paths` match that resolves nothing falls back to normal resolution,
    // as TypeScript does: a catch-all `"*": ["./types/*"]` otherwise swallowed
    // every workspace-package import, and the files only it used read as dead.
    const alias = this.resolveAlias(fromFile, spec);
    if (alias !== null && alias.length > 0) return { type: 'file', files: alias };
    if (spec.startsWith('#')) {
      const files = this.resolveSubpathImport(fromFile, spec);
      return files.length > 0 ? { type: 'file', files } : { type: 'unresolved' };
    }
    const parts = spec.split('/');
    const pkgName = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
    const subpath = parts.slice(spec.startsWith('@') ? 2 : 1).join('/');
    const pkg = this.packagesByName.get(pkgName);
    if (pkg) {
      const files = this.resolvePackageSubpath(pkg, subpath);
      return files.length > 0 ? { type: 'file', files } : { type: 'unresolved' };
    }
    return { type: 'external', pkg: pkgName };
  }

  /**
   * Resolve a path-shaped string literal (`'./worker.js'`, `'parser-worker-script.js'`)
   * against the file's directory, its package root, and the project root. Only
   * keeps targets alive, so trying several bases errs on the safe side.
   */
  resolvePathLiteral(fromFile: string, literal: string): string[] {
    const value = literal.replace(/\\/g, '/').replace(/^\/+/, '');
    const pkg = owningPackage(this.packages, fromFile);
    const pkgDir = pkg?.dir ?? '';
    const out = new Set<string>();
    for (const base of [path.posix.dirname(fromFile), pkgDir, '']) {
      for (const f of this.resolveFileLike(path.posix.join(base, value))) out.add(f);
    }
    if (out.size === 0 && pkg) {
      // `new URL('../dist/worker.js', …)` / `path.join(distDir, 'worker.js')`:
      // the build flattened `src/` away.
      for (const f of this.sourceForPackageTarget(pkgDir, value.replace(/^(?:\.\.?\/)+/, ''))) {
        out.add(f);
      }
      for (const f of this.sourceForPackageTarget(
        pkgDir,
        `dist/${value.replace(/^(?:\.\.?\/)+/, '')}`,
      )) {
        out.add(f);
      }
    }
    const stem = path.posix.basename(value).replace(CODE_EXT_RE, '').toLowerCase();
    if (out.size === 0 && stem !== 'index' && stem !== 'main') {
      // Unresolvable as written (a build renamed or moved it, e.g.
      // `../preload/preload.cjs` built from `src/main/preload.ts`): any
      // same-stem code file in the same package stays alive.
      for (const f of this.filesByStem().get(stem) ?? []) {
        if (owningPackage(this.packages, f)?.dir === pkgDir) out.add(f);
      }
    }
    return [...out];
  }

  private stemIndex: Map<string, string[]> | null = null;
  private filesByStem(): Map<string, string[]> {
    if (this.stemIndex) return this.stemIndex;
    const index = new Map<string, string[]>();
    for (const f of this.files) {
      const stem = path.posix.basename(f).replace(CODE_EXT_RE, '').toLowerCase();
      const list = index.get(stem);
      if (list) list.push(f);
      else index.set(stem, [f]);
    }
    this.stemIndex = index;
    return index;
  }
}
