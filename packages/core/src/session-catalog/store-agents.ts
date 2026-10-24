import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { gunzipSync } from 'node:zlib';
import type { SessionEvent } from '@wrongstack/contracts/types/session';
import { deriveSessionAgents, type SessionAgentRecord } from './session-agents.js';
import { assertId, parseJson, type SessionAgentRow } from './store-schema.js';

export function readSessionAgentRows(db: DatabaseSync, sessionId: string): SessionAgentRecord[] {
  const rows = db
    .prepare('SELECT * FROM session_agents WHERE session_id=? ORDER BY ordinal ASC')
    .all(sessionId) as unknown as SessionAgentRow[];
  return rows.map((row) => ({
    agentId: row.agent_id,
    ...(row.role !== null ? { role: row.role } : {}),
    ...(row.provider !== null ? { provider: row.provider } : {}),
    ...(row.model !== null ? { model: row.model } : {}),
    ...(row.agent_session_id !== null ? { agentSessionId: row.agent_session_id } : {}),
    ...(row.transcript_path !== null ? { transcriptPath: row.transcript_path } : {}),
    ...(row.parent_agent_id !== null ? { parentAgentId: row.parent_agent_id } : {}),
    ...(row.spawned_at !== null ? { spawnedAt: row.spawned_at } : {}),
    ...(row.ended_at !== null ? { endedAt: row.ended_at } : {}),
    status: row.status as SessionAgentRecord['status'],
    ...(row.error !== null ? { error: row.error } : {}),
    interleavedEventCount: Number(row.interleaved_event_count),
    ...(row.usage_json !== null
      ? { usage: parseJson<SessionAgentRecord['usage']>(row.usage_json) }
      : {}),
  }));
}

export function writeSessionAgentRows(
  db: DatabaseSync,
  sessionId: string,
  records: readonly SessionAgentRecord[],
  size: number,
  mtimeMs: number,
  contentHash: string,
  transaction: <T>(run: () => T) => T,
): void {
  transaction(() => {
    // Full replace, not upsert: an agent can only disappear from the roster
    // if the journal was rewritten (rewind, repair, clear), and in that case
    // a leftover row would be a ghost nothing ever deletes.
    db.prepare('DELETE FROM session_agents WHERE session_id=?').run(sessionId);
    const insert = db.prepare(
      `INSERT INTO session_agents(session_id,agent_id,role,provider,model,agent_session_id,transcript_path,parent_agent_id,spawned_at,ended_at,status,error,interleaved_event_count,usage_json,ordinal)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    records.forEach((record, ordinal) => {
      insert.run(
        sessionId,
        record.agentId,
        record.role ?? null,
        record.provider ?? null,
        record.model ?? null,
        record.agentSessionId ?? null,
        record.transcriptPath ?? null,
        record.parentAgentId ?? null,
        record.spawnedAt ?? null,
        record.endedAt ?? null,
        record.status,
        record.error ?? null,
        record.interleavedEventCount,
        record.usage ? JSON.stringify(record.usage) : null,
        ordinal,
      );
    });
    db.prepare(
      `INSERT INTO session_agent_index(session_id,transcript_size,transcript_mtime_ms,transcript_content_hash,derived_at)
       VALUES (?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET transcript_size=excluded.transcript_size,transcript_mtime_ms=excluded.transcript_mtime_ms,transcript_content_hash=excluded.transcript_content_hash,derived_at=excluded.derived_at`,
    ).run(sessionId, size, mtimeMs, contentHash, new Date().toISOString());
  });
}

export function getSessionAgentsList(
  db: DatabaseSync,
  sessionsDir: string,
  sessionId: string,
  getTranscriptRelativePath: (sessionId: string) => string | undefined,
  transaction: <T>(run: () => T) => T,
): SessionAgentRecord[] {
  assertId(sessionId);
  const transcriptRel = getTranscriptRelativePath(sessionId);
  if (!transcriptRel) return [];
  const file = path.join(sessionsDir, transcriptRel);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return [];
  }

  // Read the bytes ONCE: a memo hit still has to hash them to know the file is
  // unchanged, and a miss needs them to derive. Hashing the RAW bytes (not the
  // inflated text) keeps the memo key a property of the file on disk, so hot
  // and gzip transcripts are handled identically.
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(file);
  } catch {
    return [];
  }
  const contentHash = createHash('sha256').update(bytes).digest('hex');

  // Size + mtime alone cannot prove the journal is unchanged: an in-place
  // rewrite to the SAME byte length (`1.2.3` -> `1.2.4`, a rewind/repair/clear)
  // with an mtime that did not advance — coarse timestamp granularity, or a
  // rewrite inside the same tick — is invisible to a stat. That served a stale
  // roster for a journal the projection is supposed to follow exactly, so the
  // content hash is the actual arbiter and the stat pair is only a fast path.
  const cached = db
    .prepare(
      'SELECT transcript_size, transcript_mtime_ms, transcript_content_hash FROM session_agent_index WHERE session_id=?',
    )
    .get(sessionId) as
    | {
        transcript_size: number;
        transcript_mtime_ms: number;
        transcript_content_hash: string | null;
      }
    | undefined;
  if (
    cached &&
    Number(cached.transcript_size) === stat.size &&
    Number(cached.transcript_mtime_ms) === stat.mtimeMs &&
    cached.transcript_content_hash === contentHash
  ) {
    return readSessionAgentRows(db, sessionId);
  }

  let raw: string;
  try {
    // Cold sessions archive their transcript as gzip (*.jsonl.gz, written by
    // session-archive.ts and registered by upsertSummary's cold path). Reading
    // those bytes as utf8 text makes every line fail JSON.parse, which derived
    // an EMPTY roster and cached it — archived sessions reported "no agents"
    // forever. Inflate gzip transcripts before parsing; hot .jsonl files are
    // unaffected.
    raw = (transcriptRel.endsWith('.jsonl.gz') ? gunzipSync(bytes) : bytes).toString('utf8');
  } catch {
    return [];
  }
  const events: SessionEvent[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as SessionEvent);
    } catch {
      // A torn trailing line is normal on a live journal — skip it. The
      // next call re-derives anyway, because mtime will have moved.
    }
  }
  const derived = deriveSessionAgents(events);
  writeSessionAgentRows(db, sessionId, derived, stat.size, stat.mtimeMs, contentHash, transaction);
  return derived;
}
