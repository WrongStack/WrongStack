/**
 * SQLite read path for Chronicle (phase 3 of `chronicle-sqlite-journal-v1`).
 *
 * The division of labour is the whole point of this file:
 *
 * - **SQL narrows.** Indexed columns turn "parse every line of every partition
 *   that overlaps the range" into an index seek. Only predicates that map
 *   cleanly onto a column are pushed down.
 * - **JavaScript decides.** The pushed-down predicate is a deliberate
 *   *superset*: every candidate row is parsed and then passed through the same
 *   `matches()` the JSONL engine uses. Nothing is filtered out by SQL that
 *   `matches()` would have kept.
 *
 * That split is what makes parity provable rather than hoped for. A SQL
 * re-expression of `ChronicleQuery` would have to restate tag/attribute
 * lookups, path normalisation and line-range containment, and each restatement
 * is a place where the two engines could silently disagree. Here they cannot
 * disagree about *which* events match — only about how fast the candidates are
 * found.
 *
 * The summary is built with the JSONL engine's own accumulator for the same
 * reason: family classification, `usage.*` paths, cost de-duplication and the
 * p95 are semantics, not arithmetic.
 */
import type { DatabaseSync } from 'node:sqlite';
import { decodeChroniclePayload, type StoredChroniclePayload } from './payload-codec.js';
import {
  type ChronicleFacet,
  type ChronicleFacetResults,
  type ChronicleFacetValue,
  type ChronicleGraphEdge,
  type ChronicleGraphResult,
  type ChronicleQuery,
  type ChronicleQueryResult,
  compareEvents,
  createSummaryAccumulator,
  facetValue,
  finalizeSummary,
  matches,
  relationKeys,
  updateSummary,
} from './query.js';
import type { ChronicleEvent } from './types.js';

/** Hard ceiling mirroring `ChronicleQueryEngine.query`. */
const MAX_LIMIT = 10_000;

/**
 * Keyset position in the `(day, sequence)` total order.
 *
 * Deliberately not interchangeable with the JSONL engine's cursor, which
 * encodes a snapshot of partition files. A cursor is opaque and belongs to the
 * engine that issued it; carrying one across would be meaningless.
 */
interface SqliteCursor {
  day: string;
  sequence: number;
}

function encodeCursor(cursor: SqliteCursor): string {
  return Buffer.from(`${cursor.day}:${cursor.sequence}`, 'utf8').toString('base64url');
}

function decodeCursor(raw: string | undefined): SqliteCursor | undefined {
  if (!raw) return undefined;
  try {
    const [day, sequence] = Buffer.from(raw, 'base64url').toString('utf8').split(':');
    if (!day || sequence === undefined) return undefined;
    const parsed = Number(sequence);
    return Number.isSafeInteger(parsed) ? { day, sequence: parsed } : undefined;
  } catch {
    return undefined;
  }
}

interface PushedDown {
  clause: string;
  params: (string | number)[];
}

/**
 * Translate the parts of a query that map onto indexed columns.
 *
 * Anything absent here is simply not narrowed — `matches()` still applies it.
 * Adding a predicate to this list is an optimization; forgetting one is not a
 * correctness bug. That asymmetry is intentional.
 */
function pushDown(query: ChronicleQuery): PushedDown {
  const clauses: string[] = [];
  const params: (string | number)[] = [];

  const eq = (column: string, value: string | undefined): void => {
    if (value === undefined) return;
    clauses.push(`${column} = ?`);
    params.push(value);
  };

  eq('event_id', query.eventId);
  eq('project_id', query.projectId);
  eq('session_id', query.sessionId);
  eq('agent_id', query.agentId);
  eq('task_id', query.taskId);
  eq('trace_id', query.traceId);
  eq('logical_request_id', query.logicalRequestId);
  eq('prompt_manifest_id', query.promptManifestId);
  eq('resource_kind', query.resourceKind);
  eq('resource_id', query.resourceId);

  if (query.eventTypes?.length) {
    clauses.push(`event_type IN (${query.eventTypes.map(() => '?').join(',')})`);
    params.push(...query.eventTypes);
  }
  if (query.outcomes?.length) {
    clauses.push(`outcome IN (${query.outcomes.map(() => '?').join(',')})`);
    params.push(...query.outcomes);
  }
  // `occurred_at` is an ISO-8601 UTC string, so lexicographic comparison is
  // chronological — the same assumption `matches()` makes.
  if (query.from) {
    clauses.push('occurred_at >= ?');
    params.push(query.from);
  }
  if (query.to) {
    clauses.push('occurred_at <= ?');
    params.push(query.to);
  }

  return { clause: clauses.length ? clauses.join(' AND ') : '1=1', params };
}

export interface ChronicleSqliteQueryEngineOptions {
  /** Rows pulled from SQLite per batch while streaming candidates. */
  batchSize?: number | undefined;
}

export class ChronicleSqliteQueryEngine {
  readonly diagnostics = { sourceFiles: 1, invalidLines: 0 };
  private readonly batchSize: number;

  constructor(
    private readonly db: DatabaseSync,
    options: ChronicleSqliteQueryEngineOptions = {},
  ) {
    this.batchSize = Math.max(1, options.batchSize ?? 1_000);
  }

  async query(query: ChronicleQuery = {}): Promise<ChronicleQueryResult> {
    const order = query.order ?? 'desc';
    const limit = Math.max(1, Math.min(query.limit ?? 100, MAX_LIMIT));
    const cursor = decodeCursor(query.cursor);
    const pushed = pushDown(query);

    const direction = order === 'asc' ? 'ASC' : 'DESC';
    const comparison = order === 'asc' ? '>' : '<';
    const keyset = cursor ? ` AND (day, sequence) ${comparison} (?, ?)` : '';
    const sql =
      `SELECT day, sequence, payload FROM events WHERE ${pushed.clause}${keyset}` +
      ` ORDER BY day ${direction}, sequence ${direction} LIMIT ? OFFSET ?`;

    const summary = createSummaryAccumulator();
    const page: ChronicleEvent[] = [];
    let total = 0;
    let scannedEvents = 0;
    let last: SqliteCursor | undefined;
    let offset = 0;

    // Every matching event feeds the summary, which is defined over the whole
    // result set rather than the page (see `ChronicleSummary`). Candidates are
    // streamed in batches so a wide query does not materialise the table.
    for (;;) {
      const params = [...pushed.params];
      if (cursor) params.push(cursor.day, cursor.sequence);
      params.push(this.batchSize, offset);
      const rows = this.db.prepare(sql).all(...params) as Array<{
        day: string;
        sequence: number;
        payload: StoredChroniclePayload;
      }>;
      if (rows.length === 0) break;
      offset += rows.length;

      for (const row of rows) {
        scannedEvents++;
        let event: ChronicleEvent;
        try {
          event = JSON.parse(decodeChroniclePayload(row.payload)) as ChronicleEvent;
        } catch {
          this.diagnostics.invalidLines++;
          continue;
        }
        if (!matches(event, query)) continue;
        total++;
        updateSummary(summary, event);
        if (page.length < limit) {
          page.push(event);
          last = { day: row.day, sequence: row.sequence };
        }
      }
      if (rows.length < this.batchSize) break;
    }

    // The JSONL engine returns the page in `compareEvents` order; keyset order
    // is `(day, sequence)`, which can differ when events share a timestamp.
    // Sorting here keeps both engines' pages identical.
    page.sort((left, right) => compareEvents(left, right) * (order === 'asc' ? 1 : -1));

    const result: ChronicleQueryResult = {
      events: page,
      total,
      scannedEvents,
      sourceFiles: this.diagnostics.sourceFiles,
      invalidLines: this.diagnostics.invalidLines,
      summary: finalizeSummary(summary),
    };
    if (total > page.length && last) {
      return { ...result, nextCursor: encodeCursor(last) };
    }
    return result;
  }

  /**
   * Value counts per facet field.
   *
   * Not a SQL `GROUP BY`: `facetValue()` reads fields that live inside the
   * payload — provider, model, tool call, tag — so grouping in SQL would only
   * work for the handful that happen to be columns and would need a second,
   * divergent definition for the rest. The narrowing is still done by SQL; the
   * counting uses the JSONL engine's own projection.
   */
  async facets(
    fields: readonly ChronicleFacet[],
    query: ChronicleQuery = {},
    limit = 100,
  ): Promise<ChronicleFacetResults> {
    const uniqueFields = [...new Set(fields)];
    if (uniqueFields.length === 0) return {};
    const counts = new Map(uniqueFields.map((field) => [field, new Map<string, number>()]));

    for (const event of this.eachMatch(query)) {
      for (const field of uniqueFields) {
        const value = facetValue(event, field);
        if (value === undefined) continue;
        const fieldCounts = counts.get(field);
        fieldCounts?.set(value, (fieldCounts.get(value) ?? 0) + 1);
      }
    }

    const result: ChronicleFacetResults = {};
    for (const field of uniqueFields) {
      result[field] = [...(counts.get(field) ?? new Map<string, number>())]
        .map(([value, count]) => ({ value, count }))
        // Ties broken by value so both engines agree on an otherwise arbitrary
        // order — the same comparator `ChronicleQueryEngine.facets` uses.
        .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value))
        .slice(0, Math.max(0, limit));
    }
    return result;
  }

  async facet(
    field: ChronicleFacet,
    query: ChronicleQuery = {},
    limit = 100,
  ): Promise<ChronicleFacetValue[]> {
    return (await this.facets([field], query, limit))[field] ?? [];
  }

  /**
   * Expand explicit and typed correlation edges around a seed set.
   *
   * The traversal is the JSONL engine's, moved onto rows: `relationKeys()`
   * defines the edges, `compareEvents` orders the nodes, and each hop is
   * another ordered pass. Order is load-bearing rather than cosmetic — both
   * `maxNodes` truncations stop at whatever they reach first, so a differently
   * ordered scan would return a different subgraph rather than the same one
   * shuffled. `ORDER BY day, sequence` reproduces `comparePartitionPaths`
   * (family, then rotation index) followed by line order within a partition.
   */
  async graph(
    seed: ChronicleQuery = {},
    hops = 2,
    maxNodes = 1_000,
  ): Promise<ChronicleGraphResult> {
    const nodeLimit = Math.max(0, Math.floor(maxNodes));
    const selected = new Map<string, ChronicleEvent>();
    let seedCount = 0;

    for (const event of this.eachMatch(seed)) {
      seedCount++;
      if (selected.size < nodeLimit) selected.set(event.eventId, event);
    }

    let frontier = [...selected.values()];
    const depthLimit = Math.max(0, Math.min(hops, 10));
    for (
      let depth = 0;
      depth < depthLimit && frontier.length > 0 && selected.size < nodeLimit;
      depth++
    ) {
      const frontierKeys = new Set(
        frontier.flatMap((event) => relationKeys(event).map((relation) => relation.key)),
      );
      const next: ChronicleEvent[] = [];
      for (const event of this.eachMatch({})) {
        if (selected.has(event.eventId)) continue;
        if (!relationKeys(event).some((relation) => frontierKeys.has(relation.key))) continue;
        selected.set(event.eventId, event);
        next.push(event);
        if (selected.size >= nodeLimit) break;
      }
      frontier = next;
    }

    const nodes = [...selected.values()].sort(compareEvents);
    const byKey = new Map<string, ChronicleEvent[]>();
    for (const node of nodes) {
      for (const relation of relationKeys(node)) {
        const related = byKey.get(relation.key) ?? [];
        related.push(node);
        byKey.set(relation.key, related);
      }
    }

    const edges: ChronicleGraphEdge[] = [];
    const seen = new Set<string>();
    for (const node of nodes) {
      for (const relation of relationKeys(node)) {
        for (const candidate of byKey.get(relation.key) ?? []) {
          if (candidate.eventId === node.eventId) continue;
          const [from, to] =
            compareEvents(node, candidate) <= 0 ? [node, candidate] : [candidate, node];
          const id = `${from.eventId}:${to.eventId}:${relation.kind}`;
          if (seen.has(id)) continue;
          seen.add(id);
          edges.push({
            from: from.eventId,
            to: to.eventId,
            kind: relation.kind,
            confidence: relation.confidence,
          });
        }
      }
    }

    return {
      nodes,
      edges,
      truncated: seedCount > nodeLimit || selected.size >= nodeLimit,
    };
  }

  /** Every event satisfying `query`, pulled in batches so a wide scan stays bounded. */
  private *eachMatch(query: ChronicleQuery): Generator<ChronicleEvent> {
    const pushed = pushDown(query);
    const sql =
      `SELECT payload FROM events WHERE ${pushed.clause}` +
      ' ORDER BY day, sequence LIMIT ? OFFSET ?';
    let offset = 0;
    for (;;) {
      const rows = this.db.prepare(sql).all(...pushed.params, this.batchSize, offset) as Array<{
        payload: StoredChroniclePayload;
      }>;
      if (rows.length === 0) return;
      offset += rows.length;
      for (const row of rows) {
        let event: ChronicleEvent;
        try {
          event = JSON.parse(decodeChroniclePayload(row.payload)) as ChronicleEvent;
        } catch {
          this.diagnostics.invalidLines++;
          continue;
        }
        if (matches(event, query)) yield event;
      }
      if (rows.length < this.batchSize) return;
    }
  }
}
