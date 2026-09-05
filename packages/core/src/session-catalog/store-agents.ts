import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { SessionEvent } from '../types/session.js';
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
      `INSERT INTO session_agent_index(session_id,transcript_size,transcript_mtime_ms,derived_at)
       VALUES (?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET transcript_size=excluded.transcript_size,transcript_mtime_ms=excluded.transcript_mtime_ms,derived_at=excluded.derived_at`,
    ).run(sessionId, size, mtimeMs, new Date().toISOString());
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

  const cached = db
    .prepare(
      'SELECT transcript_size, transcript_mtime_ms FROM session_agent_index WHERE session_id=?',
    )
    .get(sessionId) as { transcript_size: number; transcript_mtime_ms: number } | undefined;
  if (
    cached &&
    Number(cached.transcript_size) === stat.size &&
    Number(cached.transcript_mtime_ms) === stat.mtimeMs
  ) {
    return readSessionAgentRows(db, sessionId);
  }

  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
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
  writeSessionAgentRows(db, sessionId, derived, stat.size, stat.mtimeMs, transaction);
  return derived;
}
