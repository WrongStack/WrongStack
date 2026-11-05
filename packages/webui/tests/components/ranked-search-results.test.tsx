import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RankedSearchResults } from '../../src/components/MemoryManager/RankedSearchResults.js';
import type { SharedMemorySearch } from '../../src/components/MemoryManager/sharedSearch.js';

function shared(overrides: Partial<SharedMemorySearch> = {}): SharedMemorySearch {
  return {
    query: 'alpha',
    setQuery: vi.fn(),
    statusFilter: 'all',
    setStatusFilter: vi.fn(),
    kindFilter: 'all',
    setKindFilter: vi.fn(),
    navigateToSage: vi.fn(),
    ...overrides,
  };
}
function respond(hits: Array<Record<string, unknown>>, nextCursor: string | null = null) {
  return new Response(
    JSON.stringify({
      hits,
      count: hits.length,
      totalCandidates: 3,
      nextCursor,
      rankingApplied: 'hybrid',
      matchChannel: 'fts',
    }),
    { status: 200 },
  );
}
const one = {
  id: 'sage-1',
  text: 'Alpha decision',
  kind: 'decision',
  status: 'active',
  scope: 'project',
  score: 0.81,
  bm25: -3.2,
  matchReason: 'lexical',
};
const two = { ...one, id: 'sage-2', text: 'Alpha convention', kind: 'convention', score: 0.72 };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ranked SAGE discovery', () => {
  it('shows provenance, paginates via a bound cursor and opens the exact ID', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(respond([one], 'cursor-one'))
      .mockResolvedValueOnce(respond([two]));
    vi.stubGlobal('fetch', fetcher);
    const onOpen = vi.fn();
    render(
      <RankedSearchResults
        search={shared()}
        tagFilter={null}
        audienceOnly={false}
        onOpen={onOpen}
      />,
    );
    await screen.findByText('Alpha decision');
    // The result names its kind and status; the scores stay in the tooltip.
    expect(screen.getByTitle('lexical · rank 0.810 · lexical BM25 -3.200').textContent).toBe(
      'Decision · active',
    );
    fireEvent.click(screen.getByRole('button', { name: /Alpha decision/ }));
    expect(onOpen).toHaveBeenCalledWith('sage-1');
    fireEvent.click(screen.getByRole('button', { name: 'Load more ranked results' }));
    await screen.findByText('Alpha convention');
    expect(screen.getByText('Alpha decision')).toBeTruthy();
    const next = String(fetcher.mock.calls[1]![0]);
    expect(next).toContain('cursor=cursor-one');
    expect(next).toContain('q=alpha');
    expect(screen.queryByRole('button', { name: 'Load more ranked results' })).toBeNull();
  });

  it('sends status and kind filters to the server and resets paging on change', async () => {
    const fetcher = vi.fn().mockResolvedValue(respond([one], 'cursor-one'));
    vi.stubGlobal('fetch', fetcher);
    const { rerender } = render(
      <RankedSearchResults
        search={shared()}
        tagFilter={null}
        audienceOnly={false}
        onOpen={vi.fn()}
      />,
    );
    await screen.findByText('Alpha decision');
    rerender(
      <RankedSearchResults
        search={shared({ statusFilter: 'stale', kindFilter: 'decision' })}
        tagFilter={null}
        audienceOnly={false}
        onOpen={vi.fn()}
      />,
    );
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(String(fetcher.mock.calls[1]![0])).toContain('status=stale');
    expect(String(fetcher.mock.calls[1]![0])).toContain('kind=decision');
    expect(String(fetcher.mock.calls[1]![0])).not.toContain('cursor=');
  });

  it('does not falsely apply unsupported tag/audience filters to a ranked page', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    render(
      <RankedSearchResults
        search={shared()}
        tagFilter="private"
        audienceOnly={false}
        onOpen={vi.fn()}
      />,
    );
    expect((await screen.findByRole('status')).textContent).toContain('library only');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
