/**
 * Coverage for techstack/src/research/search.ts
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createToolSearch } from '../../src/research/search.js';

// Mock the searchTool to avoid actual web requests
vi.mock('@wrongstack/tools', () => ({
  searchTool: {
    execute: vi.fn(),
  },
}));

import { searchTool } from '@wrongstack/tools';

function searchOutput(
  query: string,
  results: Array<{ title: string; url: string; snippet: string }> = [],
) {
  return {
    query,
    results,
    source: 'duckduckgo',
    truncated: false,
    cached: false,
  };
}

describe('createToolSearch', () => {
  beforeEach(() => {
    vi.mocked(searchTool.execute).mockReset();
  });

  it('returns empty array when signal is already aborted', async () => {
    const search = createToolSearch();
    const ac = new AbortController();
    ac.abort();
    const results = await search('test query', { signal: ac.signal });
    expect(results).toEqual([]);
    expect(searchTool.execute).not.toHaveBeenCalled();
  });

  it('maps search results to ResearchSearchResult', async () => {
    vi.mocked(searchTool.execute).mockResolvedValue(
      searchOutput('test', [
        { title: 'Result 1', url: 'https://example.com/1', snippet: 'Snippet 1' },
        { title: 'Result 2', url: 'https://example.com/2', snippet: 'Snippet 2' },
      ]),
    );
    const search = createToolSearch();
    const results = await search('test', { signal: new AbortController().signal });
    expect(results.length).toBe(2);
    expect(results[0]!.title).toBe('Result 1');
    expect(results[0]!.url).toBe('https://example.com/1');
    expect(results[0]!.snippet).toBe('Snippet 1');
  });

  it('returns empty array when search throws', async () => {
    vi.mocked(searchTool.execute).mockRejectedValue(new Error('Network error'));
    const search = createToolSearch();
    const results = await search('test', { signal: new AbortController().signal });
    expect(results).toEqual([]);
  });

  it('passes numResults option to searchTool', async () => {
    vi.mocked(searchTool.execute).mockResolvedValue(searchOutput('test'));
    const search = createToolSearch({ numResults: 10 });
    await search('test', { signal: new AbortController().signal });
    const callArgs = vi.mocked(searchTool.execute).mock.calls[0]![0] as unknown as Record<
      string,
      unknown
    >;
    expect(callArgs.num_results).toBe(10);
  });

  it('passes default numResults of 5', async () => {
    vi.mocked(searchTool.execute).mockResolvedValue(searchOutput('test'));
    const search = createToolSearch();
    await search('test', { signal: new AbortController().signal });
    const callArgs = vi.mocked(searchTool.execute).mock.calls[0]![0] as unknown as Record<
      string,
      unknown
    >;
    expect(callArgs.num_results).toBe(5);
  });

  it('passes source option when provided', async () => {
    vi.mocked(searchTool.execute).mockResolvedValue(searchOutput('test'));
    const search = createToolSearch({ source: 'google' });
    await search('test', { signal: new AbortController().signal });
    const callArgs = vi.mocked(searchTool.execute).mock.calls[0]![0] as unknown as Record<
      string,
      unknown
    >;
    expect(callArgs.source).toBe('google');
  });

  it('does not include source when not provided', async () => {
    vi.mocked(searchTool.execute).mockResolvedValue(searchOutput('test'));
    const search = createToolSearch();
    await search('test', { signal: new AbortController().signal });
    const callArgs = vi.mocked(searchTool.execute).mock.calls[0]![0] as unknown as Record<
      string,
      unknown
    >;
    expect(callArgs.source).toBeUndefined();
  });

  it('passes the query to searchTool', async () => {
    vi.mocked(searchTool.execute).mockResolvedValue(searchOutput('react hooks'));
    const search = createToolSearch();
    await search('react hooks', { signal: new AbortController().signal });
    const callArgs = vi.mocked(searchTool.execute).mock.calls[0]![0] as unknown as Record<
      string,
      unknown
    >;
    expect(callArgs.query).toBe('react hooks');
  });

  it('handles empty results from searchTool', async () => {
    vi.mocked(searchTool.execute).mockResolvedValue(searchOutput('test'));
    const search = createToolSearch();
    const results = await search('test', { signal: new AbortController().signal });
    expect(results).toEqual([]);
  });
});
