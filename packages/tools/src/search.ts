import { FetchError, ToolValidationError } from '@wrongstack/core/types';
import { expectDefined } from '@wrongstack/core/utils';
import type { Tool, ToolStreamEvent } from '@wrongstack/core/types';
import { guardedFetch } from './_fetch-guard.js';
import { toErrorMessage } from '@wrongstack/core/utils';

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  score: number;
}

interface CacheEntry {
  results: SearchResult[];
  source: string;
  timestamp: number;
}

interface SearchInput {
  query: string;
  num_results?: number | undefined;
  source?: 'duckduckgo' | 'google' | 'bing' | undefined;
  skip_cache?: boolean | undefined;
}

interface SearchOutput {
  query: string;
  results: { title: string; url: string; snippet: string }[];
  source: string;
  truncated: boolean;
  cached: boolean;
  /**
   * Present when the search engine could not be reached or returned an
   * unusable response. `results` is empty in that case — the failure is never
   * disguised as a synthetic result entry.
   */
  error?: string | undefined;
}

/** What an engine call yields: parsed results, or empty results + an error. */
interface EngineResult {
  results: SearchResult[];
  error?: string | undefined;
}

const DEFAULT_NUM = 10;
const MAX_RESULTS = 50;
/** Snippets are capped at parse time so one verbose result can't bloat output. */
const MAX_SNIPPET_CHARS = 300;
const TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 300_000; // 5 minutes — matches the former web-search plugin default
const CACHE_MAX_ENTRIES = 200;

// Module-level cache shared across calls within a single agent run. Keyed by
// `<source>:<query>`. This is intentionally process-local (not persisted) —
// it exists to avoid hammering a search engine when the model rephrases the
// same query a few turns apart.
const cache = new Map<string, CacheEntry>();

export const searchTool: Tool<SearchInput, SearchOutput> = {
  name: 'search',
  category: 'Search',
  description:
    'Perform a web search and return results with title, URL, and snippet. Use this when you need up-to-date external information that is not in the local codebase. Results are cached (5 min TTL) and deduplicated by URL. ' +
    'google and bing are best-effort HTML scrapes that fall back to duckduckgo when they return nothing usable.',
  usageHint:
    'Good for: API documentation, error messages, library usage examples, current best practices.\n\n' +
    '- Prefer specific queries over very broad ones.\n' +
    '- Results go through the guarded fetch system (same protections as the `fetch` tool).\n' +
    '- Supports duckduckgo (default), google, and bing sources.\n' +
    '- Set `skip_cache: true` to force a fresh search.\n' +
    '- This is often better than the model trying to recall outdated knowledge.',
  permission: 'auto',
  mutating: false,
  capabilities: ['net.outbound'],
  icon: 'search',
  timeoutMs: TIMEOUT_MS,
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      num_results: {
        type: 'integer',
        description: 'Number of results (1-50, default 10)',
        minimum: 1,
        maximum: MAX_RESULTS,
      },
      source: {
        type: 'string',
        enum: ['duckduckgo', 'google', 'bing'],
        description: 'Search engine to use (default: duckduckgo)',
      },
      skip_cache: {
        type: 'boolean',
        description: 'Skip the in-memory cache and force a fresh search (default: false)',
      },
    },
    required: ['query'],
  },
  async execute(input, ctx, opts) {
    let final: SearchOutput | undefined;
    const executeStream = searchTool.executeStream;
    if (!executeStream) throw new Error('searchTool: stream execution unavailable');
    for await (const ev of executeStream(input, ctx, opts)) {
      if (ev.type === 'final') final = ev.output;
    }
    if (!final) throw new Error('search: stream ended without final event');
    return final;
  },
  async *executeStream(input, ctx, opts): AsyncGenerator<ToolStreamEvent<SearchOutput>> {
    if (!input?.query || typeof input.query !== 'string' || input.query.trim() === '') {
      throw new ToolValidationError({
        message: 'search: query is required and must be a non-empty string',
        field: 'query',
      });
    }

    const signal = opts?.signal ?? ctx?.signal ?? new AbortController().signal;
    const rawNum =
      typeof input.num_results === 'number' && !Number.isNaN(input.num_results)
        ? input.num_results
        : DEFAULT_NUM;
    const num = Math.max(1, Math.min(Math.floor(rawNum), MAX_RESULTS));
    const VALID_SOURCES: ReadonlySet<string> = new Set(['duckduckgo', 'google', 'bing']);
    if (input.source !== undefined && !VALID_SOURCES.has(input.source)) {
      throw new ToolValidationError({
        message: `search: unknown source "${input.source}"`,
        field: 'source',
      });
    }
    const source = input.source ?? 'duckduckgo';
    const skipCache = input.skip_cache ?? false;
    const normalizedQuery = input.query.trim().toLowerCase().replace(/\s+/g, ' ');
    const cacheKey = `${source}:${normalizedQuery}`;

    // --- Cache hit ---
    if (!skipCache) {
      const entry = cache.get(cacheKey);
      if (entry && Date.now() - entry.timestamp < CACHE_TTL_MS) {
        const results = entry.results.map((r) => ({
          title: r.title,
          url: r.url,
          snippet: r.snippet,
        }));
        const finalResults = results.slice(0, num);
        yield {
          type: 'log',
          text: `Cache hit for "${input.query}" (${entry.source})`,
          data: { source: entry.source, query: input.query, cached: true },
        };
        yield {
          type: 'partial_output',
          text: `${finalResults.length} cached results from ${entry.source}`,
          data: { count: finalResults.length, cached: true, source: entry.source },
        };
        yield {
          type: 'final',
          output: {
            query: input.query,
            results: finalResults,
            source: entry.source,
            truncated: results.length > num,
            cached: true,
          },
        };
        return;
      }
    }

    yield {
      type: 'log',
      text: `Querying ${source} for "${input.query}"…`,
      data: { source, query: input.query, cached: false },
    };

    // Engines always parse up to MAX_RESULTS so the cached ranked list can be
    // sliced for any later num_results without going stale (a num=3 first call
    // used to pin the cache entry to 3 results for a subsequent num=50 call).
    let engine: EngineResult;
    let effectiveSource: SearchOutput['source'] = source;
    switch (source) {
      case 'duckduckgo':
        engine = await duckduckgoSearch(input.query, signal);
        break;
      case 'google':
        engine = await googleSearch(input.query, signal);
        break;
      case 'bing':
        engine = await bingSearch(input.query, signal);
        break;
      default:
        throw new ToolValidationError({
          message: `search: unknown source "${source}"`,
          field: 'source',
        });
    }

    let ranked = rankSearchResults(engine.results, input.query);
    let engineError = engine.error;
    if (source !== 'duckduckgo' && shouldFallbackToDuckDuckGo(ranked, input.query)) {
      yield {
        type: 'log',
        text: `${source} returned no relevant static results; falling back to duckduckgo`,
        data: { source, fallback: 'duckduckgo', query: input.query },
      };
      const fallback = await duckduckgoSearch(input.query, signal);
      ranked = rankSearchResults(fallback.results, input.query);
      engineError = fallback.error;
      effectiveSource = 'duckduckgo';
    }

    const finalResults = ranked.slice(0, num);

    // --- Store in cache (never cache a failed search) ---
    if (!engineError) {
      cache.set(cacheKey, { results: ranked, source: effectiveSource, timestamp: Date.now() });
      pruneCacheEntries();
    }

    yield {
      type: 'partial_output',
      text: engineError
        ? `search failed: ${engineError}`
        : `${finalResults.length} results from ${effectiveSource}`,
      data: { count: finalResults.length, cached: false, source: effectiveSource },
    };
    yield {
      type: 'final',
      output: {
        query: input.query,
        results: finalResults.map((r) => ({
          title: r.title,
          url: r.url,
          snippet: r.snippet,
        })),
        source: effectiveSource,
        truncated: ranked.length > num,
        cached: false,
        ...(engineError ? { error: engineError } : {}),
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------

/** Drop stale entries, then evict oldest insertions to cap retained result data. */
function pruneCacheEntries(): void {
  if (cache.size <= CACHE_MAX_ENTRIES) return;
  const cutoff = Date.now() - CACHE_TTL_MS * 2;
  for (const [key, entry] of cache.entries()) {
    if (entry.timestamp < cutoff) {
      cache.delete(key);
    }
  }
  if (cache.size > CACHE_MAX_ENTRIES) {
    for (const key of cache.keys()) {
      cache.delete(key);
      if (cache.size <= CACHE_MAX_ENTRIES) break;
    }
  }
}

/** Exposed for tests so they can reset the module-level cache between cases. */
export function __clearSearchCache(): void {
  cache.clear();
}

/** Exposed for tests so they can seed the module-level cache between cases. */
export function __setSearchCacheForTest(key: string, entry: CacheEntry): void {
  cache.set(key, entry);
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

function rankSearchResults(results: SearchResult[], query: string): SearchResult[] {
  const seenUrls = new Set<string>();
  const deduped: SearchResult[] = [];
  for (const r of results) {
    const noQuery = r.url.split('?')[0] ?? r.url;
    const normalized = noQuery.split('#')[0] ?? r.url;
    if (!seenUrls.has(normalized) && r.url.startsWith('http')) {
      seenUrls.add(normalized);
      deduped.push(r);
    }
  }
  return scoreResults(deduped, query);
}

function scoreResults(results: SearchResult[], query: string): SearchResult[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  return results
    .map((r) => {
      const titleLower = r.title.toLowerCase();
      const snippetLower = r.snippet.toLowerCase();
      let score = r.score;
      for (const term of terms) {
        if (titleLower.includes(term)) score += 2;
        if (snippetLower.includes(term)) score += 1;
      }
      return { ...r, score };
    })
    .sort((a, b) => b.score - a.score);
}

function shouldFallbackToDuckDuckGo(results: SearchResult[], query: string): boolean {
  if (results.length === 0) return true;
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 3);
  if (terms.length === 0) return false;
  return !results.some((r) => {
    const haystack = `${r.title} ${r.url} ${r.snippet}`.toLowerCase();
    return terms.some((term) => haystack.includes(term));
  });
}

// ---------------------------------------------------------------------------
// Search engines
// ---------------------------------------------------------------------------

async function duckduckgoSearch(query: string, signal: AbortSignal): Promise<EngineResult> {
  const encoded = encodeURIComponent(query);
  const url = `https://lite.duckduckgo.com/lite/?q=${encoded}&kd=-1&kl=wt-wt`;

  try {
    const response = await fetchWithTimeout(url, signal, TIMEOUT_MS);
    const html = await response.text();
    return { results: parseDuckDuckGo(html, MAX_RESULTS) };
  } catch (err) {
    console.log(
      JSON.stringify({ level: 'debug', event: 'search_failed', query, error: toErrorMessage(err) }),
    );
    // Surface the failure explicitly instead of fabricating a sentinel result
    // entry — callers see `error` on the output and an empty results array.
    return { results: [], error: `duckduckgo unreachable: ${toErrorMessage(err)}` };
  }
}

function takeFrom<T>(iter: Iterable<T>, max: number): T[] {
  const out: T[] = [];
  for (const item of iter) {
    if (out.length >= max) break;
    out.push(item);
  }
  return out;
}

function parseDuckDuckGo(html: string, num: number): SearchResult[] {
  const results: SearchResult[] = [];
  const linkRegex = /<a\b([^>]*\bclass=(["'])[^"']*\bresult-link\b[^"']*\2[^>]*)>([\s\S]*?)<\/a>/gi;
  const snippetRegex =
    /<([a-z0-9]+)\b([^>]*\bclass=(["'])[^"']*\bresult-snippet\b[^"']*\3[^>]*)>([\s\S]*?)<\/\1>/gi;

  const linkMatches = takeFrom(
    [...html.matchAll(linkRegex)]
      .map((m) => {
        const attrs = expectDefined(m[1]);
        const href = getHtmlAttr(attrs, 'href');
        const title = stripTags(expectDefined(m[3]));
        return href && title ? { url: normalizeDuckDuckGoUrl(href), title } : undefined;
      })
      .filter((m): m is { url: string; title: string } => m !== undefined),
    num,
  );

  const snippetMatches = takeFrom(
    [...html.matchAll(snippetRegex)].filter((m) => m[4]).map((m) => stripTags(expectDefined(m[4]))),
    num,
  );

  for (let i = 0; i < linkMatches.length && i < num; i++) {
    const entry = linkMatches[i];
    if (entry) {
      results.push({
        title: entry.title ?? '',
        url: entry.url ?? '',
        snippet: capSnippet(snippetMatches[i] ?? ''),
        score: 1,
      });
    }
  }

  return results;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getHtmlAttr(attrs: string, name: string): string | undefined {
  const escaped = escapeRegex(name);
  const quoted = new RegExp(`\\b${escaped}\\s*=\\s*(["'])(.*?)\\1`, 'i').exec(attrs);
  if (quoted?.[2]) return decodeHtmlEntities(quoted[2]);
  const unquoted = new RegExp(`\\b${escaped}\\s*=\\s*([^\\s>]+)`, 'i').exec(attrs);
  return unquoted?.[1] ? decodeHtmlEntities(unquoted[1]) : undefined;
}

function normalizeDuckDuckGoUrl(raw: string): string {
  if (raw.startsWith('//')) return `https:${raw}`;
  if (!raw.startsWith('/')) return raw;
  if (!raw.startsWith('/l/')) return raw;
  try {
    const url = new URL(raw, 'https://duckduckgo.com');
    const uddg = url.searchParams.get('uddg');
    return uddg?.startsWith('http') ? uddg : url.toString();
  } catch {
    return raw;
  }
}

async function googleSearch(query: string, signal: AbortSignal): Promise<EngineResult> {
  const encoded = encodeURIComponent(query);
  const url = `https://www.google.com/search?q=${encoded}&hl=en`;

  try {
    const html = await fetchWithTimeout(url, signal, TIMEOUT_MS).then((r) => r.text());
    return { results: parseGoogleResults(html, MAX_RESULTS) };
  } catch (err) {
    // Report the failure instead of silently parsing an empty string — the
    // caller's DDG fallback still runs, but the error is no longer swallowed.
    return { results: [], error: `google unreachable: ${toErrorMessage(err)}` };
  }
}

function parseGoogleResults(html: string, num: number): SearchResult[] {
  const results: SearchResult[] = [];
  const titleRegex = /<h3[^>]*class="[^"]*DKV84"[^>]*>([^<]+)<\/h3>/gi;
  const urlRegex = /<cite[^>]*>([^<]+)<\/cite>/gi;
  const snippetRegex = /<span[^>]*class="[^"]*aXCZ0b[^>]*>([^<]+)<\/span>/gi;

  const titles = takeFrom(
    [...html.matchAll(titleRegex)].filter((m) => m[1]).map((m) => stripTags(expectDefined(m[1]))),
    num,
  );

  const urls = takeFrom(
    [...html.matchAll(urlRegex)]
      .filter((m) => m[1])
      .map((m) => stripTags(expectDefined(m[1])).replace(/^\*(https?:\/\/[^\s]+).*$/, '$1'))
      .filter((u) => u.startsWith('http')),
    num,
  );

  const snippets = takeFrom(
    [...html.matchAll(snippetRegex)].filter((m) => m[1]).map((m) => stripTags(expectDefined(m[1]))),
    num,
  );

  for (let i = 0; i < Math.min(titles.length, num); i++) {
    results.push({
      title: titles[i] ?? '',
      url: urls[i] ?? '',
      snippet: capSnippet(snippets[i] ?? ''),
      score: 1,
    });
  }

  return results;
}

async function bingSearch(query: string, signal: AbortSignal): Promise<EngineResult> {
  const encoded = encodeURIComponent(query);
  const url = `https://www.bing.com/search?q=${encoded}`;

  try {
    const html = await fetchWithTimeout(url, signal, TIMEOUT_MS).then((r) => r.text());
    return { results: parseBingResults(html, MAX_RESULTS) };
  } catch (err) {
    // Report the failure instead of silently parsing an empty string — the
    // caller's DDG fallback still runs, but the error is no longer swallowed.
    return { results: [], error: `bing unreachable: ${toErrorMessage(err)}` };
  }
}

function parseBingResults(html: string, num: number): SearchResult[] {
  const results: SearchResult[] = [];
  const blocks = [
    ...html.matchAll(
      /<li\b[^>]*class=(["'])[^"']*\bb_algo\b[^"']*\1[^>]*>([\s\S]*?)(?=<li\b[^>]*class=(["'])[^"']*\bb_algo\b[^"']*\3|<\/ol>)/gi,
    ),
  ].map((m) => expectDefined(m[2]));
  const candidates = blocks.length > 0 ? blocks : [html];

  const entries = takeFrom(
    candidates.flatMap((block) => {
      const titleMatch = /<h2[^>]*>\s*<a\b([^>]*)>([\s\S]*?)<\/a>\s*<\/h2>/i.exec(block);
      if (!titleMatch) return [];
      const href = getHtmlAttr(expectDefined(titleMatch[1]), 'href');
      const title = stripTags(expectDefined(titleMatch[2]));
      if (!href || !title) return [];
      const snippetMatch =
        /<p\b[^>]*class=(["'])[^"']*\b(?:b_paractl|b_lineclamp\d*)\b[^"']*\1[^>]*>([\s\S]*?)<\/p>/i.exec(
          block,
        ) ?? /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(block);
      const snippet = snippetMatch ? capSnippet(stripTags(expectDefined(snippetMatch.at(-1)))) : '';
      return [{ url: normalizeBingUrl(href), title, snippet, score: 1 }];
    }),
    num,
  );

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry) {
      results.push({
        title: entry.title ?? '',
        url: entry.url ?? '',
        snippet: entry.snippet ?? '',
        score: 1,
      });
    }
  }

  return results;
}

function normalizeBingUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.hostname.endsWith('bing.com') && url.pathname.startsWith('/ck/')) {
      const encoded = url.searchParams.get('u');
      const decoded = decodeBingTarget(encoded);
      if (decoded?.startsWith('http')) return decoded;
    }
  } catch {
    // Fall through to the raw URL.
  }
  return raw;
}

function decodeBingTarget(encoded: string | null): string | undefined {
  if (!encoded) return undefined;
  const payload = encoded.startsWith('a1') ? encoded.slice(2) : encoded;
  try {
    const padded = payload
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(Math.ceil(payload.length / 4) * 4, '=');
    return Buffer.from(padded, 'base64').toString('utf8');
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

async function fetchWithTimeout(
  url: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const fetchSignal = anySignal(signal, controller.signal);
  try {
    // F-05: route through the SSRF-guarded fetch (private-IP blocking, HTTPS,
    // DNS-pinned dispatcher, per-hop redirect re-validation) instead of a bare
    // `fetch` with `redirect: 'follow'`. Search hosts are fixed/trusted, but
    // this closes the residual "engine 30x → internal address" redirect risk.
    const res = await guardedFetch(url, 5, fetchSignal, {
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
    clearTimeout(timer);
    return res;
  } catch (e) {
    clearTimeout(timer);
    if (e instanceof FetchError) {
      throw e;
    }
    throw new FetchError({
      message: `search: failed to fetch ${url}`,
      status: 0,
      context: { url },
      cause: e,
    });
  }
}

function anySignal(...signals: AbortSignal[]): AbortSignal {
  // Native combinator (Node ≥ 20.3; this repo requires ≥ 22). The previous
  // hand-rolled version registered a non-once 'abort' listener on every
  // input signal and never removed it — the run-level signal outlives each
  // request, so listeners (and their closures) accumulated one per search
  // call for the life of the agent run.
  return AbortSignal.any(signals);
}

function stripTags(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]+>/g, '')).trim();
}

function capSnippet(snippet: string): string {
  return snippet.length > MAX_SNIPPET_CHARS
    ? `${snippet.slice(0, MAX_SNIPPET_CHARS - 1)}…`
    : snippet;
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&ndash;/g, '–')
    .replace(/&mdash;/g, '—')
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&lsquo;|&rsquo;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => {
      try {
        return String.fromCodePoint(Number(code));
      } catch {
        return _;
      }
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      try {
        return String.fromCodePoint(parseInt(hex, 16));
      } catch {
        return _;
      }
    });
}
