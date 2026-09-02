import type { MemoryScope, MemoryStore, Tool } from '@wrongstack/core/types';

interface RememberInput {
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

export declare function rememberTool(memory: MemoryStore): Tool<RememberInput, RememberOutput>;
export declare function forgetTool(memory: MemoryStore): Tool<ForgetInput, ForgetOutput>;

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

export declare function searchMemoryTool(
  memory: MemoryStore,
): Tool<SearchMemoryInput, SearchMemoryOutput>;

interface RelatedMemoryInput {
  text: string;
  scope?: MemoryScope | undefined;
  limit?: number | undefined;
}

export declare function relatedMemoryTool(
  memory: MemoryStore,
): Tool<RelatedMemoryInput, SearchMemoryOutput>;
