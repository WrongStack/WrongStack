import type { DatabaseSync } from 'node:sqlite';

import { memoryNodeId } from './sqlite-store-graph-helpers.js';
import type { Sage } from './types.js';

type SqliteStatement = ReturnType<DatabaseSync['prepare']>;

/**
 * Upper bound on relationship assertions materialized per memory. The arrays
 * are caller-supplied (`rememberSage`/`updateSage` accept them verbatim) and
 * the merge path unions them across revisions, so a pathological input could
 * otherwise drive an unbounded insert loop inside a mutation.
 */
const MAX_RELATIONSHIP_EDGES_PER_MEMORY = 256;

/**
 * Materialize a memory's `supersedes` / `contradicts` arrays as graph edges.
 *
 * These relations are declared in `MemoryGraphRelation` and accepted on
 * `rememberSage` / `updateSage` input, but until this sync existed only the
 * hygiene and admin paths ever wrote the edge — the ordinary write path stored
 * the ids in the row JSON and left the graph blind. The divergence is not
 * theoretical: on this repository's live store, 12,482 of 18,601 `supersedes`
 * pairs (67%) had no matching edge, and `contradicts` had 4 recorded pairs and
 * zero edges in the entire graph. `findRelatedSage` expands through the graph,
 * so every unmaterialized pair is a relationship the retriever cannot follow.
 *
 * Insert-only, deliberately. `syncSqliteAnchorEdges` may delete and rebuild its
 * `about_*` edges because it is the sole writer of them; relationship edges are
 * also asserted by hygiene consolidation and by the admin/recovery helper, so a
 * delete-and-rebuild here would silently drop those. `ON CONFLICT … MAX(weight)`
 * keeps repeated assertions idempotent, matching the edge-weight contract
 * documented in `sqlite-store-schema.ts`. The cost is that removing an id from
 * the array leaves its edge behind — which is the add-only assertion model
 * those other writers already follow.
 *
 * Status is not consulted: hygiene asserts `supersedes` precisely while marking
 * the superseded row non-active, so gating on status the way the anchor sync
 * does would drop the assertion at the moment it is made.
 */
export function syncSqliteRelationshipEdges(
  deps: {
    stmt(sql: string): SqliteStatement;
    nowIso(): string;
  },
  memory: Sage,
): void {
  const pairs: Array<[relation: 'supersedes' | 'contradicts', targetId: string]> = [];
  for (const targetId of memory.supersedes ?? []) pairs.push(['supersedes', targetId]);
  for (const targetId of memory.contradicts ?? []) pairs.push(['contradicts', targetId]);
  if (pairs.length === 0) return;

  const from = memoryNodeId(memory.id);
  const insert = deps.stmt(
    `INSERT INTO edges (from_node, to_node, relation, weight, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(from_node, to_node, relation) DO UPDATE SET
       weight = MAX(weight, excluded.weight)`,
  );
  const now = deps.nowIso();
  const seen = new Set<string>();
  for (const [relation, targetId] of pairs.slice(0, MAX_RELATIONSHIP_EDGES_PER_MEMORY)) {
    const trimmed = targetId.trim();
    if (!trimmed) continue;
    const to = memoryNodeId(trimmed);
    // A self-edge is never a relationship and would make the memory its own
    // graph neighbour, feeding it back into `findRelatedSage` expansion.
    if (to === from) continue;
    const key = `${to}\0${relation}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // Weight 1 matches the hygiene/admin assertion weight so a re-assertion
    // from either writer converges instead of ratcheting.
    insert.run(from, to, relation, 1, now);
  }
}
