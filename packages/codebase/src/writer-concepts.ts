/**
 * Persistence for the concept layer (`file_concepts`, `subsystems`,
 * `concept_edges`).
 *
 * Unlike the rank tables, these are written incrementally: a summary costs a
 * model call, so the runner checkpoints as it goes and a cancelled or crashed
 * pass must not throw away what it already paid for.
 */

import type { DatabaseSync } from 'node:sqlite';
import { computeFileStructuralFingerprintWithStatement } from './fingerprint.js';
import type { SymbolKind } from './schema.js';
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
  /** Structural fingerprint of the file's symbols and outgoing refs. */
  signatureHash?: string | undefined;
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

const CONCEPT_RELATION_SYNONYMS: Readonly<Record<string, ConceptRelation>> = {
  uses: 'uses',
  depends_on: 'uses',
  calls: 'uses',
  imports: 'uses',
  invokes: 'uses',
  consumes: 'uses',
  configures: 'configures',
  wires: 'configures',
  provides: 'configures',
  validates: 'validates',
  verifies: 'validates',
  checks: 'validates',
  asserts: 'validates',
  tests: 'validates',
  tested_by: 'validates',
  extends: 'extends',
  inherits: 'extends',
  implements: 'extends',
  subclasses: 'extends',
  persists: 'persists',
  stores: 'persists',
  queries: 'persists',
  migrates: 'persists',
  reads_from: 'persists',
  writes_to: 'persists',
  observes: 'observes',
  monitors: 'observes',
  traces: 'observes',
  logs: 'observes',
};

/**
 * Normalize common LLM relation synonyms (`depends_on`, `calls`, `queries`,
 * `implements`, `monitors`, etc.) into the canonical {@link ConceptRelation}
 * vocabulary, or return `null` when unknown.
 */
export function normalizeConceptRelation(value: string): ConceptRelation | null {
  const key = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  return CONCEPT_RELATION_SYNONYMS[key] ?? null;
}

const SYMBOL_KIND_ALIASES: ReadonlyMap<string, SymbolKind> = new Map<string, SymbolKind>([
  ['function', 'function'],
  ['fn', 'function'],
  ['func', 'function'],
  ['def', 'function'],
  ['hook', 'function'],
  ['component', 'function'],
  ['route', 'function'],
  ['endpoint', 'function'],
  ['handler', 'function'],
  ['controller', 'function'],
  ['middleware', 'function'],
  ['task', 'function'],
  ['job', 'function'],
  ['pipeline', 'function'],
  ['method', 'method'],
  ['constructor', 'method'],
  ['getter', 'method'],
  ['setter', 'method'],
  ['class', 'class'],
  ['service', 'class'],
  ['entity', 'class'],
  ['model', 'class'],
  ['repository', 'class'],
  ['store', 'class'],
  ['table', 'class'],
  ['resource', 'class'],
  ['deployment', 'class'],
  ['container', 'class'],
  ['interface', 'interface'],
  ['protocol', 'interface'],
  ['trait', 'interface'],
  ['contract', 'interface'],
  ['type', 'type'],
  ['struct', 'type'],
  ['record', 'type'],
  ['dto', 'type'],
  ['schema', 'type'],
  ['union', 'type'],
  ['alias', 'type'],
  ['enum', 'enum'],
  ['const', 'const'],
  ['constant', 'const'],
  ['env', 'const'],
  ['config', 'const'],
  ['variable', 'var'],
  ['var', 'var'],
  ['let', 'let'],
  ['property', 'property'],
  ['field', 'property'],
  ['column', 'property'],
  ['output', 'property'],
  ['namespace', 'namespace'],
  ['module', 'namespace'],
  ['package', 'namespace'],
  ['cluster', 'namespace'],
  ['layer', 'namespace'],
  ['domain', 'namespace'],
  ['stage', 'namespace'],
]);

/**
 * Normalize open-ended LLM or polyglot node kind labels (`hook`, `component`,
 * `endpoint`, `service`, `table`, `dto`, `trait`, `cluster`, etc.) into the
 * canonical {@link SymbolKind} vocabulary.
 */
export function normalizeSymbolKindAlias(value: string): SymbolKind | null {
  const key = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  return SYMBOL_KIND_ALIASES.get(key) ?? null;
}

/**
 * Normalize test-to-production concept edges so a test subsystem always points
 * to the production subsystem it covers with the canonical `'validates'`
 * relation (fixing inverted `prod -> test` edges emitted by LLMs).
 */
export function normalizeTestConceptEdge(
  edge: ConceptEdge,
  isTestSubsystem: (id: string) => boolean,
): ConceptEdge {
  const fromIsTest = isTestSubsystem(edge.fromId);
  const toIsTest = isTestSubsystem(edge.toId);
  if (!fromIsTest && toIsTest) {
    return {
      fromId: edge.toId,
      toId: edge.fromId,
      relation: 'validates',
    };
  }
  if (fromIsTest && !toIsTest && edge.relation === 'uses') {
    return {
      fromId: edge.fromId,
      toId: edge.toId,
      relation: 'validates',
    };
  }
  return edge;
}

export interface ConceptEdge {
  fromId: string;
  toId: string;
  relation: ConceptRelation;
}

interface ConceptRow {
  file: string;
  contentHash: string;
  signatureHash: string;
  summary: string;
  cruxStart: number | null;
  cruxEnd: number | null;
  state: string;
  model: string;
  updatedAt: number;
}

const SELECT_CONCEPT =
  'SELECT file, content_hash AS contentHash, signature_hash AS signatureHash, summary, crux_start AS cruxStart, ' +
  'crux_end AS cruxEnd, state, model, updated_at AS updatedAt FROM file_concepts';

function toConcept(row: ConceptRow): FileConcept {
  return {
    file: row.file,
    contentHash: row.contentHash,
    signatureHash: row.signatureHash ?? '',
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
    `INSERT INTO file_concepts(file, content_hash, signature_hash, summary, crux_start, crux_end, state, model, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(file) DO UPDATE SET
       content_hash = excluded.content_hash,
       signature_hash = excluded.signature_hash,
       summary = excluded.summary,
       crux_start = excluded.crux_start,
       crux_end = excluded.crux_end,
       state = excluded.state,
       model = excluded.model,
       updated_at = excluded.updated_at`,
  ).run(
    concept.file,
    concept.contentHash,
    concept.signatureHash ?? '',
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
  const drifted = stmt(
    `SELECT fc.file AS file, fc.signature_hash AS signatureHash, f.content_hash AS currentContentHash
     FROM file_concepts fc
     JOIN files f ON f.file = fc.file
     WHERE fc.state = 'ready'
       AND fc.content_hash <> ''
       AND fc.content_hash <> f.content_hash`,
  ).all() as Array<{
    file: string;
    signatureHash: string;
    currentContentHash: string;
  }>;

  if (drifted.length === 0) return 0;

  let staleCount = 0;
  const updateCosmetic = stmt('UPDATE file_concepts SET content_hash = ? WHERE file = ?');
  const markStale = stmt("UPDATE file_concepts SET state = 'stale' WHERE file = ?");

  for (const row of drifted) {
    if (row.signatureHash !== '') {
      const currentSig = computeFileStructuralFingerprintWithStatement(stmt, row.file);
      if (currentSig !== '' && currentSig === row.signatureHash) {
        updateCosmetic.run(row.currentContentHash, row.file);
        continue;
      }
    }
    markStale.run(row.file);
    staleCount++;
  }
  return staleCount;
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
