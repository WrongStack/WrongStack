import type { MemoryEntry, MemoryScope } from '@wrongstack/core/types';
import { legacyScopeLabel } from './sqlite-store-legacy.js';
import { formatLegacyEntry } from './sqlite-store-pagination.js';
import { legacyToSageScope } from './types.js';
import type { RememberSageInput } from './types.js';

export async function readAllSqliteMemory(
  read: (scope: MemoryScope) => Promise<string>,
): Promise<string> {
  const sections: string[] = [];
  for (const scope of ['project-agents', 'project-memory', 'user-memory'] as const) {
    const body = await read(scope);
    if (body) sections.push(`## ${legacyScopeLabel(scope)}\n\n${body}`);
  }
  return sections.join('\n\n');
}

export async function readSqliteMemory(
  list: (scope: MemoryScope) => Promise<MemoryEntry[]>,
  scope: MemoryScope,
): Promise<string> {
  return (await list(scope)).map(formatLegacyEntry).join('\n');
}

export async function rememberSqliteMemoryBridge(
  rememberSage: (input: RememberSageInput) => Promise<unknown>,
  text: string,
  scope: MemoryScope = 'project-memory',
  metadata?: Omit<Partial<MemoryEntry>, 'scope' | 'text' | 'ts'>,
): Promise<void> {
  await rememberSage({
    text,
    legacyScope: scope,
    scope: legacyToSageScope(scope),
    type: metadata?.type,
    tags: metadata?.tags,
    priority: metadata?.priority,
    confidence: metadata?.confidence,
    sources: metadata?.source
      ? [{ type: 'legacy_memory', excerptHash: metadata.source }]
      : undefined,
  });
}
