import type { DatabaseSync } from 'node:sqlite';
import { normalizeTextKey } from './store-helpers.js';
import type { MemoryCandidate, Sage } from './types.js';
import { sageToLegacyScope } from './types.js';

export function upsertSqliteMemory(
  stmt: (sql: string) => ReturnType<DatabaseSync['prepare']>,
  m: Sage,
): void {
  stmt(
    `INSERT INTO memories
      (id, data, status, kind, scope, legacy_scope, importance, confidence, freshness, updated_at, created_at, audience, tags, owner_session_id, canonical_text)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      data = excluded.data,
      status = excluded.status,
      kind = excluded.kind,
      scope = excluded.scope,
      legacy_scope = excluded.legacy_scope,
      importance = excluded.importance,
      confidence = excluded.confidence,
      freshness = excluded.freshness,
      updated_at = excluded.updated_at,
      created_at = excluded.created_at,
      audience = excluded.audience,
      tags = excluded.tags,
      owner_session_id = excluded.owner_session_id,
      canonical_text = excluded.canonical_text`,
  ).run(
    m.id,
    JSON.stringify(m),
    m.status,
    m.kind,
    m.scope,
    m.legacyScope ?? sageToLegacyScope(m.scope),
    m.importance,
    m.confidence,
    m.freshness,
    m.updatedAt,
    m.createdAt,
    m.audience ? JSON.stringify(m.audience) : null,
    JSON.stringify(m.tags),
    m.ownerSessionId ?? null,
    normalizeTextKey(m.text),
  );
}

export function upsertSqliteCandidate(
  stmt: (sql: string) => ReturnType<DatabaseSync['prepare']>,
  candidate: MemoryCandidate,
  canonicalText?: string,
): void {
  stmt(
    `INSERT OR REPLACE INTO candidates
      (id, data, status, created_at, updated_at, canonical_text)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    candidate.id,
    JSON.stringify(candidate),
    candidate.status,
    candidate.createdAt,
    candidate.updatedAt,
    canonicalText ?? normalizeTextKey(candidate.text),
  );
}
