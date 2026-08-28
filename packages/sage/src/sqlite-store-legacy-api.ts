import type { MemoryEntry, MemoryScope } from '@wrongstack/core/types';

import type { LegacyImportResult, Sage, SageSearchOptions } from './types.js';
import { legacyToSageScope, sageToLegacyScope, toLegacyEntry } from './types.js';

interface SqliteLegacyApiContext {
  rememberSage: (input: { text: string; scope: 'project' }) => Promise<Sage>;
  searchSage: (query: string, opts: SageSearchOptions) => Promise<Sage[]>;
}

export async function importLegacySqliteMemory(
  ctx: Pick<SqliteLegacyApiContext, 'rememberSage'>,
  raw: string,
): Promise<LegacyImportResult> {
  const lines = raw.split(/\r?\n/);
  let imported = 0;
  let skipped = 0;
  for (const line of lines) {
    if (!/^\s*[-*]\s+/.test(line)) continue;
    const text = line.replace(/^\s*[-*]\s+/, '').trim();
    if (!text) {
      skipped++;
      continue;
    }
    await ctx.rememberSage({ text, scope: 'project' });
    imported++;
  }
  return { imported, skipped, files: 0 };
}

export async function searchLegacySqliteMemory(
  ctx: Pick<SqliteLegacyApiContext, 'searchSage'>,
  query: string,
  scope: MemoryScope = 'project-memory',
  limit?: number,
): Promise<MemoryEntry[]> {
  const memories = await ctx.searchSage(query, {
    scope: legacyToSageScope(scope),
    limit,
  });
  return memories
    .filter((memory) => memory.contextPolicy !== 'never')
    .filter((memory) => (memory.legacyScope ?? sageToLegacyScope(memory.scope)) === scope)
    .map(toLegacyEntry);
}
