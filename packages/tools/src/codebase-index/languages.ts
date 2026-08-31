/**
 * Single source of truth for which files are indexable and which
 * {@link SymbolLang} they map to.
 *
 * Keep this list broad: missing a native AST parser must never mean "skip
 * the file". Unknown programming/config sources still go through the generic
 * regex extractor under their mapped lang (or `'other'`).
 */

import type { SymbolLang } from './schema.js';

/**
 * Extension → language. Keys are lowercase including the leading dot.
 * Multi-dot extensions (`.d.ts`) are handled specially in {@link detectLang}.
 */
export const EXT_TO_LANG: Readonly<Record<string, SymbolLang>> = {
  // TypeScript / JavaScript (first-class TS compiler API)
  '.ts': 'ts',
  '.mts': 'ts',
  '.cts': 'ts',
  '.tsx': 'tsx',
  '.js': 'js',
  '.mjs': 'js',
  '.cjs': 'js',
  '.jsx': 'jsx',

  // First-class native/spawn parsers (+ regex fallback)
  '.go': 'go',
  '.py': 'py',
  '.pyi': 'py',
  '.pyw': 'py',
  '.rs': 'rs',
  '.json': 'json',
  '.jsonc': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',

  // C family
  '.c': 'c',
  '.h': 'c',
  '.cc': 'cpp',
  '.cpp': 'cpp',
  '.cxx': 'cpp',
  '.hh': 'cpp',
  '.hpp': 'cpp',
  '.hxx': 'cpp',

  // JVM / .NET
  '.java': 'java',
  '.cs': 'csharp',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.scala': 'scala',
  '.sc': 'scala',

  // Scripting
  '.php': 'php',
  '.rb': 'ruby',
  '.swift': 'swift',
  '.dart': 'dart',
  '.lua': 'lua',
  '.r': 'r',
  '.R': 'r',
  '.pl': 'other',
  '.pm': 'other',

  // Systems / functional
  '.zig': 'zig',
  '.ex': 'elixir',
  '.exs': 'elixir',
  '.hs': 'haskell',
  '.lhs': 'haskell',

  // Shell / data / docs / web
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  '.ps1': 'shell',
  '.sql': 'sql',
  '.md': 'md',
  '.mdx': 'md',
  '.toml': 'toml',
  '.html': 'html',
  '.htm': 'html',
  '.css': 'css',
  '.scss': 'css',
  '.less': 'css',
  '.vue': 'vue',
  '.svelte': 'svelte',
  '.proto': 'proto',
  '.graphql': 'graphql',
  '.gql': 'graphql',
};

/** Sorted unique extension list for discovery walks. */
export const INDEXABLE_EXTENSIONS: readonly string[] = Object.freeze(
  [...new Set(Object.keys(EXT_TO_LANG).map((e) => e.toLowerCase()))].sort(),
);

/** Filenames without (or with special) extensions that should still be indexed. */
const SPECIAL_FILENAMES: Readonly<Record<string, SymbolLang>> = {
  makefile: 'other',
  gnumakefile: 'other',
  dockerfile: 'other',
  'docker-compose.yml': 'yaml',
  'docker-compose.yaml': 'yaml',
  'cmakelists.txt': 'other',
  gemfile: 'ruby',
  rakefile: 'ruby',
  procfile: 'other',
  justfile: 'other',
};

/**
 * Detect {@link SymbolLang} from a file path.
 * Returns `null` only for paths we intentionally refuse to index (binary
 * assets, lockfiles handled elsewhere, plain `.txt` without special name, …).
 */
export function detectLang(file: string): SymbolLang | null {
  const lastSlash = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
  const base = lastSlash === -1 ? file : file.slice(lastSlash + 1);
  const lowerBase = base.toLowerCase();

  // declaration files: foo.d.ts → ts
  if (lowerBase.endsWith('.d.ts') || lowerBase.endsWith('.d.mts') || lowerBase.endsWith('.d.cts')) {
    return 'ts';
  }

  const special = SPECIAL_FILENAMES[lowerBase];
  if (special) return special;

  const dot = lowerBase.lastIndexOf('.');
  if (dot <= 0) return null;
  const ext = lowerBase.slice(dot);
  return EXT_TO_LANG[ext] ?? null;
}

/** True when the path is eligible for the codebase index. */
export function isIndexablePath(file: string): boolean {
  return detectLang(file) !== null;
}

// ─── Language families ────────────────────────────────────────────────────────

/**
 * A group of {@link SymbolLang}s whose symbols may legitimately reference each
 * other by bare name.
 *
 * Ref resolution matches `to_name` against `symbols.name`. Done globally that
 * is actively wrong once more than one language is indexed: `main`, `New`,
 * `Get`, `String`, `__init__`, `Parse` and `Config` all exist in half a dozen
 * languages at once, so a Go call would resolve to a TypeScript declaration and
 * draw a Code Atlas edge between files that have nothing to do with each other.
 * Scoping resolution to a family keeps cross-language noise out while still
 * letting genuinely mixed families (`.ts`/`.tsx` + the script block of a
 * `.vue`/`.svelte` file, `.java`/`.kt` on the JVM) resolve into one another.
 */
type LangFamily =
  | 'js'
  | 'go'
  | 'py'
  | 'rs'
  | 'jvm'
  | 'dotnet'
  | 'c'
  | 'ruby'
  | 'php'
  | 'swift'
  | 'dart'
  | 'elixir'
  | 'haskell'
  | 'zig'
  | 'lua'
  | 'r'
  | 'shell'
  | 'sql'
  | 'data'
  | 'web'
  | 'proto'
  | 'graphql'
  | 'other';

const LANG_FAMILY: Readonly<Record<SymbolLang, LangFamily>> = {
  // Single-compilation-unit family: a .vue/.svelte script block is JS/TS and
  // imports from — and is imported by — plain .ts files.
  ts: 'js',
  tsx: 'js',
  js: 'js',
  jsx: 'js',
  vue: 'js',
  svelte: 'js',

  go: 'go',
  py: 'py',
  rs: 'rs',

  // The JVM resolves across languages: Kotlin and Scala call Java directly.
  java: 'jvm',
  kotlin: 'jvm',
  scala: 'jvm',

  csharp: 'dotnet',

  // A .h header is consumed by both C and C++ translation units.
  c: 'c',
  cpp: 'c',

  ruby: 'ruby',
  php: 'php',
  swift: 'swift',
  dart: 'dart',
  elixir: 'elixir',
  haskell: 'haskell',
  zig: 'zig',
  lua: 'lua',
  r: 'r',
  shell: 'shell',
  sql: 'sql',

  json: 'data',
  yaml: 'data',
  toml: 'data',

  html: 'web',
  css: 'web',

  proto: 'proto',
  graphql: 'graphql',

  md: 'other',
  other: 'other',
};

/**
 * `(lang, family)` pairs, for mirroring the mapping into SQLite so ref
 * resolution can join on it instead of expanding a family into an IN-list of
 * placeholders on every statement.
 */
export const LANG_FAMILY_ENTRIES: ReadonlyArray<readonly [SymbolLang, LangFamily]> = Object.freeze(
  (Object.entries(LANG_FAMILY) as Array<[SymbolLang, LangFamily]>).map(
    ([lang, family]) => Object.freeze([lang, family]) as readonly [SymbolLang, LangFamily],
  ),
);

/** Family a language resolves within. */
export function languageFamily(lang: SymbolLang): LangFamily {
  return LANG_FAMILY[lang] ?? 'other';
}

/** Every language in the same resolution family as `lang`, including itself. */
export function familyMembers(lang: SymbolLang): SymbolLang[] {
  const family = languageFamily(lang);
  return (Object.keys(LANG_FAMILY) as SymbolLang[]).filter(
    (candidate) => LANG_FAMILY[candidate] === family,
  );
}
