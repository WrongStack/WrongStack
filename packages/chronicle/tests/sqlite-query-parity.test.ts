/**
 * Phase 3 of `chronicle-sqlite-journal-v1`: the two read paths must agree.
 *
 * This is the gate for the cut-over. After phase 4 the JSONL reader is deleted,
 * so rollback stops being a flag flip and becomes a release revert — which
 * makes "both engines return the same thing" the last cheap moment to catch a
 * divergence.
 *
 * Two fields are excluded from the comparison on purpose:
 *
 * - `sourceFiles` / `invalidLines` describe partition-file I/O and have no
 *   meaning once rows live in one database.
 * - `nextCursor` is opaque and engine-scoped; the JSONL cursor encodes a file
 *   snapshot, the SQLite cursor a `(day, sequence)` keyset. Pagination is
 *   compared by the events each engine yields, which is the property that
 *   actually matters.
 *
 * `scannedEvents` is likewise excluded: it counts work done, not results, and
 * the whole point of the migration is for it to differ.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadRuntimeDatabaseSync as loadTestDatabaseSync } from '@wrongstack/persistence';

const DatabaseSync = loadTestDatabaseSync();
type DatabaseSync = InstanceType<typeof DatabaseSync>;

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChronicleJournal } from '../src/journal.js';
import { importLegacyChronicleJournal } from '../src/legacy-journal-import.js';
import { type ChronicleQuery, ChronicleQueryEngine } from '../src/query.js';
import { CHRONICLE_SQLITE_FILE, ChronicleSqliteJournal } from '../src/sqlite-journal.js';
import { ChronicleSqliteQueryEngine } from '../src/sqlite-query.js';
import type { ChronicleEventInput } from '../src/types.js';

let dir: string;
let db: DatabaseSync;

/** A fixture wide enough that the filters under test actually discriminate. */
async function buildFixture(): Promise<void> {
  const days: Array<[string, ChronicleEventInput[]]> = [
    [
      '2026-03-02',
      [
        attempt('openai', 'gpt-5', 'success', 1200, { input: 100, output: 40 }),
        attempt('openai', 'gpt-5', 'failure', 800, { input: 50, output: 0 }),
        tool('tool.started', 'read', 'src/a.ts'),
        tool('tool.executed', 'read', 'src/a.ts', 'success'),
        tool('tool.failed', 'exec', 'src/b.ts', 'failure'),
      ],
    ],
    [
      '2026-03-03',
      [
        attempt('anthropic', 'claude-5', 'success', 2400, { input: 900, output: 300 }),
        attempt('anthropic', 'claude-5', 'success', 300, { input: 10, output: 5 }),
        tool('tool.started', 'read', 'src/a.ts'),
        tool('tool.executed', 'read', 'src/a.ts', 'success'),
      ],
    ],
  ];
  for (const [day, inputs] of days) {
    // Pin the clock to the day the file is named for. Without this the writer
    // stamps `occurredAt` with the real current time, every event lands on
    // today, and any `from`/`to` filter stops discriminating — the fixture
    // would still pass a parity check while testing nothing.
    const journal = new ChronicleJournal({
      filePath: path.join(dir, `${day}.events.jsonl`),
      now: () => new Date(`${day}T12:00:00.000Z`),
    });
    for (const one of inputs) await journal.append(one);
    await journal.flush();
  }
}

function attempt(
  providerId: string,
  modelId: string,
  outcome: 'success' | 'failure',
  durationMs: number,
  usage: { input: number; output: number },
): ChronicleEventInput {
  return {
    eventType: outcome === 'success' ? 'provider.attempt.completed' : 'provider.attempt.failed',
    scope: { installationId: 'inst', machineId: 'mach', sessionId: 'sess-a', agentId: 'agent-1' },
    correlation: {
      traceId: 'trace-a',
      spanId: 'span-a',
      logicalRequestId: 'lr-1',
      promptManifestId: 'prompt_1',
    },
    runtime: { providerId, modelId },
    outcome,
    durationNs: String(durationMs * 1_000_000),
    attributes: { usage },
  };
}

/**
 * `tool.started` / `tool.executed` / `tool.failed` are the event types the
 * summary actually recognises (see `updateSummary`). Inventing plausible-looking
 * names instead would build a fixture that exercises no summary branch, and the
 * parity comparison would then be over an all-zero summary.
 */
function tool(
  eventType: 'tool.started' | 'tool.executed' | 'tool.failed',
  name: string,
  filePath: string,
  outcome?: 'success' | 'failure',
): ChronicleEventInput {
  return {
    eventType,
    scope: { installationId: 'inst', machineId: 'mach', sessionId: 'sess-b', agentId: 'agent-2' },
    correlation: { traceId: 'trace-b', spanId: 'span-b', toolCallId: `tc-${name}` },
    resource: { kind: 'file', id: filePath, path: filePath },
    ...(outcome ? { outcome } : {}),
    tags: { tool: name },
  };
}

/** The fields both engines must agree on, in a stable shape. */
function comparable(result: {
  events: Array<{ eventId: string }>;
  total: number;
  summary: unknown;
}) {
  return {
    eventIds: result.events.map((event) => event.eventId),
    total: result.total,
    summary: result.summary,
  };
}

const QUERIES: Array<[string, ChronicleQuery]> = [
  ['everything', {}],
  ['ascending', { order: 'asc' }],
  ['by event type', { eventTypes: ['tool.executed'] }],
  ['by outcome', { outcomes: ['failure'] }],
  ['by session', { sessionId: 'sess-a' }],
  ['by agent', { agentId: 'agent-2' }],
  ['by provider (not a column)', { providerId: 'anthropic' }],
  ['by model (not a column)', { modelId: 'gpt-5' }],
  ['by trace', { traceId: 'trace-b' }],
  ['by logical request', { logicalRequestId: 'lr-1' }],
  ['by prompt manifest', { promptManifestId: 'prompt_1' }],
  ['by resource path (not a column)', { path: 'src/a.ts' }],
  ['by tag (lives in the payload)', { tags: { tool: 'read' } }],
  ['by date range', { from: '2026-03-03T00:00:00.000Z' }],
  ['range with type filter', { from: '2026-03-02T00:00:00.000Z', eventTypes: ['tool.failed'] }],
  ['no matches', { sessionId: 'does-not-exist' }],
  ['small page', { limit: 2 }],
  ['small page ascending', { limit: 2, order: 'asc' }],
];

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chronicle-parity-'));
  await buildFixture();
  const journal = new ChronicleSqliteJournal({ directory: dir });
  await importLegacyChronicleJournal(journal, dir);
  journal.close();
  db = new DatabaseSync(path.join(dir, CHRONICLE_SQLITE_FILE));
});

afterEach(async () => {
  db.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('SQLite query parity with the JSONL engine', () => {
  it('uses a fixture the query matrix can actually discriminate', async () => {
    // Guard the guard: two engines that both return nothing agree perfectly.
    // Pin the shape of the fixture so a parity pass means the filters ran, not
    // that every query happened to be empty.
    const engine = await ChronicleQueryEngine.fromDirectory(dir);
    const totalsByQuery = new Map<string, number>();
    for (const [name, query] of QUERIES) {
      totalsByQuery.set(name, (await engine.query(query)).total);
    }

    expect(totalsByQuery.get('everything')).toBe(9);
    expect(totalsByQuery.get('by event type')).toBe(2);
    expect(totalsByQuery.get('by outcome')).toBe(2);
    expect(totalsByQuery.get('by session')).toBe(4);
    expect(totalsByQuery.get('by provider (not a column)')).toBe(2);
    expect(totalsByQuery.get('by tag (lives in the payload)')).toBe(4);
    expect(totalsByQuery.get('by date range')).toBe(4);
    expect(totalsByQuery.get('no matches')).toBe(0);

    // And the summary has to carry real numbers, or comparing it proves nothing.
    const summary = (await engine.query({})).summary;
    expect(summary.inputTokens).toBeGreaterThan(0);
    expect(summary.providerP95DurationMs).toBeGreaterThan(0);
    expect(summary.toolCalls).toBeGreaterThan(0);
  });

  for (const [name, query] of QUERIES) {
    it(`matches the JSONL engine: ${name}`, async () => {
      const legacy = await (await ChronicleQueryEngine.fromDirectory(dir)).query(query);
      const sqlite = await new ChronicleSqliteQueryEngine(db).query(query);

      expect(comparable(sqlite)).toEqual(comparable(legacy));
    });
  }

  it('produces the same facet counts as the JSONL engine', async () => {
    // `providerId` / `modelId` / `resourcePath` / `toolCallId` live inside the
    // payload, so this also covers the fields a SQL `GROUP BY` could not have
    // grouped without a second, divergent definition.
    const fields = [
      'eventType',
      'outcome',
      'sessionId',
      'agentId',
      'providerId',
      'modelId',
      'resourceKind',
      'resourcePath',
      'toolCallId',
    ] as const;

    const legacy = await (await ChronicleQueryEngine.fromDirectory(dir)).facets(fields, {});
    const sqlite = await new ChronicleSqliteQueryEngine(db).facets(fields, {});

    expect(sqlite).toEqual(legacy);
    // Guard the guard: an all-empty facet map would compare equal too.
    expect(legacy.eventType?.length).toBeGreaterThan(1);
    expect(legacy.providerId).toEqual([
      { value: 'anthropic', count: 2 },
      { value: 'openai', count: 2 },
    ]);
  });

  it('applies the facet limit the same way', async () => {
    const legacy = await (await ChronicleQueryEngine.fromDirectory(dir)).facet('eventType', {}, 2);
    const sqlite = await new ChronicleSqliteQueryEngine(db).facet('eventType', {}, 2);

    expect(sqlite).toEqual(legacy);
    expect(sqlite).toHaveLength(2);
  });

  it('facets a filtered subset identically', async () => {
    const query = { sessionId: 'sess-b' } as const;
    const legacy = await (await ChronicleQueryEngine.fromDirectory(dir)).facets(
      ['eventType', 'resourcePath'],
      query,
    );
    const sqlite = await new ChronicleSqliteQueryEngine(db).facets(
      ['eventType', 'resourcePath'],
      query,
    );

    expect(sqlite).toEqual(legacy);
    expect(legacy.resourcePath?.length).toBeGreaterThan(0);
  });

  it('builds the same graph as the JSONL engine', async () => {
    const legacy = await (await ChronicleQueryEngine.fromDirectory(dir)).graph({
      traceId: 'trace-a',
    });
    const sqlite = await new ChronicleSqliteQueryEngine(db).graph({ traceId: 'trace-a' });

    expect(sqlite.nodes.map((node) => node.eventId)).toEqual(
      legacy.nodes.map((node) => node.eventId),
    );
    expect(sqlite.edges).toEqual(legacy.edges);
    expect(sqlite.truncated).toBe(legacy.truncated);
    // Guard the guard: an empty graph compares equal to an empty graph.
    expect(legacy.nodes.length).toBeGreaterThan(1);
    expect(legacy.edges.length).toBeGreaterThan(0);
  });

  it('expands hops identically from a single seed', async () => {
    // One tool event seeds a walk out to whatever shares its correlation keys,
    // so this exercises the frontier expansion rather than just the seed pass.
    const seed = { toolCallId: 'tc-read' } as const;
    const legacy = await (await ChronicleQueryEngine.fromDirectory(dir)).graph(seed, 2);
    const sqlite = await new ChronicleSqliteQueryEngine(db).graph(seed, 2);

    expect(sqlite.nodes.map((node) => node.eventId)).toEqual(
      legacy.nodes.map((node) => node.eventId),
    );
    expect(sqlite.edges).toEqual(legacy.edges);
    expect(legacy.nodes.length).toBeGreaterThan(1);
  });

  it('truncates to the same subgraph, not merely the same size', async () => {
    // `maxNodes` stops at whatever the scan reaches first, so a differently
    // ordered candidate stream would return a different set of nodes with an
    // identical count — which is exactly what this pins.
    const legacy = await (await ChronicleQueryEngine.fromDirectory(dir)).graph({}, 2, 3);
    const sqlite = await new ChronicleSqliteQueryEngine(db).graph({}, 2, 3);

    expect(sqlite.nodes.map((node) => node.eventId)).toEqual(
      legacy.nodes.map((node) => node.eventId),
    );
    expect(sqlite.truncated).toBe(true);
    expect(legacy.truncated).toBe(true);
    expect(sqlite.nodes).toHaveLength(3);
  });

  it('walks every page to the same events as the JSONL engine', async () => {
    const collect = async (
      next: (
        cursor?: string,
      ) => Promise<{ events: Array<{ eventId: string }>; nextCursor?: string }>,
    ): Promise<string[]> => {
      const ids: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 10; page++) {
        const result = await next(cursor);
        ids.push(...result.events.map((event) => event.eventId));
        if (!result.nextCursor) break;
        cursor = result.nextCursor;
      }
      return ids;
    };

    const engine = await ChronicleQueryEngine.fromDirectory(dir);
    const sqlite = new ChronicleSqliteQueryEngine(db);

    const legacyIds = await collect((cursor) =>
      engine.query({ limit: 2, order: 'asc', ...(cursor ? { cursor } : {}) }),
    );
    const sqliteIds = await collect((cursor) =>
      sqlite.query({ limit: 2, order: 'asc', ...(cursor ? { cursor } : {}) }),
    );

    expect(sqliteIds).toEqual(legacyIds);
    expect(sqliteIds).toHaveLength(9);
  });

  it('streams in batches without changing the answer', async () => {
    // A batch size below the row count exercises the paging loop; the result
    // must be identical to reading everything at once.
    const oneShot = await new ChronicleSqliteQueryEngine(db, { batchSize: 1_000 }).query({});
    const batched = await new ChronicleSqliteQueryEngine(db, { batchSize: 2 }).query({});

    expect(comparable(batched)).toEqual(comparable(oneShot));
  });

  it('skips non-ChronicleEvent JSON rows as invalidLines without throwing or accumulating across calls', async () => {
    db.prepare(
      `INSERT INTO events (day, sequence, event_id, occurred_at, event_type, outcome, payload, hash, previous_hash)
       VALUES ('2026-03-04', 998, 'bad-shape', '2026-03-04T10:00:00.000Z', 'tool.executed', 'success', '{}', 'h1', 'h0')`,
    ).run();
    db.prepare(
      `INSERT INTO events (day, sequence, event_id, occurred_at, event_type, outcome, payload, hash, previous_hash)
       VALUES ('2026-03-04', 999, 'bad-json', '2026-03-04T10:00:01.000Z', 'tool.executed', 'success', 'not-json', 'h2', 'h1')`,
    ).run();

    const engine = new ChronicleSqliteQueryEngine(db);
    const first = await engine.query({});
    const second = await engine.query({});

    expect(first.events).toHaveLength(9);
    expect(first.scannedEvents).toBe(9);
    expect(first.invalidLines).toBe(2);
    expect(second.invalidLines).toBe(2);
  });

  it('reports truncated=false when graph node count equals maxNodes, updates JSONL diagnostics.invalidLines on query/graph, and reports deletedBytes on purge dryRun (F678)', async () => {
    const legacy = await ChronicleQueryEngine.fromDirectory(dir);
    const sqlite = new ChronicleSqliteQueryEngine(db);

    const legacyFull = await legacy.graph({ traceId: 'trace-a' }, 2, 100);
    const exactLimit = legacyFull.nodes.length;
    expect(exactLimit).toBeGreaterThan(0);

    const legacyExact = await legacy.graph({ traceId: 'trace-a' }, 2, exactLimit);
    const sqliteExact = await sqlite.graph({ traceId: 'trace-a' }, 2, exactLimit);
    expect(legacyExact.nodes).toHaveLength(exactLimit);
    expect(legacyExact.truncated).toBe(false);
    expect(sqliteExact.nodes).toHaveLength(exactLimit);
    expect(sqliteExact.truncated).toBe(false);

    if (exactLimit > 1) {
      const legacyTrunc = await legacy.graph({ traceId: 'trace-a' }, 2, exactLimit - 1);
      const sqliteTrunc = await sqlite.graph({ traceId: 'trace-a' }, 2, exactLimit - 1);
      expect(legacyTrunc.truncated).toBe(true);
      expect(sqliteTrunc.truncated).toBe(true);
    }

    await fs.appendFile(path.join(dir, '2026-03-02.events.jsonl'), '{corrupt-line\n', 'utf8');
    const legacyCorrupt = await ChronicleQueryEngine.fromDirectory(dir);
    const qRes = await legacyCorrupt.query({});
    expect(qRes.invalidLines).toBe(1);
    expect(legacyCorrupt.diagnostics.invalidLines).toBe(1);

    const legacyCorruptGraph = await ChronicleQueryEngine.fromDirectory(dir);
    await legacyCorruptGraph.graph({ traceId: 'trace-a' }, 1, 10);
    expect(legacyCorruptGraph.diagnostics.invalidLines).toBe(1);

    const sqliteDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chronicle-purge-dry-'));
    try {
      let currentNow = new Date('2026-03-01T10:00:00.000Z');
      const j = new ChronicleSqliteJournal({
        directory: sqliteDir,
        now: () => currentNow,
      });
      await j.append(tool('tool.started', 'read', 'src/a.ts'));
      await j.flush();
      currentNow = new Date('2026-03-10T10:00:00.000Z');
      const dry = await j.purge({ retentionDays: 1, dryRun: true });
      expect(dry.deletedCount).toBe(1);
      expect(dry.deletedBytes).toBeGreaterThan(0);
      j.close();
    } finally {
      await fs.rm(sqliteDir, { recursive: true, force: true });
    }
  });
});

// 2026-11-14: facets inflated every payload of the journal on each request (~1.5 s per 100k
// events). Counts are now kept per database and query, and only rows inserted since are read.
describe('SQLite facet counts across requests', () => {
  const fields = ['eventType', 'outcome', 'providerId', 'modelId'] as const;
  const total = (values: { count: number }[] | undefined) =>
    (values ?? []).reduce((sum, value) => sum + value.count, 0);
  /** Copies the newest row under a new id and the given day, as a later append would. */
  const appendCopy = (id: string, day: string) =>
    db
      .prepare(
        `INSERT INTO events (day, sequence, event_id, hash, previous_hash, occurred_at, event_type,
           outcome, project_id, session_id, agent_id, task_id, trace_id, logical_request_id,
           prompt_manifest_id, resource_kind, resource_id, resource_path, duration_ns, payload)
         SELECT ?, 1000000 + rowid, ?, hash, previous_hash, occurred_at, event_type, outcome,
           project_id, session_id, agent_id, task_id, trace_id, logical_request_id,
           prompt_manifest_id, resource_kind, resource_id, resource_path, duration_ns, payload
         FROM events ORDER BY rowid DESC LIMIT 1`,
      )
      .run(day, id);
  const fresh = async () => {
    const legacy = await (await ChronicleQueryEngine.fromDirectory(dir)).facets([...fields], {});
    return legacy;
  };

  it('counts rows appended after an earlier request, whatever day they are filed under', async () => {
    const before = await new ChronicleSqliteQueryEngine(db).facets([...fields], {});
    expect(total(before.eventType)).toBe(9);
    appendCopy('later', '2026-03-05');
    // Filed under an earlier day than the newest row: still a new insert.
    appendCopy('back-dated', '2026-03-01');
    const after = await new ChronicleSqliteQueryEngine(db).facets([...fields], {});
    expect(total(after.eventType)).toBe(11);
    // A query with another key matching every row counts without any cached state.
    const uncached = await new ChronicleSqliteQueryEngine(db).facets([...fields], {
      from: '2000-01-01T00:00:00.000Z',
    });
    expect(after).toEqual(uncached);
  });

  it('recounts from scratch after a prefix of the journal is deleted', async () => {
    const first = await new ChronicleSqliteQueryEngine(db).facets([...fields], {});
    expect(first).toEqual(await fresh());
    db.prepare("DELETE FROM events WHERE day < '2026-03-03'").run();
    const after = await new ChronicleSqliteQueryEngine(db).facets([...fields], {});
    expect(total(after.eventType)).toBe(4);
    expect(after.providerId).toEqual([{ value: 'anthropic', count: 2 }]);
  });

  it('keeps a filtered and an unfiltered request apart', async () => {
    const all = await new ChronicleSqliteQueryEngine(db).facets([...fields], {});
    const failures = await new ChronicleSqliteQueryEngine(db).facets([...fields], {
      outcomes: ['failure'],
    });
    expect(total(all.eventType)).toBe(9);
    expect(total(failures.eventType)).toBe(2);
    expect(await new ChronicleSqliteQueryEngine(db).facets([...fields], {})).toEqual(all);
  });

  it('pages a wide scan in small batches to the same counts', async () => {
    const batched = await new ChronicleSqliteQueryEngine(db, { batchSize: 2 }).facets([...fields], {
      sessionId: 'sess-a',
    });
    const legacy = await (await ChronicleQueryEngine.fromDirectory(dir)).facets([...fields], {
      sessionId: 'sess-a',
    });
    expect(batched).toEqual(legacy);
  });
});
