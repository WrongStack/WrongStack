// ─── Symbol kind taxonomy ───────────────────────────────────────────────────────

/**
 * Language a symbol belongs to.
 *
 * First-class parsers exist for TS/JS, Go, Python, Rust, JSON, YAML.
 * All other langs are still indexed via the generic regex extractor so
 * monorepos are never silently skipped just because a native toolchain
 * is missing. `'other'` covers unusual extensions / special filenames.
 */
export type SymbolLang =
  | 'ts'
  | 'js'
  | 'tsx'
  | 'jsx'
  | 'go'
  | 'py'
  | 'rs'
  | 'json'
  | 'yaml'
  | 'c'
  | 'cpp'
  | 'java'
  | 'csharp'
  | 'php'
  | 'ruby'
  | 'swift'
  | 'kotlin'
  | 'scala'
  | 'shell'
  | 'sql'
  | 'md'
  | 'toml'
  | 'html'
  | 'css'
  | 'vue'
  | 'svelte'
  | 'dart'
  | 'lua'
  | 'r'
  | 'proto'
  | 'graphql'
  | 'zig'
  | 'elixir'
  | 'haskell'
  | 'other';

/** What kind of symbol this is. */
export type SymbolKind =
  | 'class'
  | 'interface'
  | 'enum'
  | 'type'
  | 'function'
  | 'method'
  | 'var'
  | 'const'
  | 'let'
  | 'property'
  | 'parameter'
  | 'namespace'
  | 'object' // JSON root object
  | 'literal' // scalar value in JSON/YAML
  | 'schema' // JSON Schema $ref/$schema entry
  // Rust-specific
  | 'struct'
  | 'trait'
  | 'impl'
  | 'static'
  | 'mod';

/** A single indexed code symbol. */
export interface Symbol {
  id: number;
  lang: SymbolLang;
  kind: SymbolKind;
  name: string;
  file: string; // absolute path
  line: number; // 1-based
  col: number; // 0-based
  signature: string; // e.g. "function foo(a: string): Promise<void>"
  docComment: string; // JSDoc / docstring first line
  scope: string; // e.g. "MyClass.method" or module-level ""
  text: string; // concatenated searchable text: name + signature + docComment
}

/** Extracted symbols and cross-references for one file. */
export interface FileSymbols {
  file: string;
  lang: SymbolLang;
  symbols: Symbol[];
  refs?: Ref[] | undefined; // cross-references extracted from this file (optional for back-compat)
  mtimeMs: number;
}

/** Source file metadata tracked for incremental indexing. */
export interface FileMeta {
  file: string;
  lang: SymbolLang;
  mtimeMs: number;
  symbolCount: number;
  lastIndexed: number; // unix ms
  /**
   * xxHash64 of the file's UTF-8 bytes (Phase 2). `undefined` for callers
   * that don't compute it; the writer stores an empty string in that case.
   * The indexer compares this against the current file's hash to skip
   * re-parsing when content is byte-identical despite an mtime change.
   */
  contentHash?: string | undefined;
}

/** Statistics about the index. */
export interface IndexStats {
  totalSymbols: number;
  totalFiles: number;
  byLang: Record<SymbolLang, number>;
  byKind: Record<SymbolKind, number>;
  indexPath: string;
  lastIndexed: number | null;
  sizeBytes: number;
  version: number;
}

/** Result of a search query. */
export interface SearchResult {
  id: number;
  name: string;
  kind: SymbolKind;
  lang: SymbolLang;
  file: string;
  line: number;
  col: number;
  signature: string;
  docComment: string;
  score: number;
  snippet: string;
  /** Original LSP SymbolKind number if the result was filtered by an LSP kind. */
  lspKind?: number | undefined;
}

/** Result of a full reindex. */
export interface IndexResult {
  /**
   * Files actually parsed and committed with one or more symbols this run
   * (P5.15: exactly `fileOutcomes.parsed`). Skipped (mtime/hash-unchanged),
   * empty, and failed files are reported separately in `fileOutcomes` —
   * historically they inflated this number, misreading incremental runs as
   * doing full work.
   */
  filesIndexed: number;
  /** Outcome detail for this run. Optional for compatibility with older project daemons. */
  fileOutcomes?:
    | {
        /** Files parsed and committed with one or more symbols. */
        parsed: number;
        /** Files reused from trusted metadata or an unchanged content hash. */
        skipped: number;
        /** Files successfully represented in the index with zero symbols. */
        empty: number;
        /** Files that could not be read, parsed, or committed. */
        failed: number;
      }
    | undefined;
  symbolsIndexed: number;
  langStats: Record<SymbolLang, number>;
  durationMs: number;
  errors: string[];
  /**
   * Present when `runStartupIndex` detected a corrupt/stale index (SQLite
   * constraint failure) and automatically recovered by wiping and rebuilding
   * with `force: true`. The original failure message is preserved here so
   * callers diagnosing intermittent crashes can distinguish a normal rebuild
   * from one triggered by corruption recovery.
   */
  autoRecovered?: { failure: string; rebuiltWithForce: true } | undefined;
}

// ─── Cross-reference types ───────────────────────────────────────────────────

/** What kind of reference this is. */
export type CallType = 'call' | 'type_ref' | 'inherit' | 'implement' | 'import';

/** A cross-reference between two symbols (who references whom). */
export interface Ref {
  id?: number | undefined;
  fromId: number; // symbol that makes the reference
  toName: string; // resolved name of the referenced symbol
  toId?: number | undefined; // resolved target symbol id (filled after index resolution)
  callType: CallType; // kind of reference
  line: number; // source line where the reference occurs
  /**
   * Language of the *referencing* file. Name resolution (`toName` → `toId`) is
   * scoped to the referencing language's family, because a global name match
   * links unrelated declarations across languages: `New`/`Get`/`String` in Go,
   * `main`/`__init__` in Python and TS all collide otherwise.
   */
  lang?: SymbolLang | undefined;
  /**
   * Module specifier for `import` refs, verbatim as written in the source
   * (`./foo.js`, `github.com/org/repo/pkg`, `os.path`, `crate::parser`,
   * `com.example.Thing`). `undefined` for every other ref kind.
   *
   * This is deliberately separate from {@link toName}: TS/JS import refs put
   * the imported *symbol* name in `toName` so the dead-code BFS can traverse
   * module boundaries, which means `toName` cannot also carry the module path.
   */
  module?: string | undefined;
  /**
   * Target file an `import` ref resolves to, filled by the post-index module
   * resolution pass. Absolute path, or `undefined` for external/unresolvable
   * modules (stdlib, third-party dependencies).
   */
  toFile?: string | undefined;
}

/**
 * A call site — the enriched result of an incoming/outgoing calls query.
 *
 * Unlike the raw `Ref` type, this carries the full caller/callee symbol
 * metadata (name, kind, file, line, signature) so the agent gets a
 * self-contained answer without a second lookup.
 */
export interface CallSite {
  /** The symbol that makes or receives the call. */
  symbol: {
    id: number;
    name: string;
    kind: SymbolKind;
    lang: SymbolLang;
    file: string;
    line: number;
    signature: string;
  };
  /** Kind of reference: call, type_ref, inherit, implement, import. */
  callType: CallType;
  /** Source line where the reference occurs. */
  line: number;
}

// ─── CodeMap graph types ──────────────────────────────────────────────────────

/** A node in the code-map dependency graph. */
export interface GraphNode {
  id: string;
  label: string;
  kind: 'package' | 'file' | 'symbol';
  /** Package name (packages/) or undefined. */
  package?: string | undefined;
  /** File path (relative to project root) or undefined for package-level. */
  file?: string | undefined;
  /** Symbol id when kind === 'symbol'. */
  symbolId?: number | undefined;
  /** Symbol kind when kind === 'symbol'. */
  symbolKind?: SymbolKind | undefined;
  /** Number of symbols contained (for package/file nodes). */
  symbolCount?: number | undefined;
  /** Number of files contained (for package nodes). */
  fileCount?: number | undefined;
  /** Source language when the node represents a file or symbol. */
  lang?: SymbolLang | undefined;
  /** Declaration line when the node represents a symbol. */
  line?: number | undefined;
  /** Indexed declaration signature when the node represents a symbol. */
  signature?: string | undefined;
  /** Indexed declaration scope when the node represents a symbol. */
  scope?: string | undefined;
  /** True when this is a direct relation outside the current drill-down scope. */
  external?: boolean | undefined;
}

/** A directed edge: source references / depends-on target. */
export interface GraphEdge {
  source: string;
  target: string;
  /** Number of refs contributing to this edge (weight). */
  weight: number;
  /** Dominant ref type: 'call', 'import', 'type_ref', etc. */
  refType: CallType;
}

/** Complete graph response. */
export interface CodeMapGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /**
   * True when the project server served a previous generation's cached
   * answer while a refresh was publishing (stale-read serving). Never set
   * by the worker/inline path, which refuses reads during a refresh.
   */
  stale?: boolean | undefined;
}

// ─── Schema version ───────────────────────────────────────────────────────────

// v2: added the symbols_fts FTS5 table (ranked search moved into SQLite).
// v3: parser/search format update (navigable TS declarations, valid ref owners,
//     acronym/digit token splitting). Derived data must be rebuilt.
// v4: multi-language relations — refs gained `lang` (scopes name resolution to
//     one language family), `module` (import specifier, kept apart from the
//     symbol name TS stores in to_name) and `to_file` (module resolution result,
//     computed once at index time so graph readers stay language-agnostic).
// A version mismatch on open drops & rebuilds the index (it is derived data).
// Non-structural CodeMap relation migrations use `relation_graph_version`
// metadata so older running processes sharing the DB cannot downgrade it.
export const SCHEMA_VERSION = 5;
