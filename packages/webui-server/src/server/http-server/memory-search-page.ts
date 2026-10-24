import type * as http from 'node:http';
import type { MemoryPort } from '@wrongstack/contracts/types';
import {
  getSageService,
  InvalidSearchCursorError,
  type SageKind,
  type SageScope,
  type SearchRanking,
} from '@wrongstack/sage';

const RANKINGS = new Set<SearchRanking>(['relevance', 'recency', 'importance', 'hybrid']);
const SCOPES = new Set<SageScope>(['project', 'user', 'file', 'symbol']);
const PARAMS = new Set(['q', 'limit', 'cursor', 'kind', 'scope', 'status', 'ranking']);

/** Ranked SAGE pages are separate from the recency-ordered library list. */
export async function handleMemorySearchPage(
  res: http.ServerResponse,
  url: URL,
  getStore: () => MemoryPort | undefined,
): Promise<void> {
  const respond = (status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  for (const key of url.searchParams.keys()) {
    if (!PARAMS.has(key)) {
      respond(400, { error: `Unsupported search parameter: ${key}` });
      return;
    }
  }
  const text = url.searchParams.get('q')?.trim() ?? '';
  const cursor = url.searchParams.get('cursor');
  const kind = url.searchParams.get('kind');
  const scope = url.searchParams.get('scope');
  const status = url.searchParams.get('status');
  const ranking = url.searchParams.get('ranking') ?? 'hybrid';
  const rawLimit = url.searchParams.get('limit');
  const limit = rawLimit === null ? 20 : Number(rawLimit);
  if (
    !text ||
    text.length > 1000 ||
    (cursor !== null && !cursor) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 50 ||
    (kind !== null && !/^[a-z_]{1,80}$/.test(kind)) ||
    (scope !== null && !SCOPES.has(scope as SageScope)) ||
    (status !== null && status !== 'active' && status !== 'stale') ||
    !RANKINGS.has(ranking as SearchRanking)
  ) {
    respond(400, { error: 'Invalid search query or filter' });
    return;
  }
  const store = getStore();
  const sage = store && getSageService(store);
  if (!sage) {
    respond(503, { error: 'SAGE search unavailable' });
    return;
  }
  try {
    const result = await sage.unifiedSearchService(
      {
        text,
        ...(kind ? { kinds: [kind as SageKind] } : {}),
        ...(scope ? { scopes: [scope as SageScope] } : {}),
        ...(cursor ? { cursor } : {}),
      },
      {
        limit,
        ranking: ranking as SearchRanking,
        includeStatuses: status ? [status] : ['active', 'stale'],
        excludeSessionScoped: true,
        suggest: 'never',
      },
    );
    respond(200, {
      hits: result.hits,
      count: result.hits.length,
      totalCandidates: result.totalCandidates,
      nextCursor: result.nextCursor ?? null,
      rankingApplied: result.rankingApplied,
      matchChannel: result.matchChannel,
    });
  } catch (error) {
    if (error instanceof InvalidSearchCursorError) {
      respond(400, { error: 'Invalid or mismatched search cursor', code: 'INVALID_SEARCH_CURSOR' });
    } else {
      respond(500, { error: 'SAGE search failed' });
    }
  }
}
