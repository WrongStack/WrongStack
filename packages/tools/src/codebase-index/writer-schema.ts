export const METADATA_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

export const CORE_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS files (
    file TEXT PRIMARY KEY,
    lang TEXT NOT NULL,
    mtime_ms INTEGER NOT NULL,
    -- Phase 2: xxHash64 of the file's UTF-8 bytes. Empty string when the
    -- indexer hasn't populated it yet (legacy rows, schema repaired by
    -- repairMissingColumns). Compared on incremental re-index so that a
    -- touch or branch-switch that leaves content byte-identical skips the
    -- expensive parse phase entirely (refactoring proposal Phase 2).
    content_hash TEXT NOT NULL DEFAULT '',
    symbol_count INTEGER NOT NULL DEFAULT 0,
    last_indexed INTEGER NOT NULL,
    -- Code Atlas grouping label, computed at index time from the ecosystem's
    -- own manifests (package.json, go.mod, Cargo.toml, …). Stored rather than
    -- re-derived per query because the evidence lives on disk, not in the DB.
    package TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS symbols (
    id INTEGER PRIMARY KEY,
    lang TEXT NOT NULL,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    file TEXT NOT NULL,
    line INTEGER NOT NULL,
    col INTEGER NOT NULL,
    signature TEXT NOT NULL DEFAULT '',
    doc_comment TEXT NOT NULL DEFAULT '',
    scope TEXT NOT NULL DEFAULT ''
    );
`;

export const FILE_INDEX_SQL = [
  'CREATE INDEX IF NOT EXISTS idx_f_package ON files(package)',
] as const;

export const SYMBOL_INDEX_SQL = [
  'CREATE INDEX IF NOT EXISTS idx_s_name ON symbols(name)',
  'CREATE INDEX IF NOT EXISTS idx_s_kind ON symbols(kind)',
  'CREATE INDEX IF NOT EXISTS idx_s_lang ON symbols(lang)',
  'CREATE INDEX IF NOT EXISTS idx_s_file ON symbols(file)',
  'CREATE INDEX IF NOT EXISTS idx_s_lang_kind ON symbols(lang, kind)',
  'CREATE INDEX IF NOT EXISTS idx_s_name_id ON symbols(name, id)',
] as const;

export const REFS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS refs (
    id INTEGER PRIMARY KEY,
    from_id INTEGER NOT NULL,
    to_name TEXT NOT NULL,
    to_id INTEGER,
    call_type TEXT NOT NULL,
    line INTEGER NOT NULL,
    lang TEXT NOT NULL DEFAULT '',
    module TEXT,
    to_file TEXT
  );
`;

export const REFS_INDEX_SQL = [
  'CREATE INDEX IF NOT EXISTS idx_r_from ON refs(from_id)',
  'CREATE INDEX IF NOT EXISTS idx_r_to_id ON refs(to_id)',
  'CREATE INDEX IF NOT EXISTS idx_r_to_name ON refs(to_name)',
  'CREATE INDEX IF NOT EXISTS idx_r_call_type ON refs(call_type)',
  // Name resolution matches (to_name, lang) pairs; the composite keeps the
  // language-scoped UPDATE from degrading into a scan of every same-named row.
  'CREATE INDEX IF NOT EXISTS idx_r_to_name_lang ON refs(to_name, lang)',
  // The post-index module resolution pass groups unresolved import refs by
  // (module, lang); graph readers then read to_file back.
  'CREATE INDEX IF NOT EXISTS idx_r_module ON refs(module)',
  'CREATE INDEX IF NOT EXISTS idx_r_to_file ON refs(to_file)',
] as const;

/**
 * Static `lang → family` mirror of {@link LANG_FAMILY_ENTRIES}, so ref
 * resolution can scope a match to one language family with a join rather than
 * binding a per-family IN-list into every statement.
 *
 * Row `('', '*')` is the wildcard for refs written without a language (older
 * rows, and tests that construct refs by hand): they keep resolving globally.
 */
export const LANG_FAMILY_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS lang_family (
    lang TEXT PRIMARY KEY,
    family TEXT NOT NULL
  );
`;

/** Family value that matches every symbol family, used by language-less refs. */
export const LANG_FAMILY_WILDCARD = '*';

export const SYMBOLS_FTS_SQL =
  "CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(text, tokenize = 'trigram')";

/**
 * Phase 3: stores 384-dimensional float32 embedding vectors for each symbol.
 * Vectors are computed from the symbol's indexable text (name + signature +
 * doc_comment) via the character n-gram hashing embedding in vector-search.ts.
 * One row per symbol, kept in sync via insertSymbols, delete, and clearAll.
 */
export const SYMBOL_VECTORS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS symbol_vectors (
    symbol_id INTEGER PRIMARY KEY,
    vector BLOB NOT NULL,
    FOREIGN KEY (symbol_id) REFERENCES symbols(id) ON DELETE CASCADE
  );
`;
