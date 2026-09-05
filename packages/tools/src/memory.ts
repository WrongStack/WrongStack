import type { MemoryScope, MemoryStore, Tool } from '@wrongstack/core/types';
import { ToolValidationError, type MemoryEntry } from '@wrongstack/core/types';

export interface RememberInput {
  text: string;
  scope?: MemoryScope | undefined;
  /** Memory type for categorization. */
  type?:
    | 'fact'
    | 'decision'
    | 'convention'
    | 'preference'
    | 'reference'
    | 'anti_pattern'
    | undefined;
  /** Hashtag-style tags for grouping and search. */
  tags?: string[] | undefined;
  /** Priority level — critical entries always injected into context. */
  priority?: 'critical' | 'high' | 'medium' | 'low' | undefined;
}

export interface RememberOutput {
  ok: true;
  scope: MemoryScope;
}

export interface ForgetInput {
  query: string;
  scope?: MemoryScope | undefined;
  /** Preview: list what WOULD be deleted without deleting anything. */
  dry_run?: boolean | undefined;
}

export interface ForgetOutput {
  removed: number;
  scope: MemoryScope;
  /** True when this was a preview run — nothing was deleted. */
  dryRun?: boolean | undefined;
  /** dry_run only: texts of the entries the query matches (capped at 20). */
  matches?: string[] | undefined;
  /** dry_run only: total number of matching entries (may exceed matches.length). */
  matched?: number | undefined;
}

export function rememberTool(memory: MemoryStore): Tool<RememberInput, RememberOutput> {
  return {
    name: 'remember',
    category: 'Session',
    description:
      'Persist facts, conventions, decisions, and preferences into long-term memory. Memories survive restarts and are scored for relevance in future sessions.',
    usageHint:
      'Persist facts, conventions, decisions, and preferences into long-term memory.\n\n' +
      'WHEN TO USE:\n' +
      '- Project conventions discovered during a task (build tool, lint rules, code style)\n' +
      '- Architecture decisions made (chose X over Y, decided to use pattern Z)\n' +
      '- User preferences expressed (prefers short names, always uses pnpm)\n' +
      '- Anti-patterns identified (never do X, avoid pattern Y)\n' +
      '- File/location references useful across sessions\n\n' +
      'WHEN NOT TO USE:\n' +
      '- Temporary task state or progress → use `todo`\n' +
      '- One-off debugging notes\n' +
      '- Information already obvious from the codebase\n\n' +
      'Always include `type` and `priority`. Use 1-3 `tags` for grouping.\n' +
      'Better to remember a fact now than rediscover it next session.',
    permission: 'confirm',
    mutating: true,
    timeoutMs: 2_000,
    capabilities: ['memory.write'],
    icon: 'settings',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'The fact or note to remember. Keep it concise and factual.',
        },
        scope: {
          type: 'string',
          enum: ['project-agents', 'project-memory', 'user-memory'],
          description:
            'Where to store it: project-memory (shared), user-memory (personal), or project-agents.',
        },
        type: {
          type: 'string',
          enum: ['fact', 'decision', 'convention', 'preference', 'reference', 'anti_pattern'],
          description: 'Category for filtering and relevance scoring.',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Hashtag-style tags for grouping and search.',
        },
        priority: {
          type: 'string',
          enum: ['critical', 'high', 'medium', 'low'],
          description: 'Priority level. Critical = always injected into context.',
        },
      },
      required: ['text'],
    },
    async execute(input) {
      if (!input?.text) {
        throw new ToolValidationError({
          message: 'remember: text is required',
          field: 'text',
        });
      }
      const scope = input.scope ?? 'project-memory';
      await memory.remember(input.text, scope, {
        type: input.type,
        tags: input.tags,
        priority: input.priority,
      });
      return { ok: true, scope };
    },
  };
}

export function forgetTool(memory: MemoryStore): Tool<ForgetInput, ForgetOutput> {
  return {
    name: 'forget',
    category: 'Session',
    description:
      'Remove memory entries that contain the given substring (case-insensitive). Use with caution. ' +
      'Pass `dry_run: true` to preview the matching entries (capped at 20) without deleting anything.',
    usageHint:
      'This permanently deletes matching memories in the chosen scope.\n' +
      '- Provide a reasonably specific `query` to avoid deleting unrelated memories.\n' +
      '- Always double-check before calling with broad queries — `dry_run: true` previews the matches without deleting.\n' +
      '- Use `remember` + `forget` together to maintain clean long-term memory.',
    permission: 'confirm',
    // WS-046: gives permission decisions something to key on — the substring
    // being forgotten.
    subjectKey: 'query',
    mutating: true,
    timeoutMs: 2_000,
    capabilities: ['memory.delete'],
    icon: 'settings',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        scope: { type: 'string', enum: ['project-agents', 'project-memory', 'user-memory'] },
        dry_run: {
          type: 'boolean',
          description:
            'When true, return the matched entries (capped at 20) WITHOUT deleting them. Default false.',
        },
      },
      required: ['query'],
    },
    async execute(input) {
      if (!input?.query) {
        throw new ToolValidationError({
          message: 'forget: query is required',
          field: 'query',
        });
      }
      const scope = input.scope ?? 'project-memory';
      if (input.dry_run) {
        // Mirror forget's matching (case-insensitive substring) over the full
        // entry list rather than delegating to search(), whose backend may be
        // semantic and match a different set than deletion would.
        const entries = await memory.list(scope);
        const needle = input.query.toLowerCase();
        const matching = entries.filter((entry) => entry.text.toLowerCase().includes(needle));
        return {
          removed: 0,
          scope,
          dryRun: true,
          matched: matching.length,
          matches: matching.slice(0, 20).map((entry) => entry.text),
        };
      }
      const removed = await memory.forget(input.query, scope);
      return { removed, scope };
    },
  };
}

// ── Enhanced memory query tools — use backend capabilities ───────────

export interface SearchMemoryInput {
  query: string;
  scope?: MemoryScope | undefined;
  limit?: number | undefined;
}

export interface SearchMemoryOutput {
  results: Array<{
    text: string;
    ts: string;
    scope: MemoryScope;
    type?: string | undefined;
    tags?: string[] | undefined;
    priority?: string | undefined;
  }>;
}

function normalizeMemoryLimit(value: number | undefined): number {
  const raw = typeof value === 'number' && Number.isFinite(value) ? value : 5;
  return Math.max(1, Math.min(Math.floor(raw), 20));
}

export function searchMemoryTool(memory: MemoryStore): Tool<SearchMemoryInput, SearchMemoryOutput> {
  return {
    name: 'search_memory',
    category: 'Session',
    description:
      'Search memory entries by content. With the default backend this does substring matching; semantic/graph backends use embedding similarity or graph traversal.',
    usageHint:
      'Search long-term memory for relevant facts, conventions, or decisions.\n' +
      '- Returns results ordered by relevance (newest-first for default, similarity for semantic).\n' +
      '- Use before starting a task to recall project conventions and past decisions.\n' +
      '- `limit` caps results (default 5, max 20).',
    permission: 'auto',
    mutating: false,
    timeoutMs: 2_000,
    capabilities: ['memory.read'],
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query — words or phrase to find in memory.',
        },
        scope: {
          type: 'string',
          enum: ['project-agents', 'project-memory', 'user-memory'],
          description: 'Which scope to search. Defaults to project-memory.',
        },
        limit: {
          type: 'number',
          description: 'Maximum results to return (default 5, max 20).',
        },
      },
      required: ['query'],
    },
    async execute(input) {
      if (!input?.query) {
        throw new ToolValidationError({
          message: 'search_memory: query is required',
          field: 'query',
        });
      }
      const scope = input.scope ?? 'project-memory';
      const limit = normalizeMemoryLimit(input.limit);
      const entries = await memory.search(input.query, scope, limit);
      return {
        results: entries.map((e: MemoryEntry) => ({
          text: e.text,
          ts: e.ts,
          scope: e.scope,
          type: e.type,
          tags: e.tags,
          priority: e.priority,
        })),
      };
    },
  };
}

export interface RelatedMemoryInput {
  text: string;
  scope?: MemoryScope | undefined;
  limit?: number | undefined;
}

export function relatedMemoryTool(
  memory: MemoryStore,
): Tool<RelatedMemoryInput, SearchMemoryOutput> {
  return {
    name: 'find_related_memories',
    category: 'Session',
    description:
      'Find memories related to the given text via graph traversal. Only available with graph backends; falls back to content search with file backends.',
    usageHint:
      'Discover memories connected to a topic through co-occurrence or similarity edges.\n' +
      '- Useful for exploring what else the project knows about a given concept.\n' +
      '- Falls back to content search when no graph backend is configured.\n' +
      '- `limit` caps results (default 5, max 20).',
    permission: 'auto',
    mutating: false,
    timeoutMs: 2_000,
    capabilities: ['memory.read'],
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Text to find related memories for.',
        },
        scope: {
          type: 'string',
          enum: ['project-agents', 'project-memory', 'user-memory'],
          description: 'Which scope to search. Defaults to project-memory.',
        },
        limit: {
          type: 'number',
          description: 'Maximum results to return (default 5, max 20).',
        },
      },
      required: ['text'],
    },
    async execute(input) {
      if (!input?.text) {
        throw new ToolValidationError({
          message: 'find_related_memories: text is required',
          field: 'text',
        });
      }
      const scope = input.scope ?? 'project-memory';
      const limit = normalizeMemoryLimit(input.limit);
      const entries = memory.findRelated
        ? await memory.findRelated(input.text, scope, limit)
        : await memory.search(input.text, scope, limit);
      return {
        results: entries.map((e: MemoryEntry) => ({
          text: e.text,
          ts: e.ts,
          scope: e.scope,
          type: e.type,
          tags: e.tags,
          priority: e.priority,
        })),
      };
    },
  };
}
