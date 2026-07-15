import type { MemoryEntry, MemoryScope, MemoryStore } from '@wrongstack/core';

export interface MemorySlashDeps {
  memoryStore: MemoryStore;
}

const SCOPE_SHORT: Record<MemoryScope, string> = {
  'project-agents': 'AGENTS.md',
  'project-memory': 'Project memory',
  'user-memory': 'User memory',
};

/**
 * Format a memory entry as a single markdown-style table row.
 */
function formatRow(e: MemoryEntry): string {
  const type = e.type ?? '—';
  const priority = e.priority ?? '—';
  const date = e.ts ? new Date(e.ts).toISOString().slice(0, 10) : '—';
  const tags = e.tags?.length ? e.tags.join(', ') : '—';
  // Collapse long text to a single-line preview
  const text = e.text.replace(/\s+/g, ' ').trim();
  const preview = text.length > 72 ? `${text.slice(0, 70)}…` : text;
  return `| ${type.padEnd(13)} | ${priority.padEnd(8)} | ${date} | ${tags.padEnd(16)} | ${preview} |`;
}

const TABLE_HEADER =
  '| Type          | Priority | Date       | Tags             | Preview (first 72 chars)                          |\n' +
  '|---------------|----------|------------|------------------|---------------------------------------------------|';

/**
 * Render memory entries for one scope as a markdown section with a heading
 * and table.
 */
function renderScopeSection(scope: MemoryScope, entries: MemoryEntry[]): string[] {
  if (entries.length === 0) return [];
  const lines: string[] = [];
  const name = SCOPE_SHORT[scope] ?? scope;
  lines.push(`### ${name} (${entries.length})`);
  lines.push('');
  lines.push(TABLE_HEADER);
  for (const e of entries) {
    lines.push(formatRow(e));
  }
  lines.push('');
  return lines;
}

export function createMemorySlashCommand(deps: MemorySlashDeps) {
  return {
    name: 'memory',
    description: 'List stored memory entries grouped by scope, rendered as clean markdown tables.',
    argsHint: '[scope]',
    help:
      'Usage:\n' +
      '  /memory                      — list all entries across all scopes\n' +
      '  /memory project-memory       — list only project memory\n' +
      '  /memory user-memory          — list only user memory\n' +
      '  /memory project-agents       — list only project AGENTS.md entries\n' +
      '',
    async run(args: string) {
      const trimmed = args.trim().toLowerCase() as MemoryScope | '';
      const scopes: MemoryScope[] =
        trimmed &&
        (['project-agents', 'project-memory', 'user-memory'] as const).includes(
          trimmed as MemoryScope,
        )
          ? [trimmed as MemoryScope]
          : ['project-agents', 'project-memory', 'user-memory'];

      try {
        const parts: string[] = [];
        let totalEntries = 0;

        for (const scope of scopes) {
          const entries = await deps.memoryStore.list(scope);
          if (entries.length === 0) continue;
          totalEntries += entries.length;
          parts.push(...renderScopeSection(scope, entries));
        }

        if (totalEntries === 0) {
          return { message: 'No memory entries found.' };
        }

        const summary = `**Total: ${totalEntries} entr${totalEntries === 1 ? 'y' : 'ies'} across ${scopes.length} scope${scopes.length === 1 ? '' : 's'}**`;
        parts.push(summary);

        return { message: parts.join('\n') };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { message: `Failed to read memory store: ${msg}` };
      }
    },
  };
}
