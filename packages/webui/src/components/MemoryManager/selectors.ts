import type { SageEntry, SageStatus } from '@/types';

export function filterMemories(
  memories: SageEntry[],
  filters: {
    searchQuery: string;
    statusFilter: 'all' | SageStatus;
    kindFilter: string;
    tagFilter: string | null;
    audienceOnly: boolean;
  },
): SageEntry[] {
  const query = filters.searchQuery.trim().toLowerCase();
  return memories.filter((memory) => {
    if (filters.statusFilter !== 'all' && memory.status !== filters.statusFilter) return false;
    if (filters.kindFilter !== 'all' && memory.kind !== filters.kindFilter) return false;
    if (filters.tagFilter && !memory.tags.includes(filters.tagFilter)) return false;
    if (filters.audienceOnly && !memory.audience) return false;
    if (!query) return true;
    const anchorText = memory.anchors
      .map((anchor) =>
        [anchor.path, anchor.symbol, anchor.command, anchor.role].filter(Boolean).join(' '),
      )
      .join(' ');
    const audienceText = memory.audience
      ? [
          memory.audience.roles?.join(' ') ?? '',
          memory.audience.taskTypes?.join(' ') ?? '',
          memory.audience.modes?.join(' ') ?? '',
        ].join(' ')
      : '';
    return [
      memory.id,
      memory.text,
      memory.summary ?? '',
      memory.kind,
      memory.scope,
      memory.tags.join(' '),
      anchorText,
      audienceText,
    ]
      .join(' ')
      .toLowerCase()
      .includes(query);
  });
}

export function collectMemoryTags(memories: SageEntry[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const memory of memories) {
    for (const tagName of memory.tags) counts.set(tagName, (counts.get(tagName) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export function selectRelatedMemories(
  memory: SageEntry | null,
): Array<{ relation: string; id: string }> {
  if (!memory) return [];
  const links: Array<{ relation: string; id: string }> = [];
  if (memory.supersededBy) links.push({ relation: 'Superseded by', id: memory.supersededBy });
  for (const id of memory.supersedes ?? []) links.push({ relation: 'Supersedes', id });
  for (const id of memory.contradicts ?? []) links.push({ relation: 'Contradicts', id });
  return links;
}
