/**
 * @vitest-environment jsdom
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SurfaceHostProvider } from '../src/host.js';
import { RankedSearchResults } from '../src/sage/RankedSearchResults.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makePage(text: string, nextCursor: string | null) {
  return new Response(
    JSON.stringify({
      hits: [
        {
          id: `id-${text}`,
          text,
          kind: 'decision',
          status: 'active',
          scope: 'project',
          score: 0.9,
          matchReason: 'lexical',
        },
      ],
      count: 1,
      totalCandidates: 2,
      nextCursor,
      rankingApplied: 'hybrid',
      matchChannel: 'fts',
    }),
    { status: 200 },
  );
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
  }
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
});

describe('RankedSearchResults loadMore reset on query/filter change', () => {
  it('clears loadingMore when query changes while pagination is in flight', async () => {
    const alphaPage2 = deferred<Response>();
    let betaPage2Calls = 0;

    const host = {
      useScrollRestore: () => ({ current: null }),
      fetch: async (url: string) => {
        if (url.includes('q=alpha') && !url.includes('cursor='))
          return makePage('Alpha 1', 'cur-a');
        if (url.includes('q=alpha') && url.includes('cursor=cur-a')) return alphaPage2.promise;
        if (url.includes('q=beta') && !url.includes('cursor=')) return makePage('Beta 1', 'cur-b');
        if (url.includes('q=beta') && url.includes('cursor=cur-b')) {
          betaPage2Calls += 1;
          return makePage('Beta 2', null);
        }
        throw new Error(`Unexpected URL: ${url}`);
      },
    } as never;

    const searchFor = (query: string) => ({
      query,
      setQuery: () => {},
      statusFilter: 'all' as const,
      setStatusFilter: () => {},
      kindFilter: 'all' as const,
      setKindFilter: () => {},
      navigateToSage: () => {},
    });

    await act(async () => {
      root!.render(
        <SurfaceHostProvider host={host}>
          <RankedSearchResults
            search={searchFor('alpha')}
            tagFilter={null}
            audienceOnly={false}
            onOpen={() => {}}
          />
        </SurfaceHostProvider>,
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(180);
    });

    const alphaBtn = Array.from(container!.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('loadMoreRanked'),
    ) as HTMLButtonElement;
    expect(alphaBtn).toBeDefined();
    expect(alphaBtn.disabled).toBe(false);

    await act(async () => {
      alphaBtn.click();
    });

    await act(async () => {
      root!.render(
        <SurfaceHostProvider host={host}>
          <RankedSearchResults
            search={searchFor('beta')}
            tagFilter={null}
            audienceOnly={false}
            onOpen={() => {}}
          />
        </SurfaceHostProvider>,
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(180);
      alphaPage2.reject(new DOMException('Aborted', 'AbortError'));
    });

    const betaBtn = Array.from(container!.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('loadMoreRanked'),
    ) as HTMLButtonElement;
    expect(betaBtn).toBeDefined();
    expect(betaBtn.disabled).toBe(false);

    await act(async () => {
      betaBtn.click();
    });
    expect(betaPage2Calls).toBe(1);
    expect(container!.textContent).toContain('Beta 2');
  });
});
