/**
 * Universal regex symbol extractor.
 *
 * Used for:
 *  - languages without a first-class AST parser (Java, C++, Ruby, …)
 *  - fallback when a native toolchain is missing (Python without `python`,
 *    Go without `go`, Rust without cargo/syn)
 *
 * Patterns are intentionally recall-oriented: better a few false positives
 * in the index than silently dropping whole packages from search/code-map.
 */

import type { FileSymbols, Symbol as IndexSymbol, SymbolKind, SymbolLang } from './schema.js';

interface ExtractPattern {
  /** Global regex; capture group 1 must be the symbol name. */
  re: RegExp;
  kind: SymbolKind;
}

/** Shared C-like declaration patterns (C/C++/Java/C#/… approximate). */
const C_LIKE: ExtractPattern[] = [
  { re: /\b(?:class|struct|enum|interface|union)\s+([A-Za-z_]\w*)/g, kind: 'class' },
  {
    // H-10 (security report VF-11): the old shape
    // `(?:…modifiers…)?\s*(?:[\w:<>[\]\s*&]+)\s+name\(` had three adjacent
    // quantifiers that could each consume whitespace (`\s*`, the class with
    // `\s` inside, `\s+`) — catastrophic backtracking on whitespace runs
    // (516 bytes = 4.5 s measured). Decomposed so whitespace is owned by
    // exactly one position: modifiers each consume their own trailing
    // whitespace, the type is a single no-whitespace class, one `\s+`
    // separates type from name. Generic types with internal spaces
    // (`Map<String, Integer> x;`) are no longer matched — tree-sitter is the
    // primary parser for C/C++ and this is only its WASM-less fallback.
    re: /\b(?:(?:public|private|protected|static|final|async|override|virtual|inline|export)\s+)?[\w:<>[\]*&]+\s+([A-Za-z_]\w*)\s*\([^;{]*\)\s*(?:const)?\s*[{;]/g,
    kind: 'function',
  },
  { re: /\b(?:namespace)\s+([A-Za-z_]\w*)/g, kind: 'namespace' },
];

const LANG_PATTERNS: Partial<Record<SymbolLang, ExtractPattern[]>> = {
  py: [
    { re: /^(?:async\s+)?def\s+([A-Za-z_]\w*)/gm, kind: 'function' },
    { re: /^class\s+([A-Za-z_]\w*)/gm, kind: 'class' },
    { re: /^([A-Za-z_]\w*)\s*=/gm, kind: 'var' },
  ],
  go: [
    { re: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/gm, kind: 'function' },
    { re: /^type\s+([A-Za-z_]\w*)\b/gm, kind: 'type' },
    { re: /^(?:const|var)\s+([A-Za-z_]\w*)\b/gm, kind: 'const' },
    { re: /^package\s+([A-Za-z_]\w*)/gm, kind: 'namespace' },
  ],
  rs: [
    { re: /\bfn\s+([A-Za-z_]\w*)/g, kind: 'function' },
    { re: /\bstruct\s+([A-Za-z_]\w*)/g, kind: 'struct' },
    { re: /\benum\s+([A-Za-z_]\w*)/g, kind: 'enum' },
    { re: /\btrait\s+([A-Za-z_]\w*)/g, kind: 'trait' },
    { re: /\bimpl(?:\s*<[^>]+>)?\s+([A-Za-z_]\w*)/g, kind: 'impl' },
    { re: /\b(?:const|static)\s+([A-Za-z_]\w*)/g, kind: 'const' },
    { re: /\bmod\s+([A-Za-z_]\w*)/g, kind: 'mod' },
  ],
  c: C_LIKE,
  cpp: C_LIKE,
  java: [
    { re: /\b(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/g, kind: 'class' },
    {
      // H-10 (security report VF-11): same rewrite as C_LIKE above — the old
      // `(?:…|\s)+\s*[\w.<>,[\]\s]+\s+` let three quantifiers compete for the
      // same whitespace (800 bytes of padding measured at 42 s). Whitespace
      // now has exactly one owner per position.
      re: /\b(?:(?:public|private|protected|static|final|abstract|synchronized|native|default)\s+)*[\w.$,<>[\]]+\s+([A-Za-z_]\w*)\s*\(/g,
      kind: 'method',
    },
  ],
  csharp: [
    { re: /\b(?:class|interface|struct|enum|record)\s+([A-Za-z_]\w*)/g, kind: 'class' },
    { re: /\bnamespace\s+([A-Za-z_.\w]+)/g, kind: 'namespace' },
    {
      // H-10: see java above.
      re: /\b(?:(?:public|private|protected|internal|static|async|override|virtual)\s+)*[\w.$,<>[\]]+\s+([A-Za-z_]\w*)\s*\(/g,
      kind: 'method',
    },
  ],
  php: [
    { re: /\bfunction\s+([A-Za-z_]\w*)/g, kind: 'function' },
    { re: /\bclass\s+([A-Za-z_]\w*)/g, kind: 'class' },
    { re: /\binterface\s+([A-Za-z_]\w*)/g, kind: 'interface' },
    { re: /\bnamespace\s+([A-Za-z_\\]+)/g, kind: 'namespace' },
  ],
  ruby: [
    { re: /^\s*def\s+(?:self\.)?([A-Za-z_]\w*[!?]?)/gm, kind: 'function' },
    { re: /^\s*class\s+([A-Za-z_]\w*)/gm, kind: 'class' },
    { re: /^\s*module\s+([A-Za-z_]\w*)/gm, kind: 'namespace' },
  ],
  swift: [
    { re: /\b(?:func)\s+([A-Za-z_]\w*)/g, kind: 'function' },
    { re: /\b(?:class|struct|enum|protocol|actor)\s+([A-Za-z_]\w*)/g, kind: 'class' },
  ],
  kotlin: [
    { re: /\b(?:fun)\s+([A-Za-z_]\w*)/g, kind: 'function' },
    {
      re: /\b(?:class|interface|object|enum\s+class|data\s+class)\s+([A-Za-z_]\w*)/g,
      kind: 'class',
    },
  ],
  scala: [
    { re: /\b(?:def)\s+([A-Za-z_]\w*)/g, kind: 'function' },
    { re: /\b(?:class|object|trait|enum)\s+([A-Za-z_]\w*)/g, kind: 'class' },
  ],
  shell: [
    { re: /^(?:function\s+)?([A-Za-z_]\w*)\s*\(\)\s*\{/gm, kind: 'function' },
    { re: /^([A-Za-z_][\w]*)\s*\(\)\s*\{/gm, kind: 'function' },
  ],
  sql: [
    {
      re: /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|VIEW|INDEX|FUNCTION|PROCEDURE|TRIGGER)\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_"][\w."]*)/gi,
      kind: 'type',
    },
  ],
  md: [{ re: /^(#{1,6})\s+(.+)$/gm, kind: 'namespace' }],
  toml: [{ re: /^\[([^\]]+)\]/gm, kind: 'namespace' }],
  html: [
    { re: /\bid\s*=\s*["']([^"']+)["']/gi, kind: 'property' },
    { re: /<(?:script|template|style)\b/gi, kind: 'namespace' },
  ],
  css: [
    { re: /^\s*([.#]?[A-Za-z_][\w-]*)\s*\{/gm, kind: 'type' },
    { re: /@(?:keyframes|media|supports)\s+([^{\s]+)/g, kind: 'namespace' },
  ],
  vue: [
    {
      re: /\b(?:function|const|let|var|class|export\s+(?:default\s+)?(?:function|class|const))\s+([A-Za-z_]\w*)/g,
      kind: 'function',
    },
    { re: /<(?:script|template|style)\b/gi, kind: 'namespace' },
  ],
  svelte: [
    {
      re: /\b(?:function|const|let|var|class|export\s+(?:default\s+)?(?:function|class|const))\s+([A-Za-z_]\w*)/g,
      kind: 'function',
    },
  ],
  dart: [
    { re: /\b(?:class|enum|mixin|extension)\s+([A-Za-z_]\w*)/g, kind: 'class' },
    { re: /\b([A-Za-z_]\w*)\s*\([^;]*\)\s*(?:async\s*)?\{/g, kind: 'function' },
  ],
  lua: [
    { re: /\bfunction\s+([A-Za-z_.:]\w*)/g, kind: 'function' },
    { re: /\blocal\s+function\s+([A-Za-z_]\w*)/g, kind: 'function' },
  ],
  r: [
    { re: /([A-Za-z.]\w*)\s*<-\s*function\s*\(/g, kind: 'function' },
    { re: /([A-Za-z.]\w*)\s*=\s*function\s*\(/g, kind: 'function' },
  ],
  proto: [
    { re: /\b(?:message|service|enum)\s+([A-Za-z_]\w*)/g, kind: 'type' },
    { re: /\brpc\s+([A-Za-z_]\w*)/g, kind: 'function' },
  ],
  graphql: [
    { re: /\b(?:type|interface|enum|input|union|scalar)\s+([A-Za-z_]\w*)/g, kind: 'type' },
    { re: /\b(?:query|mutation|subscription)\s+([A-Za-z_]\w*)/g, kind: 'function' },
  ],
  zig: [
    { re: /\b(?:fn|pub\s+fn)\s+([A-Za-z_]\w*)/g, kind: 'function' },
    { re: /\b(?:const|var)\s+([A-Za-z_]\w*)/g, kind: 'const' },
    { re: /\b(?:struct|enum|union)\s*\{/g, kind: 'type' },
  ],
  elixir: [
    { re: /\bdef(?:p|macro|macrop)?\s+([A-Za-z_]\w*[!?]?)/g, kind: 'function' },
    // Dotted module names must be captured whole: `alias Foo.Bar` resolves
    // against this symbol, and a `Foo`-only capture never matches it.
    { re: /\bdefmodule\s+([A-Z][\w.]*)/g, kind: 'namespace' },
  ],
  haskell: [
    // Target of `import Data.List`.
    { re: /^module\s+([A-Z][\w.]*)/gm, kind: 'namespace' },
    { re: /^([A-Za-z_]\w*)\s*::/gm, kind: 'function' },
    { re: /\bdata\s+([A-Za-z_]\w*)/g, kind: 'type' },
    { re: /\btype\s+(?:family\s+)?([A-Za-z_]\w*)/g, kind: 'type' },
    { re: /\bclass\s+([A-Za-z_]\w*)/g, kind: 'class' },
  ],
  other: [
    { re: /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_]\w*)/gm, kind: 'function' },
    { re: /^(?:export\s+)?class\s+([A-Za-z_]\w*)/gm, kind: 'class' },
    { re: /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_]\w*)/gm, kind: 'const' },
    { re: /^(?:async\s+)?def\s+([A-Za-z_]\w*)/gm, kind: 'function' },
    { re: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm, kind: 'function' },
    { re: /\bfn\s+([A-Za-z_]\w*)/g, kind: 'function' },
    { re: /^(?:target|PHONY)\s*:/gm, kind: 'namespace' },
  ],
};

const KEYWORDS = new Set([
  'if',
  'else',
  'for',
  'while',
  'switch',
  'case',
  'return',
  'break',
  'continue',
  'new',
  'delete',
  'typeof',
  'instanceof',
  'void',
  'null',
  'true',
  'false',
  'this',
  'super',
  'import',
  'export',
  'from',
  'as',
  'default',
  'public',
  'private',
  'protected',
  'static',
  'final',
  'class',
  'struct',
  'enum',
  'interface',
  'function',
  'def',
  'fn',
  'func',
  'var',
  'let',
  'const',
  'package',
  'namespace',
  'module',
  'using',
  'include',
  'require',
  'select',
  'from',
  'where',
  'and',
  'or',
  'not',
  'in',
  'is',
  'try',
  'catch',
  'finally',
  'throw',
  'async',
  'await',
  'yield',
]);

function patternsFor(lang: SymbolLang): ExtractPattern[] {
  return LANG_PATTERNS[lang] ?? LANG_PATTERNS.other ?? [];
}

function looksBinary(content: string): boolean {
  // NUL byte → almost certainly not source text
  if (content.includes('\0')) return true;
  // High ratio of non-printable in the first 2KB
  const sample = content.slice(0, 2048);
  if (sample.length === 0) return false;
  let bad = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13) continue;
    if (c < 32 || c === 127) bad++;
  }
  return bad / sample.length > 0.1;
}

/**
 * Offsets of every newline, so match→line is a binary search instead of a
 * rescan from the top of the file for each of up to 500 matches.
 * Mirrors the pattern in `import-extractor.ts`.
 */
function newlineOffsets(content: string): number[] {
  const offsets: number[] = [];
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) offsets.push(i);
  }
  return offsets;
}

/**
 * 1-based {line, col} for a character offset, using binary search over
 * precomputed newline offsets. O(log n) per lookup instead of O(n).
 */
function lineColAt(offsets: number[], index: number): { line: number; col: number } {
  let low = 0;
  let high = offsets.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if ((offsets[mid] ?? 0) < index) low = mid + 1;
    else high = mid;
  }
  // low = number of newlines before index; line is 1-based
  const lastNl = low > 0 ? offsets[low - 1]! : -1;
  return { line: low + 1, col: index - lastNl };
}

/** Soft default: enough for normal sources without runaway regex on minified blobs. */
export const GENERIC_MAX_SYMBOLS_DEFAULT = 500;
/**
 * Only the leading window is scanned — huge generated files stay cheap.
 * H-10 (security report VF-11): lowered from 512 KB. The fallback regex
 * extractor is a last resort (tree-sitter missing/failed), and a whitespace
 * bomb under the old window needed only ~500 bytes to stall the indexer for
 * seconds — the remaining risk scales with window size, so the window itself
 * is bounded well below real source-file sizes.
 */
export const GENERIC_MAX_FILE_CHARS = 128 * 1024;

/**
 * Extract symbols with language-tuned regexes. Never throws.
 * Caps results so pathological files cannot explode the index.
 */
export function parseGeneric(opts: {
  file: string;
  content: string;
  lang: SymbolLang;
  /** Soft cap per file (default {@link GENERIC_MAX_SYMBOLS_DEFAULT}). */
  maxSymbols?: number;
}): FileSymbols {
  const { file, lang } = opts;
  const maxSymbols = opts.maxSymbols ?? GENERIC_MAX_SYMBOLS_DEFAULT;
  const mtimeMs = Date.now();

  if (!opts.content || looksBinary(opts.content)) {
    return { file, lang, symbols: [], mtimeMs };
  }
  // Bound CPU: never regex-scan multi-MB blobs in full.
  const content =
    opts.content.length > GENERIC_MAX_FILE_CHARS
      ? opts.content.slice(0, GENERIC_MAX_FILE_CHARS)
      : opts.content;

  const patterns = patternsFor(lang);
  const symbols: IndexSymbol[] = [];
  const seen = new Set<string>();
  // Precompute newline offsets once per file — O(file_length) scan instead of
  // O(symbols × file_length) with the per-match linear scan.
  const nlOffsets = newlineOffsets(content);

  for (const pattern of patterns) {
    // Clone flags so lastIndex never leaks across files.
    const re = new RegExp(
      pattern.re.source,
      pattern.re.flags.includes('g') ? pattern.re.flags : `${pattern.re.flags}g`,
    );
    re.lastIndex = 0;
    for (const match of content.matchAll(re)) {
      if (symbols.length >= maxSymbols) break;

      let name = (match[1] ?? match[2] ?? '').trim();
      // Markdown headings put the title in group 2
      if (lang === 'md' && match[2]) name = match[2].trim();
      if (!name || name.length > 200) continue;
      // Strip markdown heading markers accidentally captured
      name = name.replace(/^#+\s*/, '').replace(/["'`]/g, '');
      if (!name || KEYWORDS.has(name.toLowerCase())) continue;
      // Reject pure punctuation / numbers
      if (!/^[A-Za-z_#.@/\w][\w.\-:/#!?]*$/.test(name) && lang !== 'md' && lang !== 'toml') {
        continue;
      }

      const { line, col } = lineColAt(nlOffsets, match.index ?? 0);
      const key = `${name}\0${line}\0${pattern.kind}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const nl = content.indexOf('\n', match.index);
      const lineText = content.slice(match.index, nl === -1 ? content.length : nl);
      const signature = (lineText || name).trim().slice(0, 500);

      symbols.push({
        id: 0,
        lang,
        kind: lang === 'md' ? 'namespace' : pattern.kind,
        name: name.slice(0, 200),
        file,
        line,
        col,
        signature,
        docComment: '',
        scope: '',
        text: `${name} ${signature}`.trim().slice(0, 1000),
      });
    }
    if (symbols.length >= maxSymbols) break;
  }

  return { file, lang, symbols, mtimeMs };
}

/** Async wrapper matching other parser entrypoints. */
export async function parseSymbols(opts: {
  file: string;
  content: string;
  lang: SymbolLang;
}): Promise<FileSymbols> {
  return parseGeneric(opts);
}
