/**
 * Narrow adapter that bridges the resolved SAGE `MemoryPort` to the
 * `DomainGlossary` shape the prompt builder consumes.
 *
 * Background
 * ----------
 * The agent system prompt wants a compact `[Project Jargon Dictionary]`
 * block listing only the project's `domain-term`-tagged memories. The
 * block must come from SAGE so the same single-owner-of-SQLite invariant
 * holds (per `packages/sage/docs/direct-icp-usage.md`). But the prompt
 * builder runs **before** any per-turn SAGE middleware has filtered the
 * corpus — so we can't simply hand it the legacy `MemoryStore` and ask
 * it to call `list()`. That would scan every memory on every prompt
 * build, which is exactly what the glossary block was supposed to
 * avoid.
 *
 * Instead, we ask SAGE for rows the `domain-term` query matches using the
 * typed `SageServiceLike.searchSage({ query: 'domain-term', limit })` op
 * (an FTS keyword match over text+tags+audience — NOT a tag filter), keep
 * only rows that actually carry the `domain-term` tag, then map the
 * resulting `Sage[]` into the canonical `MemoryEntry` shape that
 * `renderDomainGlossary` in `packages/core/src/core/system-prompt-glossary.ts`
 * is typed against.
 *
 * Architectural rule
 * ------------------
 * This module imports from `@wrongstack/sage` directly — **never** from
 * `@wrongstack/sage-mcp`. The CLI is an in-process consumer; the MCP
 * surface is reserved for out-of-process clients (Claude Desktop, other
 * agent runtimes).
 */
import type { MemoryEntry, MemoryPort } from '@wrongstack/contracts/types';
import { getSageService } from '@wrongstack/sage';

/** Default number of rows scanned when the caller passes no limit. */
const DOMAIN_GLOSSARY_LIMIT = 16;
/**
 * Upper bound honored from the caller's limit. `searchSage` is an FTS keyword
 * match over text+tags+audience — NOT a tag filter — so untagged memories
 * that merely text-match the query compete with tagged entries for the SQL
 * LIMIT. The renderer asks for 200 rows and tag-filters afterwards; clamping
 * that request to 16 here let untagged text matches crowd every tagged
 * entry out of the cap (proven: 30 untagged "domain term" notes hid all 3
 * live glossary entries).
 */
const DOMAIN_GLOSSARY_MAX_SCAN = 200;
/** Tag every glossary entry carries — mirrors renderDomainGlossary's filter. */
const DOMAIN_TERM_TAG = 'domain-term';

/**
 * Narrow `MemoryEntry`-shaped list provider for the `[Project Jargon Dictionary]`
 * block. Returns only `domain-term`-tagged SAGE memories, mapped to the
 * canonical `MemoryEntry` shape `renderDomainGlossary` is typed against.
 *
 * Robustness contract:
 * - If the port is the legacy `LegacyMemoryPortAdapter` (no SAGE
 *   capability), the helper returns an empty glossary rather than
 *   throwing — the prompt must still assemble.
 * - If `searchSage` rejects, the wrapper returns an empty glossary
 *   for this prompt build; SAGE itself remains the source of truth and
 *   the next prompt retry can succeed.
 */
export interface DomainGlossaryListProvider {
  list(scope: 'project-memory', limit?: number): Promise<ReadonlyArray<MemoryEntry>>;
}

/**
 * Build a `DomainGlossaryListProvider` over a SAGE-aware `MemoryPort`.
 *
 * The mapping is honest: every `MemoryEntry` field that core will read
 * (`text`, `tags`, `confidence`, `ts`, `priority`) is populated from the
 * corresponding `Sage` field. `text` is preserved verbatim because
 * `SageDomainTermExtractor` writes the canonical `"Term — Definition"`
 * format that `parseTermEntry` in core splits back apart.
 */
export function createDomainGlossaryAdapter(memoryStore: MemoryPort): DomainGlossaryListProvider {
  return {
    async list(scope, limit) {
      try {
        const service = getSageService(memoryStore);
        if (!service) return [];
        if (scope !== 'project-memory') return [];
        const effectiveLimit = Math.min(
          Math.max(1, limit ?? DOMAIN_GLOSSARY_LIMIT),
          DOMAIN_GLOSSARY_MAX_SCAN,
        );
        const hits = await service.searchSage('domain-term', { limit: effectiveLimit });
        return hits
          .filter((hit) => Array.isArray(hit.tags) && hit.tags.includes(DOMAIN_TERM_TAG))
          .map((hit) => sageToGlossaryEntry(hit));
      } catch {
        // Swallow: a single failed glossary lookup must not abort prompt
        // assembly. SAGE will retry on the next build.
        return [];
      }
    },
  };
}

/** Map a SAGE `Sage` to the `MemoryEntry` shape `renderDomainGlossary` reads. */
function sageToGlossaryEntry(sage: {
  text: string;
  tags: readonly string[];
  importance: number;
  confidence: number;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt?: string | undefined;
}): MemoryEntry {
  const priority: MemoryEntry['priority'] =
    sage.importance >= 0.9
      ? 'critical'
      : sage.importance >= 0.75
        ? 'high'
        : sage.importance >= 0.4
          ? 'medium'
          : 'low';
  return {
    scope: 'project-memory',
    text: sage.text,
    ts: sage.updatedAt || sage.createdAt,
    type: 'reference',
    tags: sage.tags.slice(),
    priority,
    confidence: sage.confidence,
    lastAccessed: sage.lastAccessedAt,
  };
}
