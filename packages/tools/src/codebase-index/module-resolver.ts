/**
 * Resolve an import specifier to the indexed file it refers to.
 *
 * Runs once, after indexing, filling `refs.to_file`. Doing it here rather than
 * in the graph readers is what makes the Code Atlas language-agnostic: the
 * readers only ever see "this ref points at that file", and never need to know
 * that Go import paths come from `go.mod` while Python's come from a directory
 * chain — knowledge that is not in the database and cannot be recovered from it.
 *
 * Resolution is best-effort by design. An unresolved specifier (a stdlib or
 * third-party module, or an ecosystem whose layout we don't model) simply
 * leaves `to_file` NULL, and the graph readers fall back to the ref's resolved
 * symbol id. Guessing would draw edges that aren't there.
 */

import * as path from 'node:path';
import { detectLang, languageFamily } from './languages.js';
import { findOwningRoot, type ProjectStructure, toPortablePath } from './module-roots.js';
import type { SymbolLang } from './schema.js';

/** Candidate file extensions per family, in resolution-preference order. */
const EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  js: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte'],
  py: ['.py', '.pyi'],
  rs: ['.rs'],
  jvm: ['.java', '.kt', '.scala'],
  c: ['.h', '.hpp', '.hh', '.hxx', '.c', '.cpp', '.cc', '.cxx'],
  ruby: ['.rb'],
  go: ['.go'],
};

/** Bare-directory entry points, tried when a specifier names a directory. */
const DIRECTORY_ENTRIES: Readonly<Record<string, readonly string[]>> = {
  js: ['index'],
  py: ['__init__'],
  rs: ['mod'],
  ruby: ['index'],
};

/**
 * Reduce a namespace to one spelling.
 *
 * The same logical namespace is written `Foo.Bar` in C#, `Foo\Bar` in PHP and
 * `Foo::Bar` in a few others; the declaration and the import that references it
 * must land on the same key.
 */
function normalizeNamespace(value: string): string {
  return value
    .replace(/::|[\\/]/g, '.')
    .replace(/^\.+|\.+$/g, '')
    .toLowerCase();
}

export class ModuleResolver {
  private readonly structure: ProjectStructure;
  /** Lowercased portable path → the path as indexed (case is preserved). */
  private readonly byPath: Map<string, string>;
  /** Lowercased portable directory → files directly inside it, as indexed. */
  private readonly byDir: Map<string, string[]>;
  /** Normalized namespace → the file declaring it (first by path, stable). */
  private readonly byNamespace: Map<string, string>;

  constructor(
    structure: ProjectStructure,
    files: readonly string[],
    namespaces: ReadonlyArray<{ name: string; file: string }> = [],
  ) {
    this.structure = structure;
    this.byPath = new Map();
    this.byDir = new Map();
    this.byNamespace = new Map();
    // Keys are case-folded so a case-insensitive filesystem (Windows, default
    // macOS) resolves uniformly. When two *distinct* indexed paths fold to the
    // same key — only possible on a case-sensitive filesystem — neither can be
    // chosen without guessing, so the key is dropped and resolution falls back
    // to symbol-id rather than drawing a wrong edge.
    const dirsByKey = new Map<string, string>();
    for (const file of files) {
      const portable = toPortablePath(file);
      const pathKey = portable.toLowerCase();
      const priorPath = this.byPath.get(pathKey);
      if (priorPath !== undefined && priorPath !== file) this.byPath.delete(pathKey);
      else this.byPath.set(pathKey, file);

      const dir = path.posix.dirname(portable);
      const dirKey = dir.toLowerCase();
      const knownDir = dirsByKey.get(dirKey);
      if (knownDir === undefined) {
        dirsByKey.set(dirKey, dir);
        this.byDir.set(dirKey, [file]);
      } else if (knownDir === dir) {
        this.byDir.get(dirKey)?.push(file);
      } else {
        dirsByKey.delete(dirKey);
        this.byDir.delete(dirKey);
      }
    }
    for (const { name, file } of namespaces) {
      // `namespace` is also the symbol kind for Markdown headings, TOML tables
      // and Go package clauses. Keying by family keeps a C# `using Foo` from
      // matching an `# Foo` heading in a README.
      const lang = detectLang(file);
      if (!lang) continue;
      const norm = normalizeNamespace(name);
      if (!norm) continue;
      const key = `${languageFamily(lang)}:${norm}`;
      // First declaration wins. Rows arrive ordered by file, so a namespace
      // split across several files always resolves to the same one.
      if (!this.byNamespace.has(key)) {
        this.byNamespace.set(key, file);
      }
    }
  }

  /**
   * Resolve `specifier` as written in `fromFile`.
   * Returns the indexed target path, or `undefined` when it is external or
   * cannot be located.
   */
  resolve(fromFile: string, lang: SymbolLang, specifier: string): string | undefined {
    // Specifiers are stored exactly as written. Every family resolved below
    // treats `\` as a path separator (a Windows-style `#include "a\b.h"`);
    // PHP, where it separates namespaces, is not file-resolved at all.
    const spec = specifier.trim().replace(/\\/g, '/');
    if (!spec) return undefined;
    const from = toPortablePath(fromFile);

    switch (languageFamily(lang)) {
      case 'js':
        return this.resolveJs(from, spec);
      case 'go':
        return this.resolveGo(spec);
      case 'py':
        return this.resolvePython(from, spec);
      case 'rs':
        return this.resolveRust(from, spec);
      case 'jvm':
        return this.resolveJvm(spec);
      case 'c':
        return this.resolveInclude(from, spec);
      case 'ruby':
        return this.resolveRuby(from, spec);
      case 'dotnet':
      case 'php':
      case 'elixir':
      case 'haskell':
        // These name a namespace, not a path — `using Foo.Bar` says nothing
        // about where `Foo/Bar` lives on disk. They resolve against the
        // `namespace`/`module`/`defmodule` declarations already in the index.
        return this.resolveNamespace(lang, spec);
      default:
        // Anything unmodelled falls back to symbol-id resolution in the graph
        // readers, which is still enough to draw an edge.
        return undefined;
    }
  }

  /**
   * Resolve a namespace specifier to the file declaring it.
   *
   * Tried whole first, then with the trailing segment dropped: `using Foo.Bar`
   * names a namespace outright, while PHP's `use App\Models\User` names a
   * *class* inside `App\Models`, so the prefix is what was declared.
   */
  private resolveNamespace(lang: SymbolLang, spec: string): string | undefined {
    const family = languageFamily(lang);
    const normalized = normalizeNamespace(spec);
    const exact = this.byNamespace.get(`${family}:${normalized}`);
    if (exact) return exact;

    const segments = normalized.split('.').filter(Boolean);
    if (segments.length < 2) return undefined;
    return this.byNamespace.get(`${family}:${segments.slice(0, -1).join('.')}`);
  }

  // ─── Lookup primitives ──────────────────────────────────────────────────────

  private lookup(candidate: string): string | undefined {
    return this.byPath.get(path.posix.normalize(candidate).toLowerCase());
  }

  /**
   * Try `base` verbatim, then `base` + each extension, then each directory
   * entry point inside `base`.
   */
  private lookupWithExtensions(base: string, family: string): string | undefined {
    const direct = this.lookup(base);
    if (direct) return direct;

    const extensions = EXTENSIONS[family] ?? [];
    // Strip a specifier-level extension (`./foo.js` in an ESM-style TS import
    // names a file that is `foo.ts` on disk) and retry the stem.
    const suffix = path.posix.extname(base);
    const stem = suffix && extensions.includes(suffix) ? base.slice(0, -suffix.length) : base;
    for (const ext of extensions) {
      const hit = this.lookup(`${stem}${ext}`);
      if (hit) return hit;
    }
    for (const entry of DIRECTORY_ENTRIES[family] ?? []) {
      for (const ext of extensions) {
        const hit = this.lookup(path.posix.join(base, `${entry}${ext}`));
        if (hit) return hit;
      }
    }
    return undefined;
  }

  /**
   * A representative indexed file inside `dir`, for ecosystems whose import
   * unit is a directory rather than a file (Go packages, JVM wildcard imports).
   *
   * The choice is deterministic — a file named after the directory, else the
   * first by name — so the same import always produces the same edge. Package
   * grouping is unaffected either way: every file in the directory carries the
   * same package label, so the package-level edge is exact regardless of which
   * member represents it.
   */
  private representativeIn(dir: string, family: string): string | undefined {
    const members = this.byDir.get(path.posix.normalize(dir).toLowerCase());
    if (!members?.length) return undefined;
    const extensions = EXTENSIONS[family] ?? [];
    const eligible = members
      .filter((file) => extensions.includes(path.posix.extname(toPortablePath(file)).toLowerCase()))
      .sort((a, b) => toPortablePath(a).localeCompare(toPortablePath(b)));
    if (eligible.length === 0) return undefined;
    const base = path.posix.basename(path.posix.normalize(dir)).toLowerCase();
    const named = eligible.find(
      (file) => path.posix.basename(toPortablePath(file)).split('.')[0]?.toLowerCase() === base,
    );
    return named ?? eligible[0];
  }

  // ─── Per-family resolution ──────────────────────────────────────────────────

  /** Relative specifiers, then workspace package names and their subpaths. */
  private resolveJs(fromFile: string, spec: string): string | undefined {
    if (spec.startsWith('.')) {
      const absolute = path.posix.join(path.posix.dirname(fromFile), spec);
      return this.lookupWithExtensions(absolute, 'js');
    }

    // Workspace package: `@scope/pkg` or `@scope/pkg/sub/path`.
    const owner = this.structure.roots.find(
      (root) =>
        root.kind === 'npm' &&
        root.importPath !== undefined &&
        (spec === root.importPath || spec.startsWith(`${root.importPath}/`)),
    );
    if (!owner?.importPath) return undefined;

    const subpath = spec.slice(owner.importPath.length).replace(/^\//, '');
    if (!subpath) {
      // Bare package import → its entry point. `src/index.*` is the layout this
      // repo and most TS monorepos use; `index.*` covers the flat layout.
      return (
        this.lookupWithExtensions(path.posix.join(owner.dir, 'src/index'), 'js') ??
        this.lookupWithExtensions(path.posix.join(owner.dir, 'index'), 'js')
      );
    }
    return (
      this.lookupWithExtensions(path.posix.join(owner.dir, subpath), 'js') ??
      this.lookupWithExtensions(path.posix.join(owner.dir, 'src', subpath), 'js')
    );
  }

  /** Go import paths are absolute module paths; a package is a directory. */
  private resolveGo(spec: string): string | undefined {
    const owner = this.structure.roots.find(
      (root) =>
        root.kind === 'go' &&
        root.importPath !== undefined &&
        (spec === root.importPath || spec.startsWith(`${root.importPath}/`)),
    );
    if (!owner?.importPath) return undefined; // stdlib or third-party
    const subpath = spec.slice(owner.importPath.length).replace(/^\//, '');
    return this.representativeIn(path.posix.join(owner.dir, subpath), 'go');
  }

  /**
   * `import a.b.c` / `from a.b import c`, plus PEP 328 relative imports whose
   * leading dots the extractor preserves (`.sibling`, `..parent.mod`).
   */
  private resolvePython(fromFile: string, spec: string): string | undefined {
    const leadingDots = /^\.*/.exec(spec)?.[0].length ?? 0;
    if (leadingDots > 0) {
      // One dot means "this package"; each extra dot climbs one level.
      let base = path.posix.dirname(fromFile);
      for (let i = 1; i < leadingDots; i++) base = path.posix.dirname(base);
      const rest = spec.slice(leadingDots).split('.').filter(Boolean);
      return this.lookupWithExtensions(path.posix.join(base, ...rest), 'py');
    }

    const segments = spec.split('.').filter(Boolean);
    if (segments.length === 0) return undefined;

    const sourceRoots = this.structure.roots
      .filter((root) => root.kind === 'python')
      .flatMap((root) => root.sourceRoots);
    // Absolute imports also resolve against the project root: a flat repo with
    // no packaging manifest still imports its own top-level modules by name.
    for (const base of [...sourceRoots, this.structure.projectRoot]) {
      const hit = this.lookupWithExtensions(path.posix.join(base, ...segments), 'py');
      if (hit) return hit;
      // `from a.b import name` — the trailing segment may be a symbol, not a
      // module, so retry one level up.
      if (segments.length > 1) {
        const parent = this.lookupWithExtensions(
          path.posix.join(base, ...segments.slice(0, -1)),
          'py',
        );
        if (parent) return parent;
      }
    }
    return undefined;
  }

  /** `use crate::a::b`, `use super::x`, `use self::y`, `use other_crate::z`. */
  private resolveRust(fromFile: string, spec: string): string | undefined {
    const segments = spec.split('::').filter(Boolean);
    if (segments.length === 0) return undefined;
    const head = segments[0];

    if (head === 'self' || head === 'super') {
      let base = path.posix.dirname(fromFile);
      for (const segment of segments) {
        if (segment === 'super') base = path.posix.dirname(base);
        else if (segment !== 'self') break;
      }
      const rest = segments.filter((segment) => segment !== 'self' && segment !== 'super');
      return this.lookupWithExtensions(path.posix.join(base, ...rest), 'rs');
    }

    const owningCrate = findOwningRoot(this.structure, fromFile, ['cargo']);
    const crate =
      head === 'crate'
        ? owningCrate
        : this.structure.roots.find(
            (root) => root.kind === 'cargo' && root.importPath === head?.replace(/-/g, '_'),
          );
    if (!crate) {
      // `mod parser;` names a sibling module, not a crate: it resolves to
      // `parser.rs` or `parser/mod.rs` next to the declaring file.
      return this.lookupWithExtensions(
        path.posix.join(path.posix.dirname(fromFile), ...segments),
        'rs',
      );
    }

    const rest = segments.slice(1);
    for (const base of crate.sourceRoots) {
      // The trailing segment of a `use` is usually the imported item, not a
      // module, so the parent path is tried first.
      const parent =
        rest.length > 1
          ? this.lookupWithExtensions(path.posix.join(base, ...rest.slice(0, -1)), 'rs')
          : undefined;
      const exact = this.lookupWithExtensions(path.posix.join(base, ...rest), 'rs');
      const hit = exact ?? parent ?? this.lookupWithExtensions(path.posix.join(base, 'lib'), 'rs');
      if (hit) return hit;
    }
    return undefined;
  }

  /** `com.example.Thing` and `com.example.*` against JVM source roots. */
  private resolveJvm(spec: string): string | undefined {
    const segments = spec.split('.').filter(Boolean);
    if (segments.length === 0) return undefined;

    const sourceRoots = this.structure.roots
      .filter((root) => root.kind === 'maven' || root.kind === 'gradle')
      .flatMap((root) => root.sourceRoots);

    const wildcard = segments[segments.length - 1] === '*';
    const parts = wildcard ? segments.slice(0, -1) : segments;
    for (const base of [...sourceRoots, this.structure.projectRoot]) {
      const target = path.posix.join(base, ...parts);
      const hit = wildcard
        ? this.representativeIn(target, 'jvm')
        : this.lookupWithExtensions(target, 'jvm');
      if (hit) return hit;
    }
    return undefined;
  }

  /** `#include "foo/bar.h"` — quoted form only; `<…>` is a system header. */
  private resolveInclude(fromFile: string, spec: string): string | undefined {
    const relative = this.lookupWithExtensions(
      path.posix.join(path.posix.dirname(fromFile), spec),
      'c',
    );
    if (relative) return relative;
    // Common convention: an `include/` directory at the nearest project root.
    for (const base of [
      path.posix.join(this.structure.projectRoot, 'include'),
      this.structure.projectRoot,
    ]) {
      const hit = this.lookupWithExtensions(path.posix.join(base, spec), 'c');
      if (hit) return hit;
    }
    return undefined;
  }

  /** `require_relative 'x'` is relative; `require 'x'` is looked up under lib/. */
  private resolveRuby(fromFile: string, spec: string): string | undefined {
    const relative = this.lookupWithExtensions(
      path.posix.join(path.posix.dirname(fromFile), spec),
      'ruby',
    );
    if (relative) return relative;
    for (const base of [
      path.posix.join(this.structure.projectRoot, 'lib'),
      this.structure.projectRoot,
    ]) {
      const hit = this.lookupWithExtensions(path.posix.join(base, spec), 'ruby');
      if (hit) return hit;
    }
    return undefined;
  }
}
