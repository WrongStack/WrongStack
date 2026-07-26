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
    symbol_count INTEGER NOT NULL DEFAULT 0,
    last_indexed INTEGER NOT NULL
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
    scope TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL DEFAULT '',
    file_fk TEXT NOT NULL
  );
`;

export const SYMBOL_INDEX_SQL = [
  'CREATE INDEX IF NOT EXISTS idx_s_name ON symbols(name)',
  'CREATE INDEX IF NOT EXISTS idx_s_kind ON symbols(kind)',
  'CREATE INDEX IF NOT EXISTS idx_s_lang ON symbols(lang)',
  'CREATE INDEX IF NOT EXISTS idx_s_file ON symbols(file)',
  'CREATE INDEX IF NOT EXISTS idx_s_lang_kind ON symbols(lang, kind)',
  'CREATE INDEX IF NOT EXISTS idx_s_file_fk ON symbols(file_fk)',
  'CREATE INDEX IF NOT EXISTS idx_s_name_id ON symbols(name, id)',
] as const;

export const REFS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS refs (
    id INTEGER PRIMARY KEY,
    from_id INTEGER NOT NULL,
    to_name TEXT NOT NULL,
    to_id INTEGER,
    call_type TEXT NOT NULL,
    line INTEGER NOT NULL
  );
`;

export const REFS_INDEX_SQL = [
  'CREATE INDEX IF NOT EXISTS idx_r_from ON refs(from_id)',
  'CREATE INDEX IF NOT EXISTS idx_r_to_id ON refs(to_id)',
  'CREATE INDEX IF NOT EXISTS idx_r_to_name ON refs(to_name)',
  'CREATE INDEX IF NOT EXISTS idx_r_call_type ON refs(call_type)',
] as const;

export const SYMBOLS_FTS_SQL =
  "CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(text, tokenize = 'unicode61')";
