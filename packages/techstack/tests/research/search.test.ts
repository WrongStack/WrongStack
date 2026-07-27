/**
 * Tests for TechStack ResearchSearch — web search adapter.
 *
 * Coverage targets:
 * - createToolSearch returns a search function
 * - search function with custom numResults
 * - search handles aborted signal
 * - search tool failure returns empty array
 * - search result mapping
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createToolSearch } from '../../src/research/search.js';
import type { ResearchSearch } from '../../src/research/types.js';

// ── Mock searchTool ─────────────────────────────────────────────────────

const mockExecute = vi.fn();

vi.mock('@wrongstack/tools', () => ({
  searchTool: {
    execute: (...args: unknown[]) => mockExecute(...args),
  },
}));

describe('createToolSearch', () => {
  beforeEach(() => {
    mockExecute.mockReset();
  });

  it('returns a function', () => {
    const search = createToolSearch();
    expect(typeof search).toBe('function');
  });

  it('calls searchTool with provided query and default numResults', async () => {
    mockExecute.mockResolvedValue({ results: [] });
    const search = createToolSearch();

    await search('test query', {} as Parameters<ResearchSearch>[1]);

    expect(mockExecute).toHaveBeenCalledTimes(1);
    const callArg = mockExecute.mock.calls[0]![0]!;
    expect(callArg).toMatchObject({ query: 'test query', num_results: 5 });
  });

  it('passes numResults from options', async () => {
    mockExecute.mockResolvedValue({ results: [] });
    const search = createToolSearch({ numResults: 3 });

    await search('query', {} as Parameters<ResearchSearch>[1]);

    const callArg = mockExecute.mock.calls[0]![0]!;
    expect(callArg).toMatchObject({ query: 'query', num_results: 3 });
  });

  it('passes source when provided', async () => {
    mockExecute.mockResolvedValue({ results: [] });
    const search = createToolSearch({ source: 'duckduckgo' });

    await search('query', {} as Parameters<ResearchSearch>[1]);

    const callArg = mockExecute.mock.calls[0]![0]!;
    expect(callArg).toMatchObject({ query: 'query', source: 'duckduckgo' });
  });

  it('maps search results to ResearchSearchResult format', async () => {
    mockExecute.mockResolvedValue({
      results: [
        { title: 'React Docs', url: 'https://react.dev', snippet: 'React library' },
        { title: 'Vue Guide', url: 'https://vuejs.org', snippet: 'Vue framework' },
      ],
    });
    const search = createToolSearch();

    const results = await search('frontend frameworks', {} as Parameters<ResearchSearch>[1]);

    expect(results).toEqual([
      { title: 'React Docs', url: 'https://react.dev', snippet: 'React library' },
      { title: 'Vue Guide', url: 'https://vuejs.org', snippet: 'Vue framework' },
    ]);
  });

  it('returns empty array when searchTool throws', async () => {
    mockExecute.mockRejectedValue(new Error('search failed'));
    const search = createToolSearch();

    const results = await search('query', {} as Parameters<ResearchSearch>[1]);

    expect(results).toEqual([]);
  });

  it('returns empty array when signal is already aborted', async () => {
    const search = createToolSearch();
    const controller = new AbortController();
    controller.abort();

    const results = await search('query', { signal: controller.signal });

    expect(results).toEqual([]);
    expect(mockExecute).not.toHaveBeenCalled();
  });
});
