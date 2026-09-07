/**
 * Persistence for the concept layer (`file_concepts`, `subsystems`,
 * `concept_edges`).
 *
 * Unlike the rank tables, these are written incrementally: a summary costs a
 * model call, so the runner checkpoints as it goes and a cancelled or crashed
 * pass must not throw away what it already paid for.
 */

import type { DatabaseSync } from 'node:sqlite';
import { ladderChunkSizes } from './writer-helpers.js';

type Statement = ReturnType<DatabaseSync['prepare']>;
type PrepareStatement = (sql: string) => Statement;

/**
 * Whether a stored summary describes the file's current bytes.
 *
 * `stale` is kept rather than deleted: an outdated description of a file is
 * still a better starting point than nothing, both for a reader and as a hint
 * to the model on the next pass.
 */
export type ConceptState = 'ready' | 'stale' | 'pending';

export interface FileConcept {
  file: string;
  contentHash: string;
  summary: string;
  /** 1-based inclusive line span of the file's load-bearing lines. */
  cruxStart: number | null;
  cruxEnd: number | null;
  state: ConceptState;
  model: string;
  updatedAt: number;
}

export interface Subsystem {
  id: string;
  name: string;
  summary: string;
  memberFiles: string[];
  model: string;
  updatedAt: number;
}

/**
 * Closed vocabulary for concept-to-concept relations.
 *
 * Closed on purpose. An open-ended verb list produces a graph where
 * `configures`, `sets up` and `initialises` are three different edges between
 * the same pair, which nothing downstream can group or filter on.
 */
export const CONCEPT_RELATIONS = [
  'uses',
  'configures',
  'validates',
  'extends',
  'persists',
  'observes',
] as const;
export type ConceptRelation = (typeof CONCEPT_RELATIONS)[number];

export function isConceptRelation(value: string): value is ConceptRelation {
  return (CONCEPT_RELATIONS as readonly string[]).includes(value);
}

export interface ConceptEdge {
  fromId: string;
  toId: string;
  relation: ConceptRelation;
}

interface ConceptRow {
  file: string;
  contentHash: string;
  summary: string;
  cruxStart: number | null;
  cruxEnd: number | null;
  state: string;
  model: string;
  updatedAt: number;
}

const SELECT_CONCEPT =
  'SELECT file, content_hash AS contentHash, summary, crux_start AS cruxStart, ' +
  'crux_end AS cruxEnd, state, model, updated_at AS updatedAt FROM file_concepts';

function toConcept(row: ConceptRow): FileConcept {
  return {
    file: row.file,
    contentHash: row.contentHash,
    summary: row.summary,
    cruxStart: row.cruxStart,
    cruxEnd: row.cruxEnd,
    state: (row.state === 'ready' || row.state === 'stale' ? row.state : 'pending') as ConceptState,
    model: row.model,
    updatedAt: row.updatedAt,
  };
}

/** Write (or replace) one file's concept. */
export function upsertFileConceptWithStatement(stmt: PrepareStatement, concept: FileConcept): void {
  stmt(
    `INSERT INTO file_concepts(file, content_hash, summary, crux_start, crux_end, state, model, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(file) DO UPDATE SET
       content_hash = excluded.content_hash,
       summary = excluded.summary,
       crux_start = excluded.crux_start,
       crux_end = excluded.crux_end,
       state = excluded.state,
       model = excluded.model,
       updated_at = excluded.updated_at`,
  ).run(
    concept.file,
    concept.contentHash,
    concept.summary,
    concept.cruxStart,
    concept.cruxEnd,
    concept.state,
    concept.model,
    concept.updatedAt,
  );
}

export function getFileConceptWithStatement(
  stmt: PrepareStatement,
  file: string,
): FileConcept | undefined {
  const row = stmt(`${SELECT_CONCEPT} WHERE file = ?`).get(file) as unknown as
    | ConceptRow
    | undefined;
  return row === undefined ? undefined : toConcept(row);
}

/** All concepts, for whole-index consumers (atlas, embeddings, injection). */
export function getAllFileConceptsWithStatement(stmt: PrepareStatement): FileConcept[] {
  return (stmt(SELECT_CONCEPT).all() as unknown as ConceptRow[]).map(toConcept);
}

/** `file → summary` for the files that currently have a usable description. */
export function getReadyConceptSummariesWithStatement(stmt: PrepareStatement): Map<string, string> {
  const rows = stmt(
    "SELECT file, summary FROM file_concepts WHERE state = 'ready' AND summary <> ''",
  ).all() as Array<{ file: string; summary: string }>;
  const map = new Map<string, string>();
  for (const row of rows) map.set(row.file, row.summary);
  return map;
}

export interface ConceptCoverage {
  ready: number;
  stale: number;
  pending: number;
  subsystems: number;
}

export function getConceptCoverageWithStatement(stmt: PrepareStatement): ConceptCoverage {
  const rows = stmt(
    'SELECT state, COUNT(*) AS n FROM file_concepts GROUP BY state',
  ).all() as Array<{
    state: string;
    n: number;
  }>;
  const coverage: ConceptCoverage = { ready: 0, stale: 0, pending: 0, subsystems: 0 };
  for (const row of rows) {
    if (row.state === 'ready') coverage.ready = row.n;
    else if (row.state === 'stale') coverage.stale = row.n;
    else coverage.pending += row.n;
  }
  coverage.subsystems = Number(
    (stmt('SELECT COUNT(*) AS n FROM subsystems').get() as { n?: number } | undefined)?.n ?? 0,
  );
  return coverage;
}

/**
 * Mark every concept whose recorded hash no longer matches the indexed file as
 * `stale`, in one statement.
 *
 * Run before a pass rather than during indexing: the indexer's atomic write is
 * not the place to reason about a layer it does not own, and a summary that is
 * one generation behind harms nothing until someone asks for it.
 */
export function markStaleConceptsWithStatement(stmt: PrepareStatement): number {
  const result = stmt(
    `UPDATE file_concepts SET state = 'stale'
     WHERE state = 'ready'
       AND content_hash <> ''
       AND content_hash <> COALESCE((SELECT f.content_hash FROM files f WHERE f.file = file_concepts.file), content_hash)`,
  ).run();
  return Number(result.changes ?? 0);
}

/** Drop concepts for files that are no longer indexed. */
export function pruneOrphanConceptsWithStatement(stmt: PrepareStatement): number {
  const result = stmt('DELETE FROM file_concepts WHERE file NOT IN (SELECT file FROM files)').run();
  return Number(result.changes ?? 0);
}

/** Replace the whole subsystem layer. Subsystems are derived as a set. */
export function replaceSubsystemsWithStatement(
  stmt: PrepareStatement,
  maxSqlVars: number,
  subsystems: readonly Subsystem[],
  edges: readonly ConceptEdge[],
): void {
  stmt('DELETE FROM subsystems').run();
  stmt('DELETE FROM concept_edges').run();
  if (subsystems.length > 0) {
    const insert = stmt(
      `INSERT INTO subsystems(id, name, summary, member_files, model, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const subsystem of subsystems) {
      insert.run(
        subsystem.id,
        subsystem.name,
        subsystem.summary,
        JSON.stringify(subsystem.memberFiles),
        subsystem.model,
        subsystem.updatedAt,
      );
    }
  }
  if (edges.length === 0) return;
  const ladder = ladderChunkSizes(edges.length, Math.max(1, Math.floor(maxSqlVars / 3)));
  let cursor = 0;
  for (const take of ladder) {
    const chunk = edges.slice(cursor, cursor + take);
    cursor += take;
    const placeholders = chunk.map(() => '(?, ?, ?)').join(', ');
    stmt(
      `INSERT OR IGNORE INTO concept_edges(from_id, to_id, relation) VALUES ${placeholders}`,
    ).run(...chunk.flatMap((edge) => [edge.fromId, edge.toId, edge.relation]));
  }
}

export function getSubsystemsWithStatement(stmt: PrepareStatement): Subsystem[] {
  const rows = stmt(
    'SELECT id, name, summary, member_files AS memberFiles, model, updated_at AS updatedAt FROM subsystems ORDER BY id ASC',
  ).all() as Array<{
    id: string;
    name: string;
    summary: string;
    memberFiles: string;
    model: string;
    updatedAt: number;
  }>;
  return rows.map((row) => {
    let memberFiles: string[] = [];
    try {
      const parsed: unknown = JSON.parse(row.memberFiles);
      if (Array.isArray(parsed))
        memberFiles = parsed.filter((f): f is string => typeof f === 'string');
    } catch {
      // A corrupted member list degrades to an empty one rather than throwing:
      // the summary is still worth showing.
    }
    return { ...row, memberFiles };
  });
}

export function getConceptEdgesWithStatement(stmt: PrepareStatement): ConceptEdge[] {
  return (
    stmt(
      'SELECT from_id AS fromId, to_id AS toId, relation FROM concept_edges ORDER BY from_id, to_id, relation',
    ).all() as Array<{ fromId: string; toId: string; relation: string }>
  ).flatMap((row) =>
    isConceptRelation(row.relation)
      ? [{ fromId: row.fromId, toId: row.toId, relation: row.relation }]
      : [],
  );
}
