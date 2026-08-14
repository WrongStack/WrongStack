/**
 * TechStack — SQLite schema (DDL) and migration helpers.
 *
 * Defines the tables for snapshots, jobs, and the delivery outbox.
 * Uses `node:sqlite` (built-in since Node 22.5+).
 *
 * Tables:
 *   - snapshots:     persisted inventory snapshots
 *   - jobs:          async inventory/analyze job state
 *   - outbox:        idle-delivery tracking
 *
 * @see docs/specs/techstack-sdd.md §3.2, §4.1
 */

export const SCHEMA_VERSION = 1;

export const DDL = `
CREATE TABLE IF NOT EXISTS techstack_schema_version (
  version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  target_root TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  raw_json TEXT NOT NULL,
  adapter_version TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_snapshots_project_id ON snapshots(project_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_created_at ON snapshots(created_at DESC);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  target_root TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('inventory', 'analyze')),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK(status IN ('queued','discovering','inventorying','enriching','researching','synthesizing','completed','failed','cancelled')),
  fingerprint TEXT NOT NULL DEFAULT '',
  requested_by TEXT NOT NULL DEFAULT '',
  session_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  error TEXT,
  progress_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_jobs_project_id ON jobs(project_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);

CREATE TABLE IF NOT EXISTS outbox (
  delivery_id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending', 'claimed', 'delivered', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  claimed_at TEXT,
  delivered_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox(status);

CREATE TABLE IF NOT EXISTS research_cache (
  cache_key TEXT PRIMARY KEY,
  findings_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_research_cache_expires_at ON research_cache(expires_at);
`;

/**
 * Run the schema DDL and check/migrate version.
 */
export function applySchema(db: import('node:sqlite').DatabaseSync): void {
  // Execute DDL (IF NOT EXISTS makes it idempotent)
  for (const statement of DDL.split(';')) {
    const trimmed = statement.trim();
    if (trimmed) {
      db.exec(trimmed);
    }
  }

  // Check version
  const row = db.prepare('SELECT version FROM techstack_schema_version').get() as
    | { version: number }
    | undefined;

  if (!row) {
    db.prepare('INSERT INTO techstack_schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
  } else if (row.version < SCHEMA_VERSION) {
    // Future: run migrations here
    db.prepare('UPDATE techstack_schema_version SET version = ?').run(SCHEMA_VERSION);
  }
}
