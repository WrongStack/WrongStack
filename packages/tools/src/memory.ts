import type { MemoryScope, MemoryStore, Tool } from '@wrongstack/core';
import type { MemoryEntry } from '@wrongstack/core';

interface RememberInput {
  text: string;
  scope?: MemoryScope | undefined;
  /** Memory type for categorization. */
  type?: 'fact' | 'decision' | 'convention' | 'preference' | 'reference' | 'anti_pattern' | undefined;
  /** Hashtag-style tags for grouping and search. */
  tags?: string[] | undefined;
  /** Priority level — critical entries always injected into context. */
  priority?: 'critical' | 'high' | 'medium' | 'low' | undefined;
}

interface RememberOutput {
  ok: true;
  scope: MemoryScope;
}

interface ForgetInput {
  query: string;
  scope?: MemoryScope | undefined;
}

interface ForgetOutput {
  removed: number;
  scope: MemoryScope;
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
    permission: 'auto',
    mutating: true,
    timeoutMs: 2_000,
    capabilities: ['memory.write'],
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
          description: 'Where to store it: project-memory (shared), user-memory (personal), or project-agents.',
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
      if (!input?.text) throw new Error('remember: text is required');
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
    description: 'Remove memory entries that contain the given substring (case-insensitive). Use with caution.',
    usageHint:
      'This permanently deletes matching memories in the chosen scope.\n' +
      '- Provide a reasonably specific `query` to avoid deleting unrelated memories.\n' +
      '- Always double-check before calling with broad queries.\n' +
      '- Use `remember` + `forget` together to maintain clean long-term memory.',
    permission: 'confirm',
    mutating: true,
    timeoutMs: 2_000,
    capabilities: ['memory.delete'],
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        scope: { type: 'string', enum: ['project-agents', 'project-memory', 'user-memory'] },
      },
      required: ['query'],
    },
    async execute(input) {
      if (!input?.query) throw new Error('forget: query is required');
      const scope = input.scope ?? 'project-memory';
      const removed = await memory.forget(input.query, scope);
      return { removed, scope };
    },
  };
}

// ── Enhanced memory query tools — use backend capabilities ───────────

interface SearchMemoryInput {
  query: string;
  scope?: MemoryScope | undefined;
  limit?: number | undefined;
}

interface SearchMemoryOutput {
  results: Array<{
    text: string;
    ts: string;
    scope: MemoryScope;
    type?: string | undefined;
    tags?: string[] | undefined;
    priority?: string | undefined;
  }>;
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
      if (!input?.query) throw new Error('search_memory: query is required');
      const scope = input.scope ?? 'project-memory';
      const limit = Math.min(input.limit ?? 5, 20);
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

interface RelatedMemoryInput {
  text: string;
  scope?: MemoryScope | undefined;
  limit?: number | undefined;
}

export function relatedMemoryTool(memory: MemoryStore): Tool<RelatedMemoryInput, SearchMemoryOutput> {
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
      if (!input?.text) throw new Error('find_related_memories: text is required');
      const scope = input.scope ?? 'project-memory';
      const limit = Math.min(input.limit ?? 5, 20);
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
