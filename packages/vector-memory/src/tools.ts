/**
 * Vector memory tools — agent-facing surface for the vector store.
 *
 * The tools mirror sage's tool patterns:
 *  - reads (`vector_memory_search`, `vector_memory_stats`) → `permission: 'auto'`
 *  - writes (`vector_memory_remember`, `vector_memory_forget`) → `permission: 'confirm'`
 *
 * All tools accept the store directly so hosts can wire them however they
 * like — there's no implicit dependency on the sage runtime surface.
 */
import type { Tool } from '@wrongstack/core/types';

import type { VectorMemoryStore } from './store.js';

export function createVectorMemoryTools(store: VectorMemoryStore): Tool[] {
  return [
    vectorMemoryRememberTool(store),
    vectorMemorySearchTool(store),
    vectorMemoryStatsTool(store),
    vectorMemoryForgetTool(store),
  ];
}

interface RememberInput {
  text: string;
  summary?: string;
  tags?: string[];
  scope?: 'project' | 'user' | 'session';
  kind?: 'note' | 'fact' | 'summary' | 'snippet' | 'link';
  metadata?: Record<string, unknown>;
}

function vectorMemoryRememberTool(
  store: VectorMemoryStore,
): Tool<RememberInput, { id: string; hasVector: boolean }> {
  return {
    name: 'vector_memory_remember',
    category: 'Memory',
    description:
      'Persist a piece of knowledge into the local vector memory store. The text is embedded with the active embedding provider (transformers.js when available, otherwise the sage hashing provider). Returns the new entry id and whether an embedding was stored.',
    usageHint:
      'Store text you want to find later by *meaning*, not just exact keywords. ' +
      'Embeddings happen locally — no project text leaves the machine.',
    permission: 'confirm',
    mutating: true,
    riskTier: 'standard',
    timeoutMs: 5_000,
    capabilities: ['memory.write'],
    icon: 'settings',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', minLength: 1, description: 'The text to embed and store.' },
        summary: { type: 'string', description: 'Optional short label.' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional tags for later filtering.',
        },
        scope: {
          type: 'string',
          enum: ['project', 'user', 'session'],
          description: 'Visibility scope. Defaults to `project`.',
        },
        kind: {
          type: 'string',
          enum: ['note', 'fact', 'summary', 'snippet', 'link'],
          description: 'Entry kind. Defaults to `note`.',
        },
        metadata: {
          type: 'object',
          additionalProperties: true,
          description: 'Free-form metadata persisted as JSON.',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
    execute: async (input) => {
      const entry = await store.remember(input);
      return { id: entry.id, hasVector: entry.vector !== undefined };
    },
  };
}

interface SearchInput {
  query: string;
  limit?: number;
  threshold?: number;
  scope?: 'project' | 'user' | 'session';
  kind?: 'note' | 'fact' | 'summary' | 'snippet' | 'link';
}

interface SearchOutput {
  hits: Array<{
    id: string;
    score: number;
    text: string;
    summary?: string | undefined;
    tags: string[];
  }>;
}

function vectorMemorySearchTool(store: VectorMemoryStore): Tool<SearchInput, SearchOutput> {
  return {
    name: 'vector_memory_search',
    category: 'Memory',
    description:
      'Semantic search over the vector memory store. Embeds the query with the active provider and returns the top-k entries ranked by cosine similarity. Returns an empty list when the embedding provider is unavailable — callers should fall back to lexical search.',
    usageHint:
      'Use when you want results ranked by meaning. Pairs well with sage `memory_search` for keyword precision.',
    permission: 'auto',
    mutating: false,
    riskTier: 'safe',
    timeoutMs: 5_000,
    capabilities: ['memory.read'],
    icon: 'search',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, description: 'The natural-language query.' },
        limit: {
          type: 'number',
          minimum: 1,
          maximum: 100,
          description: 'Max results (default 10).',
        },
        threshold: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: 'Minimum cosine similarity. Results below the floor are dropped.',
        },
        scope: {
          type: 'string',
          enum: ['project', 'user', 'session'],
          description: 'Restrict to a scope.',
        },
        kind: {
          type: 'string',
          enum: ['note', 'fact', 'summary', 'snippet', 'link'],
          description: 'Restrict to a kind.',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    execute: async (input) => {
      const hits = await store.search(input.query, {
        limit: input.limit !== undefined ? input.limit : undefined,
        threshold: input.threshold !== undefined ? input.threshold : undefined,
        scope: input.scope,
        kind: input.kind,
      });
      return {
        hits: hits.map((h) => ({
          id: h.entry.id,
          score: h.score,
          text: h.entry.text,
          summary: h.entry.summary ?? undefined,
          tags: h.entry.tags,
        })),
      };
    },
  };
}

interface StatsInput {
  /** Reserved for future per-scope stats; kept for schema symmetry. */
  _scope?: never;
}

function vectorMemoryStatsTool(
  store: VectorMemoryStore,
): Tool<StatsInput, ReturnType<VectorMemoryStore['stats']>> {
  return {
    name: 'vector_memory_stats',
    category: 'Memory',
    description: 'Return counts, providers, and dimensions for the local vector memory store.',
    usageHint: 'Cheap diagnostic — safe to call any time.',
    permission: 'auto',
    mutating: false,
    riskTier: 'safe',
    timeoutMs: 1_000,
    capabilities: ['memory.read'],
    icon: 'search',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    execute: async () => store.stats(),
  };
}

interface ForgetInput {
  id: string;
}

interface ForgetOutput {
  removed: boolean;
}

function vectorMemoryForgetTool(store: VectorMemoryStore): Tool<ForgetInput, ForgetOutput> {
  return {
    name: 'vector_memory_forget',
    category: 'Memory',
    description: 'Remove an entry (and its vector) from the vector memory store.',
    usageHint:
      'Hard delete — no soft-delete tombstone. Use `vector_memory_search` to find the id first if you only have text.',
    permission: 'confirm',
    mutating: true,
    riskTier: 'standard',
    timeoutMs: 1_000,
    capabilities: ['memory.write'],
    icon: 'settings',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          minLength: 1,
          description: 'Entry id returned by `vector_memory_remember`.',
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
    execute: async (input) => ({ removed: await store.forget(input.id) }),
  };
}
