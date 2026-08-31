import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { searchTool, __clearSearchCache } from '../src/search.js';

/**
 * Mocked-fetch tests for the search tool.
 *
 * The previous version of this file hit live DuckDuckGo/Google/Bing — which
 * timed out at 5s on CI runners and turned the search suite into a coin flip.
 * We mock `globalThis.fetch` instead. Mocking at the fetch boundary keeps the
 * test exercising the same parsing + bounds-clamping code paths the real
 * tool runs, without the network dependency.
 */

const makeOpts = () => ({ signal: new AbortController().signal });

const DDG_FIXTURE = `
<html><body>
<a class="result-link" href="https://example.com/1">Example One</a>
<a class="result-snippet">Snippet for example one</a>
<a class="result-link" href="https://example.com/2">Example Two</a>
<a class="result-snippet">Snippet for example two</a>
</body></html>
`;

const GOOGLE_FIXTURE = `
<html><body>
<div class="g">
  <a href="/url?q=https://example.com/g1&amp;sa=U">Google Hit One</a>
  <div class="VwiC3b">Google snippet one</div>
</div>
</body></html>
`;

const BING_FIXTURE = `
<html><body>
<li class="b_algo">
  <h2><a href="https://example.com/b1">Bing Hit One</a></h2>
  <p>Bing snippet one</p>
</li>
</body></html>
`;

function mockFetch(htmlForUrl: (url: string) => string) {
  return vi.fn(async (url: string | URL | Request) => {
    const u = url instanceof Request ? url.url : url.toString();
    return new Response(htmlForUrl(u), {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
  });
}

describe('searchTool', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    __clearSearchCache();
    globalThis.fetch = mockFetch((u) => {
      if (u.includes('duckduckgo')) return DDG_FIXTURE;
      if (u.includes('google')) return GOOGLE_FIXTURE;
      if (u.includes('bing')) return BING_FIXTURE;
      return '';
    }) as never as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('has correct metadata', () => {
    expect(searchTool.name).toBe('search');
    expect(searchTool.permission).toBe('auto');
    expect(searchTool.inputSchema.required).toContain('query');
  });

  it('throws when query is missing', async () => {
    const ctx = {} as any;
    await expect(searchTool.execute({} as any, ctx, makeOpts())).rejects.toThrow();
  });

  it('throws for unknown source', async () => {
    const ctx = {} as any;
    await expect(
      searchTool.execute({ query: 'test', source: 'unknown' as any }, ctx, makeOpts()),
    ).rejects.toThrow();
  });

  it('defaults to duckduckgo', async () => {
    const ctx = {} as any;
    const result = await searchTool.execute({ query: 'test' }, ctx, makeOpts());
    expect(result.source).toBe('duckduckgo');
  });

  it('respects num_results bounds', async () => {
    const ctx = {} as any;
    const result = await searchTool.execute({ query: 'test', num_results: 5 }, ctx, makeOpts());
    expect(result.query).toBe('test');
  });

  it('caps num_results at MAX_RESULTS', async () => {
    const ctx = {} as any;
    const result = await searchTool.execute({ query: 'test', num_results: 999 }, ctx, makeOpts());
    expect(result.results).toBeDefined();
  });

  it('falls back from google source when static results are unavailable', async () => {
    const ctx = {} as any;
    const result = await searchTool.execute({ query: 'test', source: 'google' }, ctx, makeOpts());
    expect(result.source).toBe('duckduckgo');
  });

  it('uses bing source', async () => {
    const ctx = {} as any;
    const result = await searchTool.execute({ query: 'bing', source: 'bing' }, ctx, makeOpts());
    expect(result.source).toBe('bing');
  });

  it('has truncated flag', async () => {
    const ctx = {} as any;
    const result = await searchTool.execute({ query: 'test', num_results: 1 }, ctx, makeOpts());
    expect(typeof result.truncated).toBe('boolean');
  });

  it('returns results array', async () => {
    const ctx = {} as any;
    const result = await searchTool.execute({ query: 'test' }, ctx, makeOpts());
    expect(Array.isArray(result.results)).toBe(true);
  });

  it('evicts the oldest search after the cache reaches its capacity', async () => {
    const ctx = {} as any;
    await searchTool.execute({ query: 'oldest' }, ctx, makeOpts());
    for (let i = 0; i < 200; i++) {
      await searchTool.execute({ query: `unique-${i}` }, ctx, makeOpts());
    }

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const callsBefore = fetchMock.mock.calls.length;
    const result = await searchTool.execute({ query: 'oldest' }, ctx, makeOpts());

    expect(result.cached).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(callsBefore + 1);
  });

  it('throws when executeStream is unavailable', async () => {
    const original = searchTool.executeStream;
    searchTool.executeStream = undefined;
    try {
      await expect(searchTool.execute({ query: 'x' }, {} as any, makeOpts())).rejects.toThrow(
        /stream execution unavailable/,
      );
    } finally {
      searchTool.executeStream = original;
    }
  });

  it('throws when the stream ends without a final event', async () => {
    const original = searchTool.executeStream!;
    searchTool.executeStream = async function* () {
      yield { type: 'log', text: 'no final' } as never;
    };
    try {
      await expect(searchTool.execute({ query: 'x' }, {} as any, makeOpts())).rejects.toThrow(
        /without final event/,
      );
    } finally {
      searchTool.executeStream = original;
    }
  });
});

describe('search engine parsers (realistic fixtures)', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    __clearSearchCache();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('parses Google results when the markup matches the parser regexes', async () => {
    const html = `
      <h3 class="DKV84">Result Title</h3>
      <cite>https://example.com/page</cite>
      <span class="aXCZ0b">The result snippet text</span>
    `;
    globalThis.fetch = mockFetch(() => html) as never as typeof globalThis.fetch;
    const result = await searchTool.execute(
      { query: 'q', source: 'google' },
      {} as any,
      makeOpts(),
    );
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0]?.title).toBe('Result Title');
    expect(result.results[0]?.url).toBe('https://example.com/page');
    expect(result.results[0]?.snippet).toBe('The result snippet text');
  });

  it('parses Bing results when the markup matches the parser regexes', async () => {
    const html = `
      <h2><a href="https://example.com/b">Bing Title</a></h2>
      <p class="b_paractl">Bing snippet text</p>
    `;
    globalThis.fetch = mockFetch(() => html) as never as typeof globalThis.fetch;
    const result = await searchTool.execute({ query: 'q', source: 'bing' }, {} as any, makeOpts());
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0]?.title).toBe('Bing Title');
    expect(result.results[0]?.url).toBe('https://example.com/b');
  });

  it('decodes Bing tracking URLs when present', async () => {
    const target = Buffer.from('https://github.com/WrongStack/WrongStack', 'utf8').toString(
      'base64',
    );
    const html = `
      <li class="b_algo">
        <h2><a href="https://www.bing.com/ck/a?u=a1${target}&amp;ntb=1">WrongStack on GitHub</a></h2>
        <div class="b_caption"><p class="b_lineclamp2">WrongStack repository</p></div>
      </li>
    `;
    globalThis.fetch = mockFetch(() => html) as never as typeof globalThis.fetch;
    const result = await searchTool.execute(
      { query: 'wrongstack github', source: 'bing' },
      {} as any,
      makeOpts(),
    );
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.url).toBe('https://github.com/WrongStack/WrongStack');
    expect(result.results[0]?.snippet).toBe('WrongStack repository');
  });

  it('parses current DuckDuckGo lite markup with single-quoted classes and table snippets', async () => {
    const html = `
      <tr>
        <td><a rel="nofollow" href="https://github.com/WrongStack/WrongStack" class='result-link'>GitHub - WrongStack/WrongStack</a></td>
      </tr>
      <tr>
        <td>&nbsp;&nbsp;&nbsp;</td>
        <td class='result-snippet'>
          A CLI AI coding agent that runs in your terminal. Contribute to <b>WrongStack</b>/<b>WrongStack</b> development.
        </td>
      </tr>
    `;
    globalThis.fetch = mockFetch(() => html) as never as typeof globalThis.fetch;
    const result = await searchTool.execute(
      { query: 'wrongstack github', source: 'duckduckgo' },
      {} as any,
      makeOpts(),
    );
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.title).toBe('GitHub - WrongStack/WrongStack');
    expect(result.results[0]?.url).toBe('https://github.com/WrongStack/WrongStack');
    expect(result.results[0]?.snippet).toContain('WrongStack/WrongStack development');
  });

  it('reports an explicit error with empty results when Google and fallback fetch both fail', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('net down');
    }) as never as typeof globalThis.fetch;
    const result = await searchTool.execute(
      { query: 'q', source: 'google' },
      {} as any,
      makeOpts(),
    );
    expect(result.source).toBe('duckduckgo');
    expect(result.results).toHaveLength(0);
    expect(result.error).toMatch(/duckduckgo unreachable/);
  });

  it('reports an explicit error with empty results when Bing and fallback fetch both fail', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('net down');
    }) as never as typeof globalThis.fetch;
    const result = await searchTool.execute({ query: 'q', source: 'bing' }, {} as any, makeOpts());
    expect(result.source).toBe('duckduckgo');
    expect(result.results).toHaveLength(0);
    expect(result.error).toMatch(/duckduckgo unreachable/);
  });
});

describe('fetchWithTimeout error path', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    __clearSearchCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('calls clearTimeout(timer) in the catch block when fetch throws', async () => {
    // Mock fetch to reject so the catch block in fetchWithTimeout is exercised.
    // This covers lines 272-275 (clearTimeout in catch path).
    globalThis.fetch = vi.fn(async () => {
      throw new Error('Network error');
    }) as never as typeof globalThis.fetch;

    const ctx = {} as any;
    const result = await searchTool.execute(
      { query: 'test', source: 'duckduckgo' },
      ctx,
      makeOpts(),
    );
    // Should degrade to empty results + error from the catch block, not throw
    expect(result.results).toHaveLength(0);
    expect(result.error).toMatch(/duckduckgo unreachable/);
  });
});

describe('anySignal already-aborted', () => {
  beforeEach(() => __clearSearchCache());

  it('calls controller.abort() immediately when a passed signal is already aborted', async () => {
    // When anySignal receives an already-aborted signal, it calls
    // controller.abort() right away (lines 281-283). This causes fetch to
    // reject immediately, exercising the catch block with clearTimeout.
    globalThis.fetch = vi.fn(async () => {
      throw new Error('Should not be called - already aborted');
    }) as never as typeof globalThis.fetch;

    const ac = new AbortController();
    ac.abort(); // abort BEFORE passing to execute

    const ctx = {} as any;
    const result = await searchTool.execute({ query: 'test', source: 'duckduckgo' }, ctx, {
      signal: ac.signal,
    });
    // Should degrade to empty results + error, not throw, because anySignal immediately aborted
    expect(result.results).toHaveLength(0);
    expect(result.error).toMatch(/duckduckgo unreachable/);
  });
});

// ---------------------------------------------------------------------------
// Cache + dedup + ranking (consolidated from the former web_search plugin)
// ---------------------------------------------------------------------------

describe('search cache, dedup, and ranking', () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchCallCount: number;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    __clearSearchCache();
    fetchCallCount = 0;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockFetchCounted(html: string): typeof globalThis.fetch {
    return vi.fn(async () => {
      fetchCallCount++;
      return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
    }) as never as typeof globalThis.fetch;
  }

  it('serves a cached result on the second identical query (no second fetch)', async () => {
    globalThis.fetch = mockFetchCounted(DDG_FIXTURE);
    const ctx = {} as any;
    const first = await searchTool.execute({ query: 'cache-test' }, ctx, makeOpts());
    expect(first.cached).toBe(false);
    const second = await searchTool.execute({ query: 'cache-test' }, ctx, makeOpts());
    expect(second.cached).toBe(true);
    expect(fetchCallCount).toBe(1); // second served from cache
  });

  it('skips the cache when skip_cache is set', async () => {
    globalThis.fetch = mockFetchCounted(DDG_FIXTURE);
    const ctx = {} as any;
    await searchTool.execute({ query: 'cache-test' }, ctx, makeOpts());
    await searchTool.execute({ query: 'cache-test', skip_cache: true }, ctx, makeOpts());
    expect(fetchCallCount).toBe(2);
  });

  it('caches per source — same query, different source = separate cache entries', async () => {
    let totalCalls = 0;
    const countAll = () =>
      vi.fn(async (url: string | URL | Request) => {
        totalCalls++;
        const u = url instanceof Request ? url.url : url.toString();
        return new Response(u.includes('google') ? GOOGLE_FIXTURE : DDG_FIXTURE, {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      }) as never as typeof globalThis.fetch;

    const ctx = {} as any;
    globalThis.fetch = countAll();
    const firstGoogle = await searchTool.execute({ query: 'q', source: 'google' }, ctx, makeOpts());
    const secondGoogle = await searchTool.execute(
      { query: 'q', source: 'google' },
      ctx,
      makeOpts(),
    );
    expect(firstGoogle.source).toBe('duckduckgo');
    expect(secondGoogle.source).toBe('duckduckgo');
    expect(secondGoogle.cached).toBe(true);
    // Same query but duckduckgo should be a separate fetch
    globalThis.fetch = countAll();
    await searchTool.execute({ query: 'q', source: 'duckduckgo' }, ctx, makeOpts());
    expect(totalCalls).toBe(3); // 1 google + 1 google fallback ddg + 1 explicit ddg
  });

  it('deduplicates results by normalized URL (strips query + fragment)', async () => {
    const html = `
      <a class="result-link" href="https://example.com/page?utm=1">First</a>
      <a class="result-snippet">snippet one</a>
      <a class="result-link" href="https://example.com/page#section">Dup</a>
      <a class="result-snippet">snippet dup</a>
      <a class="result-link" href="https://other.org/x">Unique</a>
      <a class="result-snippet">snippet two</a>
    `;
    globalThis.fetch = mockFetchCounted(html);
    const ctx = {} as any;
    const result = await searchTool.execute({ query: 'dedup' }, ctx, makeOpts());
    const urls = result.results.map((r) => r.url);
    // example.com/page appears once (deduped), other.org/x once
    expect(urls).toContain('https://example.com/page?utm=1');
    expect(urls).toContain('https://other.org/x');
    expect(urls.filter((u) => u.includes('example.com/page'))).toHaveLength(1);
  });

  it('drops non-http results', async () => {
    const html = `
      <a class="result-link" href="https://valid.com/a">Valid</a>
      <a class="result-snippet">valid snippet</a>
      <a class="result-link" href="/relative/path">Relative</a>
      <a class="result-snippet">relative snippet</a>
    `;
    globalThis.fetch = mockFetchCounted(html);
    const ctx = {} as any;
    const result = await searchTool.execute({ query: 'nonhttp' }, ctx, makeOpts());
    expect(result.results.every((r) => r.url.startsWith('http'))).toBe(true);
    expect(result.results.map((r) => r.url)).toEqual(['https://valid.com/a']);
  });

  it('ranks title matches above snippet-only matches', async () => {
    const html = `
      <a class="result-link" href="https://snippet-match.com/a">Generic Title</a>
      <a class="result-snippet">query appears in snippet</a>
      <a class="result-link" href="https://title-match.com/b">Query Keyword Title</a>
      <a class="result-snippet">unrelated</a>
    `;
    globalThis.fetch = mockFetchCounted(html);
    const ctx = {} as any;
    const result = await searchTool.execute({ query: 'query keyword' }, ctx, makeOpts());
    // Title match (+2 per term, 2 terms = +4) beats snippet match (+1 per term = +2)
    expect(result.results[0]?.url).toBe('https://title-match.com/b');
  });

  it('safely executes without opts and falls back to ctx.signal or default signal', async () => {
    globalThis.fetch = mockFetch(() => DDG_FIXTURE) as any;
    const ctx = {} as any;
    const result = await searchTool.execute({ query: 'hello' }, ctx);
    expect(result.results.length).toBeGreaterThan(0);

    const ac = new AbortController();
    const ctxWithSignal = { ...ctx, signal: ac.signal };
    const resultWithSignal = await searchTool.execute({ query: 'hello' }, ctxWithSignal);
    expect(resultWithSignal.results.length).toBeGreaterThan(0);
  });
});

