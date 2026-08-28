import type { DatabaseSync } from 'node:sqlite';
import { consolidateSession as sharedConsolidateSession } from './shared/session-consolidation.js';
import { sqliteRowToMemory } from './sqlite-store-codec.js';
import { canonicalMemoryText } from './store-helpers.js';
import type {
  CreateCandidateInput,
  MemoryCandidate,
  Sage,
  SessionConsolidationInput,
  SessionConsolidationResult,
} from './types.js';

interface SqliteSessionConsolidationContext {
  stmt: (sql: string) => ReturnType<DatabaseSync['prepare']>;
  listCandidates: () => Promise<MemoryCandidate[]>;
  createCandidate: (input: CreateCandidateInput) => Promise<MemoryCandidate>;
  acceptCandidate: (candidateId: string) => Promise<Sage | undefined>;
}

export async function consolidateSqliteSession(
  ctx: SqliteSessionConsolidationContext,
  input: SessionConsolidationInput,
): Promise<SessionConsolidationResult> {
  const dedupSet = new Set<string>();
  const memories = ctx
    .stmt("SELECT data FROM memories WHERE status IN ('active', 'stale') AND scope = 'project'")
    .all() as Array<{ data: string }>;
  for (const row of memories) {
    try {
      dedupSet.add(canonicalMemoryText(sqliteRowToMemory(row).text));
    } catch {
      // Skip corrupt rows - mirrors sibling readers.
    }
  }
  for (const candidate of await ctx.listCandidates()) {
    if (candidate.scope === 'project') dedupSet.add(canonicalMemoryText(candidate.text));
  }
  return sharedConsolidateSession(
    {
      createCandidate: ctx.createCandidate,
      acceptCandidate: ctx.acceptCandidate,
    },
    dedupSet,
    input,
  );
}
