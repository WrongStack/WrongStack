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
  type ChronicleOrderKey,
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
import {
  compareEventToKey,
  findInsertionIndex,
  isChronicleEvent,
  orderKey,
} from './query-matching.js';
import type { ChronicleEvent } from './types.js';

/** Hard ceiling mirroring `ChronicleQueryEngine.query`. */
const MAX_LIMIT = 10_000;

/** Position of a journal row: its `(day, sequence)` primary key. */
interface RowKey {
  day: string;
  sequence: number;
}

/**
 * Facet counts already taken for one query over the rows up to `last`, kept per
 * database across the engines a long-lived journal hands out. The journal only
 * appends and only ever deletes a prefix (retention and compaction), so while
 * its oldest row is still `first` nothing counted is gone and only rows after
 * `last` (by rowid) need decoding — every payload is deflated JSON, and inflating a whole
 * journal for each facet request cost about 1.5 s per 100k events.
 */
interface FacetCacheEntry {
  first: RowKey | undefined;
  /** The highest rowid counted; rows only ever get higher ones. */
  last: number;
  counts: Map<ChronicleFacet, Map<string, number>>;
}

/** Distinct queries kept per database; the least recently used goes first. */
const FACET_CACHE_ENTRIES = 16;
const facetCaches = new WeakMap<DatabaseSync, Map<string, FacetCacheEntry>>();

function facetCacheKey(fields: readonly ChronicleFacet[], query: ChronicleQuery): string {
  // Paging and ordering do not change which events are counted.
  const { cursor: _cursor, limit: _limit, order: _order, ...matching } = query;
  return JSON.stringify([fields, matching]);
}

/**
 * Position in the `compareEvents` order: the last event of the previous page.
 *
 * Not the storage keyset `(day, sequence)`: that is persistence order, and an
 * event persisted late with an early `occurredAt` (a process stamped with its
 * start time) sorts differently there. Deliberately not interchangeable with
 * the JSONL engine's cursor, which also encodes a snapshot of partition files.
 */
function encodeCursor(key: ChronicleOrderKey): string {
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');
}

function decodeCursor(raw: string | undefined): ChronicleOrderKey | undefined {
  if (!raw) return undefined;
  try {
    const key = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as ChronicleOrderKey;
    return typeof key?.occurredAt === 'string' &&
      typeof key.persistedAt === 'string' &&
      Number.isSafeInteger(key.sequence) &&
      typeof key.eventId === 'string'
      ? key
      : undefined;
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
    const sql =
      `SELECT payload FROM events WHERE ${pushed.clause}` +
      ` ORDER BY day ${direction}, sequence ${direction} LIMIT ? OFFSET ?`;
    const pageOrder = (left: ChronicleEvent, right: ChronicleEvent) =>
      compareEvents(left, right) * (order === 'asc' ? 1 : -1);

    const summary = createSummaryAccumulator();
    const page: ChronicleEvent[] = [];
    let total = 0;
    let remaining = 0;
    let scannedEvents = 0;
    let invalidLines = 0;
    let offset = 0;

    // Every matching event feeds the summary and `total`, which are defined
    // over the whole result set on every page (see `ChronicleSummary`). The page
    // is the top `limit` in `compareEvents` order — the JSONL engine's rule —
    // not the first rows in storage order. Candidates are streamed in batches
    // so a wide query does not materialise the table.
    for (;;) {
      const rows = this.db.prepare(sql).all(...pushed.params, this.batchSize, offset) as Array<{
        payload: StoredChroniclePayload;
      }>;
      if (rows.length === 0) break;
      offset += rows.length;

      for (const row of rows) {
        let event: ChronicleEvent;
        try {
          event = JSON.parse(decodeChroniclePayload(row.payload)) as ChronicleEvent;
          if (!isChronicleEvent(event)) {
            invalidLines++;
            continue;
          }
        } catch {
          invalidLines++;
          continue;
        }
        scannedEvents++;
        if (!matches(event, query)) continue;
        total++;
        updateSummary(summary, event);
        if (cursor && compareEventToKey(event, cursor) * (order === 'asc' ? 1 : -1) <= 0) continue;
        remaining++;
        const index = findInsertionIndex(page, event, pageOrder);
        if (index < limit) {
          page.splice(index, 0, event);
          if (page.length > limit) page.pop();
        }
      }
      if (rows.length < this.batchSize) break;
    }

    this.diagnostics.invalidLines = invalidLines;
    const last = page.at(-1);
    const result: ChronicleQueryResult = {
      events: page,
      total,
      scannedEvents,
      sourceFiles: this.diagnostics.sourceFiles,
      invalidLines,
      summary: finalizeSummary(summary),
    };
    if (remaining > page.length && last) {
      return { ...result, nextCursor: encodeCursor(orderKey(last)) };
    }
    return result;
  }

  /**
   * One page of the unfiltered view (only `from`/`to`/`order`/`limit`/`cursor` set), read
   * through the `occurred_at` index instead of decoding the whole table.
   *
   * {@link query} streams every matching event to build `total` and the summary. For the
   * unfiltered view that is the entire journal: about 3 s per call on a 160 MB project, which
   * every desktop Chronicle visit waited on. Here every filter is exact in SQL, `total` is a
   * count, and the summary is left empty for the caller to fill (the project server serves it
   * from the metrics store). The page order is still {@link compareEvents}: candidates come in
   * `occurred_at` order, its first key, and every row tied with the last one needed is read,
   * because ties are ordered by fields inside the payload.
   */
  defaultViewPage(query: ChronicleQuery = {}): ChronicleQueryResult {
    const ascending = (query.order ?? 'desc') === 'asc';
    const limit = Math.max(1, Math.min(query.limit ?? 100, MAX_LIMIT));
    const cursor = decodeCursor(query.cursor);
    const pushed = pushDown({
      ...(query.from ? { from: query.from } : {}),
      ...(query.to ? { to: query.to } : {}),
    });
    const total = (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM events WHERE ${pushed.clause}`)
        .get(...pushed.params) as { n: number }
    ).n;
    const clauses = [pushed.clause];
    const params = [...pushed.params];
    if (cursor) {
      clauses.push(ascending ? 'occurred_at >= ?' : 'occurred_at <= ?');
      params.push(cursor.occurredAt);
    }
    const direction = ascending ? 'ASC' : 'DESC';
    const statement = this.db.prepare(
      `SELECT occurred_at AS at, payload FROM events WHERE ${clauses.join(' AND ')}` +
        ` ORDER BY occurred_at ${direction} LIMIT ? OFFSET ?`,
    );
    const sign = ascending ? 1 : -1;
    const batch = Math.max(limit + 1, 200);
    const candidates: ChronicleEvent[] = [];
    let boundary: string | undefined;
    let invalidLines = 0;
    let scannedEvents = 0;
    let offset = 0;
    read: for (;;) {
      const rows = statement.all(...params, batch, offset) as Array<{
        at: string;
        payload: StoredChroniclePayload;
      }>;
      offset += rows.length;
      for (const row of rows) {
        // Past the rows tied with the last candidate needed: nothing further can enter.
        if (boundary !== undefined && row.at !== boundary) break read;
        let event: ChronicleEvent;
        try {
          event = JSON.parse(decodeChroniclePayload(row.payload)) as ChronicleEvent;
        } catch {
          invalidLines++;
          continue;
        }
        if (!isChronicleEvent(event)) {
          invalidLines++;
          continue;
        }
        scannedEvents++;
        if (cursor && compareEventToKey(event, cursor) * sign <= 0) continue;
        candidates.push(event);
        // One more than the page shows whether a next page exists.
        if (candidates.length === limit + 1) boundary = row.at;
      }
      if (rows.length < batch) break;
    }
    candidates.sort((left, right) => compareEvents(left, right) * sign);
    const page = candidates.slice(0, limit);
    this.diagnostics.invalidLines = invalidLines;
    const last = page.at(-1);
    return {
      events: page,
      total,
      scannedEvents,
      sourceFiles: this.diagnostics.sourceFiles,
      invalidLines,
      summary: finalizeSummary(createSummaryAccumulator()),
      ...(candidates.length > limit && last ? { nextCursor: encodeCursor(orderKey(last)) } : {}),
    };
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
    const uniqueFields = [...new Set(fields)].sort();
    if (uniqueFields.length === 0) return {};
    const counts = this.facetCounts(uniqueFields, query);

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

  /** Counts per field over every matching row, reusing what an earlier request counted. */
  private facetCounts(
    fields: readonly ChronicleFacet[],
    query: ChronicleQuery,
  ): Map<ChronicleFacet, Map<string, number>> {
    const first = this.db
      .prepare('SELECT day, sequence FROM events ORDER BY day, sequence LIMIT 1')
      .get() as RowKey | undefined;
    const last =
      (this.db.prepare('SELECT max(rowid) AS last FROM events').get() as { last: number | null })
        .last ?? 0;
    let cache = facetCaches.get(this.db);
    if (!cache) {
      cache = new Map();
      facetCaches.set(this.db, cache);
    }
    const key = facetCacheKey(fields, query);
    let entry = cache.get(key);
    cache.delete(key);
    if (!entry || !sameRow(entry.first, first)) {
      entry = {
        first,
        last: 0,
        counts: new Map(fields.map((field) => [field, new Map<string, number>()])),
      };
    }
    if (last > entry.last) {
      for (const event of this.eachMatchByRowid(query, entry.last, last)) {
        for (const field of fields) {
          const value = facetValue(event, field);
          if (value === undefined) continue;
          const fieldCounts = entry.counts.get(field);
          fieldCounts?.set(value, (fieldCounts.get(value) ?? 0) + 1);
        }
      }
      entry.last = last;
    }
    cache.set(key, entry);
    while (cache.size > FACET_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
    return entry.counts;
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
    let truncated = false;
    let maxObservedInvalidLines = 0;

    for (const event of this.eachMatch(seed)) {
      if (selected.has(event.eventId)) continue;
      if (selected.size < nodeLimit) {
        selected.set(event.eventId, event);
      } else {
        truncated = true;
      }
    }
    maxObservedInvalidLines = Math.max(maxObservedInvalidLines, this.diagnostics.invalidLines);

    let frontier = [...selected.values()];
    const depthLimit = Math.max(0, Math.min(hops, 10));
    for (let depth = 0; depth < depthLimit && frontier.length > 0 && !truncated; depth++) {
      const frontierKeys = new Set(
        frontier.flatMap((event) => relationKeys(event).map((relation) => relation.key)),
      );
      const next: ChronicleEvent[] = [];
      for (const event of this.eachMatch({})) {
        if (selected.has(event.eventId)) continue;
        if (!relationKeys(event).some((relation) => frontierKeys.has(relation.key))) continue;
        if (selected.size >= nodeLimit) {
          truncated = true;
          break;
        }
        selected.set(event.eventId, event);
        next.push(event);
      }
      maxObservedInvalidLines = Math.max(maxObservedInvalidLines, this.diagnostics.invalidLines);
      frontier = next;
    }
    this.diagnostics.invalidLines = maxObservedInvalidLines;

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
      truncated,
    };
  }

  /**
   * Every event satisfying `query`, in journal order, pulled in batches so a wide scan stays
   * bounded. A batch continues from the previous one's last key: an OFFSET re-read every
   * earlier row for each batch.
   */
  private *eachMatch(query: ChronicleQuery): Generator<ChronicleEvent> {
    const pushed = pushDown(query);
    yield* this.decodeMatches(
      query,
      `SELECT day, sequence, payload FROM events WHERE (${pushed.clause})` +
        ' AND (day > ? OR (day = ? AND sequence > ?)) ORDER BY day, sequence LIMIT ?',
      (from: RowKey | undefined) => [
        ...pushed.params,
        from?.day ?? '',
        from?.day ?? '',
        from?.sequence ?? Number.MIN_SAFE_INTEGER,
      ],
      (row) => ({ day: String(row['day']), sequence: Number(row['sequence']) }),
    );
  }

  /**
   * Matching events inserted after row `after` and up to row `upTo`, in insertion order. The
   * rowid only grows, whatever day a row was filed under (a clock moved back, an import).
   */
  private *eachMatchByRowid(
    query: ChronicleQuery,
    after: number,
    upTo: number,
  ): Generator<ChronicleEvent> {
    const pushed = pushDown(query);
    yield* this.decodeMatches(
      query,
      `SELECT rowid, payload FROM events WHERE (${pushed.clause})` +
        ' AND rowid > ? AND rowid <= ? ORDER BY rowid LIMIT ?',
      (from: number | undefined) => [...pushed.params, from ?? after, upTo],
      (row) => Number(row['rowid']),
    );
  }

  private *decodeMatches<K>(
    query: ChronicleQuery,
    sql: string,
    params: (from: K | undefined) => (string | number)[],
    keyOf: (row: Record<string, unknown>) => K,
  ): Generator<ChronicleEvent> {
    this.diagnostics.invalidLines = 0;
    const statement = this.db.prepare(sql);
    let from: K | undefined;
    for (;;) {
      const rows = statement.all(...params(from), this.batchSize) as Array<
        Record<string, unknown> & { payload: StoredChroniclePayload }
      >;
      if (rows.length === 0) return;
      const tail = rows.at(-1);
      if (tail) from = keyOf(tail);
      for (const row of rows) {
        let event: ChronicleEvent;
        try {
          event = JSON.parse(decodeChroniclePayload(row.payload)) as ChronicleEvent;
          if (!isChronicleEvent(event)) {
            this.diagnostics.invalidLines++;
            continue;
          }
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

function sameRow(left: RowKey | undefined, right: RowKey | undefined): boolean {
  return left?.day === right?.day && left?.sequence === right?.sequence;
}
