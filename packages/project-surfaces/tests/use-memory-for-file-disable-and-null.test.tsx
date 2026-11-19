/**
 * @vitest-environment jsdom
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SurfaceHostProvider } from '../src/host.js';
import { useMemoryForFile } from '../src/sage/useMemoryForFile.js';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root?.unmount();
    });
  }
  container?.remove();
  root = null;
  container = null;
});

describe('useMemoryForFile autoFetch disable reset and null payload guard', () => {
  it('clears loading and detaches subscription when autoFetch switches true -> false, and ignores null payloads', async () => {
    const listeners = new Map<string, Set<(msg: unknown) => void>>();
    let liveSubs = 0;
    const emit = (type: string, payload: unknown) => {
      for (const cb of [...(listeners.get(type) ?? [])]) cb({ type, payload });
    };
    const client = {
      on(type: string, fn: (msg: unknown) => void) {
        const set = listeners.get(type) ?? new Set();
        set.add(fn);
        listeners.set(type, set);
        liveSubs++;
        return () => {
          if (set.delete(fn)) liveSubs--;
        };
      },
      findMemoriesForFile() {},
    };
    const hostValue = { getClient: () => client } as never;

    let latest!: ReturnType<typeof useMemoryForFile>;
    function Probe({ autoFetch }: { autoFetch: boolean }) {
      latest = useMemoryForFile({ filePath: 'src/a.ts', autoFetch });
      return null;
    }

    await act(async () => {
      root?.render(
        <SurfaceHostProvider host={hostValue}>
          <Probe autoFetch />
        </SurfaceHostProvider>,
      );
    });
    expect(latest.loading).toBe(true);
    expect(liveSubs).toBe(1);

    await act(async () => {
      root?.render(
        <SurfaceHostProvider host={hostValue}>
          <Probe autoFetch={false} />
        </SurfaceHostProvider>,
      );
    });
    expect(latest.loading).toBe(false);
    expect(liveSubs).toBe(0);

    await act(async () => {
      latest.refetch();
    });
    expect(latest.loading).toBe(true);

    await act(async () => {
      emit('memory.sage.forFile', null);
    });
    expect(latest.loading).toBe(true);

    await act(async () => {
      emit('memory.sage.forFile', {
        response: {
          filePath: 'src/a.ts',
          primaryMatches: [],
          symbolMatches: [],
          relatedMatches: [],
          totalCount: 0,
          activeCount: 0,
          supersededCount: 0,
          reviewPendingCount: 0,
        },
      });
    });
    expect(latest.loading).toBe(false);
    expect(latest.data?.filePath).toBe('src/a.ts');
    expect(liveSubs).toBe(0);
  });
});
