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
 * Graph centrality, computed at index time by `graph-rank.ts` once every ref
 * has its final `to_id` / `to_file`. Two tables rather than columns on
 * `symbols` / `files` so the whole layer is additive: an index written by an
 * older build simply has empty rank tables, and `SCHEMA_VERSION` stays put
 * (a bump drops and rebuilds the entire index — see `initIndexSchema`).
 *
 * `rank` is max-normalised to 1.0 across the run, so scores are comparable
 * within one index but never across two.
 */
export const RANK_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS symbol_rank (
    symbol_id INTEGER PRIMARY KEY,
    rank REAL NOT NULL,
    in_deg INTEGER NOT NULL DEFAULT 0,
    out_deg INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS file_rank (
    file TEXT PRIMARY KEY,
    rank REAL NOT NULL,
    in_deg INTEGER NOT NULL DEFAULT 0,
    out_deg INTEGER NOT NULL DEFAULT 0
  );
`;

export const RANK_INDEX_SQL = [
  // Both tables are read "top N by rank" far more often than by key.
  'CREATE INDEX IF NOT EXISTS idx_sr_rank ON symbol_rank(rank DESC)',
  'CREATE INDEX IF NOT EXISTS idx_fr_rank ON file_rank(rank DESC)',
] as const;

/**
 * Concept layer — plain-English descriptions of what code is *for*, which the
 * structural index cannot express. Symbol names and signatures answer "what is
 * declared"; they cannot answer "where do we back off after a 429".
 *
 * Populated by an optional, explicitly enabled LLM pass. Additive like the rank
 * tables: an index without the pass simply has empty concept tables, and every
 * consumer treats a missing summary as "not described yet" rather than an error.
 *
 * `content_hash` mirrors `files.content_hash`, and is the cache key that keeps
 * the pass affordable — a file whose bytes have not changed is never re-sent to
 * a model. `state` distinguishes a summary that matches the current bytes
 * (`ready`) from one describing an older version (`stale`, still useful as a
 * hint) and one not yet produced (`pending`).
 *
 * `crux_start`/`crux_end` point at the few lines that actually carry the file's
 * meaning. A summary can drift from the truth; a pointer into the source cannot.
 */
export const CONCEPT_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS file_concepts (
    file TEXT PRIMARY KEY,
    content_hash TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '',
    crux_start INTEGER,
    crux_end INTEGER,
    state TEXT NOT NULL DEFAULT 'pending',
    model TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS subsystems (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    member_files TEXT NOT NULL DEFAULT '[]',
    model TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS concept_edges (
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    relation TEXT NOT NULL,
    PRIMARY KEY (from_id, to_id, relation)
  );
`;

/**
 * Semantic embeddings, one per file.
 *
 * **Per file, not per symbol.** Embedding a bare signature — `function
 * resolve(id: string): Widget` — captures almost nothing a lexical index does
 * not already have. What carries meaning is the concept layer's description of
 * what the file is *for*, so that is what gets embedded. It is also eight
 * times cheaper on this repository: 8k files against 66k symbols.
 *
 * `source_hash` is a hash of the exact text that was embedded, so a changed
 * summary re-embeds and an unchanged one never does. `provider` records which
 * model produced the vector; vectors from a different model are not comparable,
 * so a provider change invalidates the whole table rather than silently mixing
 * two vector spaces.
 *
 * Separate from `symbol_vectors`, which stores the older synchronous
 * char-trigram vectors and stays behind its own gate.
 */
export const FILE_VECTORS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS file_vectors (
    file TEXT PRIMARY KEY,
    vector BLOB NOT NULL,
    source_hash TEXT NOT NULL DEFAULT '',
    provider TEXT NOT NULL DEFAULT ''
  );
`;

export const CONCEPT_INDEX_SQL = [
  // The enrichment runner's hot query is "which files still need work".
  'CREATE INDEX IF NOT EXISTS idx_fc_state ON file_concepts(state)',
  'CREATE INDEX IF NOT EXISTS idx_ce_from ON concept_edges(from_id)',
] as const;

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
