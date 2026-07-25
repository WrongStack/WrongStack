/**
 * Tests for TechStack ResearchSearch — web search adapter.
 *
 * Coverage targets:
 * - createToolSearch returns a search function
 * - search function calls the searchTool with provided query
 * - search handles empty results gracefully
 */
import { describe, expect, it, vi } from 'vitest';
import { createToolSearch } from '../../src/research/search.js';
import type { Context } from '@wrongstack/core/agent';

describe('createToolSearch', () => {
  it('returns a function', () => {
    const search = createToolSearch();
    expect(typeof search).toBe('function');
  });

  it('returns a function that resolves to an array', async () => {
    const search = createToolSearch();
    const context = { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as unknown as Context;
    const results = await search('test query', context);
    expect(Array.isArray(results)).toBe(true);
  });

  it('handles empty queries gracefully', async () => {
    const search = createToolSearch();
    const context = { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as unknown as Context;
    const results = await search('', context);
    expect(Array.isArray(results)).toBe(true);
  });
});
