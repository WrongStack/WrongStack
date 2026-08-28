/**
 * Import extraction for languages without an AST parser.
 *
 * Deliberately imports only — no call or type references. An import statement
 * has a rigid, line-anchored syntax that a regex reads correctly; a call site
 * does not, and a regex "call graph" produces edges that look authoritative
 * while being mostly wrong. Dependency edges are what the Code Atlas is built
 * around, so extracting those well beats extracting everything badly.
 *
 * Languages with a real parser (TS/JS via the compiler API, Go and Python via
 * their own `ast` modules) never reach this module.
 */

import type { Ref, SymbolLang } from './schema.js';

/** Only the leading window is scanned, mirroring the generic symbol extractor. */
const IMPORT_MAX_FILE_CHARS = 512 * 1024;
/** Upper bound on imports recorded per file. */
const IMPORT_MAX_PER_FILE = 400;

interface ImportPattern {
  /**
   * Global, multiline regex whose capture group 1 is the module specifier.
   *
   * Line-anchored patterns must use `^[ \t]*`, never `^\s*`: `\s` matches
   * newlines, so the match would start on the preceding blank line and report
   * the import one line too early.
   */
  re: RegExp;
  /**
   * How the referenced *name* is derived from the specifier, for the graph
   * readers' symbol-id fallback when module resolution finds no file:
   *  - `last`: trailing segment, extension stripped (`com.foo.Bar` → `Bar`)
   *  - `full`: the whole specifier (namespace ecosystems, where a `namespace`
   *    declaration carries the dotted name verbatim)
   */
  name?: 'last' | 'full';
}

/** `import x` / `import x as y` style: dotted or slashed module paths. */
const DOTTED_IMPORT: ImportPattern[] = [
  { re: /^[ \t]*import\s+(?:static\s+)?([\w.]+(?:\.\*)?)\s*;?\s*$/gm },
];

const LANG_IMPORTS: Partial<Record<SymbolLang, ImportPattern[]>> = {
  // Go and Python have real AST extractors; these patterns are the fallback for
  // machines with no Go toolchain or Python interpreter installed, where the
  // parser degrades to regex symbols and would otherwise contribute no edges.
  go: [
    { re: /^[ \t]*import\s+(?:[\w.]+\s+)?"([^"]+)"/gm },
    // Grouped form: inside `import ( … )` each line is an optional alias plus a
    // quoted path. A stray match elsewhere resolves to no file and is dropped.
    { re: /^[ \t]*(?:[A-Za-z_.]\w*\s+)?"([^"]+)"\s*$/gm },
  ],
  py: [{ re: /^[ \t]*import\s+([\w.]+)/gm }, { re: /^[ \t]*from\s+([.\w]+)\s+import\b/gm }],

  rs: [
    // use a::b::C;  |  use a::b::{C, D};  → the path before any brace
    { re: /^[ \t]*(?:pub\s+)?use\s+([\w:]+?)(?:::\{|\s*;|\s+as\b)/gm },
    // mod foo;  (a declaration *and* a dependency on foo.rs / foo/mod.rs)
    { re: /^[ \t]*(?:pub\s+)?mod\s+(\w+)\s*;/gm },
  ],

  java: DOTTED_IMPORT,
  kotlin: DOTTED_IMPORT,
  scala: [{ re: /^[ \t]*import\s+([\w.]+(?:\.[_*])?)\s*$/gm }],

  csharp: [
    // using Foo.Bar;  |  using static Foo.Bar;  |  using Alias = Foo.Bar;
    { re: /^[ \t]*global\s+using\s+(?:static\s+)?([\w.]+)\s*;/gm, name: 'full' },
    { re: /^[ \t]*using\s+(?:static\s+)?(?:\w+\s*=\s*)?([\w.]+)\s*;/gm, name: 'full' },
  ],

  // Quoted includes only: <stdio.h> is a system header with no indexed file.
  c: [{ re: /^[ \t]*#\s*include\s+"([^"]+)"/gm }],
  cpp: [{ re: /^[ \t]*#\s*include\s+"([^"]+)"/gm }],

  ruby: [{ re: /^[ \t]*(?:require|require_relative|load)\s*\(?\s*['"]([^'"]+)['"]/gm }],

  php: [
    // `use A\B\C` imports the class C, which is what the index has a symbol
    // for — the namespace symbol only covers the `A\B` prefix.
    { re: /^[ \t]*use\s+(?:function\s+|const\s+)?([\w\\]+)/gm },
    { re: /^[ \t]*(?:require|require_once|include|include_once)\s*\(?\s*['"]([^'"]+)['"]/gm },
  ],

  swift: [{ re: /^[ \t]*import\s+(?:struct\s+|class\s+|func\s+)?([\w.]+)\s*$/gm }],

  dart: [{ re: /^[ \t]*(?:import|export|part)\s+['"]([^'"]+)['"]/gm }],

  lua: [{ re: /\brequire\s*\(?\s*['"]([^'"]+)['"]/g }],

  elixir: [{ re: /^[ \t]*(?:alias|import|require|use)\s+([A-Z][\w.]*)/gm, name: 'full' }],

  haskell: [{ re: /^[ \t]*import\s+(?:qualified\s+)?([\w.]+)/gm, name: 'full' }],

  zig: [{ re: /@import\s*\(\s*"([^"]+)"\s*\)/g }],

  proto: [{ re: /^[ \t]*import\s+(?:public\s+|weak\s+)?"([^"]+)"\s*;/gm }],

  // `@import "x"`, `@use "x"`, `@forward "x"` — Sass and plain CSS alike.
  css: [{ re: /^[ \t]*@(?:import|use|forward)\s+(?:url\()?\s*['"]([^'"]+)['"]/gm }],

  // A .vue/.svelte file's <script> block is JS; the same ESM syntax applies.
  vue: [{ re: /^[ \t]*import\s[^'"]*from\s*['"]([^'"]+)['"]/gm }],
  svelte: [{ re: /^[ \t]*import\s[^'"]*from\s*['"]([^'"]+)['"]/gm }],

  html: [
    { re: /<script[^>]+src\s*=\s*['"]([^'"]+)['"]/g },
    { re: /<link[^>]+href\s*=\s*['"]([^'"]+)['"]/g },
  ],

  shell: [{ re: /^[ \t]*(?:source|\.)\s+(\S+)/gm }],

  r: [{ re: /\b(?:source|library|require)\s*\(\s*['"]?([\w./-]+)['"]?\s*\)/g }],
};

/**
 * The name a specifier refers to.
 *
 * Path-like and namespace-like specifiers need opposite treatment of the dot:
 * in `engine/core.h` it introduces a file extension to strip, in
 * `com.example.Helper` it is the segment separator. The presence of a path
 * separator is what tells them apart.
 */
function lastSegment(specifier: string): string {
  const pathLike = /[/\\]|::/.test(specifier);
  const segments = specifier.split(/[/\\]|::/).filter(Boolean);
  let last = segments[segments.length - 1] ?? specifier;

  // `*` / `_` are wildcard imports (Java, Scala); the package is the real target.
  if (last === '*' || last === '_') {
    last = segments[segments.length - 2] ?? specifier;
  }

  if (pathLike) return last.replace(/\.[A-Za-z0-9]{1,8}$/, '') || last;

  const dotted = last.split('.').filter((part) => part && part !== '*' && part !== '_');
  return dotted[dotted.length - 1] ?? last;
}

/**
 * Offsets of every newline, so match→line is a binary search instead of a
 * rescan from the top of the file for each of up to {@link IMPORT_MAX_PER_FILE}
 * matches.
 */
function newlineOffsets(content: string): number[] {
  const offsets: number[] = [];
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) offsets.push(i);
  }
  return offsets;
}

/** 1-based line number for a character offset. */
function lineAt(offsets: readonly number[], index: number): number {
  let low = 0;
  let high = offsets.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if ((offsets[mid] ?? 0) < index) low = mid + 1;
    else high = mid;
  }
  return low + 1;
}

/** True when this language's imports are extracted here rather than by a parser. */
export function hasImportPatterns(lang: SymbolLang): boolean {
  return LANG_IMPORTS[lang] !== undefined;
}

/**
 * Extract `import` refs from source text. Never throws.
 *
 * Returned refs carry `fromId: 0`; the indexer rewrites it to the owning symbol.
 */
export function extractImports(opts: {
  content: string;
  lang: SymbolLang;
  maxImports?: number;
}): Ref[] {
  const patterns = LANG_IMPORTS[opts.lang];
  if (!patterns || !opts.content) return [];

  const limit = opts.maxImports ?? IMPORT_MAX_PER_FILE;
  const content =
    opts.content.length > IMPORT_MAX_FILE_CHARS
      ? opts.content.slice(0, IMPORT_MAX_FILE_CHARS)
      : opts.content;

  const refs: Ref[] = [];
  const seen = new Set<string>();
  const offsets = newlineOffsets(content);

  for (const pattern of patterns) {
    // Clone so `lastIndex` never leaks between files sharing a pattern object.
    const re = new RegExp(pattern.re.source, pattern.re.flags);
    for (const match of content.matchAll(re)) {
      if (refs.length >= limit) return refs;
      const specifier = match[1]?.trim();
      if (!specifier) continue;
      // The specifier is stored exactly as written. Backslashes carry meaning
      // that differs per language — PHP's namespace separator versus a Windows
      // path — so normalizing belongs in the resolver, which knows which it is.
      const module = specifier;
      const toName = pattern.name === 'full' ? module : lastSegment(module);
      if (!toName) continue;
      const key = `${module}\u0000${toName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push({
        fromId: 0,
        toName,
        callType: 'import',
        line: lineAt(offsets, match.index ?? 0),
        lang: opts.lang,
        module,
      });
    }
  }
  return refs;
}
