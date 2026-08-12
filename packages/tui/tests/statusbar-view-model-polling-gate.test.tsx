// @vitest-environment jsdom
//
// Coverage for the statusline visibility gate (P2.2): the plan/task chips
// are the only consumers of the 3s `fs.stat` polls in
// useStatusbarViewModel. When the user hides a chip via `/statusline`,
// the hook must skip its poll entirely — no fs.stat, no readFile, no
// JSON.parse — until the chip is visible again.
//
// Source contract enforced here:
// `packages/tui/src/hooks/use-statusbar-view-model.ts` — `planHidden` /
// `taskHidden` derived from `hiddenItems`, both poll effects return early
// before touching the filesystem.

import { renderHook, waitFor } from '@testing-library/react';
import type { TokenCounter } from '@wrongstack/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppProps } from '../src/app-props.js';
import type { State } from '../src/app-state.js';
import type { StatuslineItem } from '../src/components/statusline-picker.js';
import { useStatusbarViewModel } from '../src/hooks/use-statusbar-view-model.js';

const { statMock } = vi.hoisted(() => ({ statMock: vi.fn() }));

// Partial mock: only `stat` is under test. A factory that replaced the whole
// module broke as soon as anything else in the graph imported `node:fs/promises`
// — the module's other members (and its default export) vanished, so the suite
// failed at collection rather than in a test. Spreading the real module keeps
// this mock scoped to what it actually stubs.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, default: actual, stat: statMock, readFile: vi.fn() };
});

/** Minimal Agent stub — only provider.capabilities + meta are touched. */
function makeAgent(maxContext: number, meta: Record<string, unknown> = {}): AppProps['agent'] {
  return {
    ctx: {
      provider: {
        capabilities: { maxContext },
      },
      meta,
    },
  } as unknown as AppProps['agent'];
}

/** State stub — only the fields useStatusbarViewModel reads are populated. */
function makeState(): State {
  return {
    contextPanelOpen: false,
    contextChipVersion: 0,
    fleet: {},
    leader: {
      iterations: 0,
      toolCalls: 0,
      recentTools: [],
      startedAt: Date.now(),
      lastEventAt: Date.now(),
      currentTool: null,
      ctxPct: 0,
      ctxTokens: 0,
    },
    status: 'idle',
  } as unknown as State;
}

function makeTokenCounter(): TokenCounter {
  return {
    account: () => undefined,
    setSessionId: () => undefined,
    currentRequestTokens: () => ({ input: 0, cacheRead: 0, cacheWrite: 0 }),
    setCurrentRequestTokens: () => undefined,
    total: () => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }),
    estimateCost: () => ({ input: 0, output: 0, total: 0, currency: 'USD' }),
    cacheStats: () => ({ hitRatio: 0, readTokens: 0, writeTokens: 0, savedUsd: 0 }),
    reset: () => undefined,
  };
}

function renderViewModel(hiddenItems: readonly StatuslineItem[]) {
  const agent = makeAgent(200_000, {
    'plan.path': '/tmp/plan.json',
    'task.path': '/tmp/task.json',
  });
  return renderHook(() =>
    useStatusbarViewModel({
      agent,
      tokenCounter: makeTokenCounter(),
      activeMaxContext: 200_000,
      effectiveMaxContext: 200_000,
      liveProvider: 'openai',
      liveModel: 'gpt-4o-mini',
      liveTodos: [],
      state: makeState(),
      hiddenItems,
    }),
  );
}

describe('useStatusbarViewModel — polling visibility gate', () => {
  beforeEach(() => {
    statMock.mockReset();
    statMock.mockResolvedValue({ mtimeMs: 1234, size: 42 });
  });

  it('skips the plan/task fs.stat polls while both chips are hidden', async () => {
    const { unmount } = renderViewModel(['plan', 'tasks']);

    // Effects run on mount; give microtasks a chance to settle. The gate
    // must prevent even the initial `poll()` from touching the filesystem.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(statMock).not.toHaveBeenCalled();

    unmount();
  });

  it('polls the plan and task files when the chips are visible', async () => {
    const { unmount } = renderViewModel([]);

    await waitFor(() => expect(statMock).toHaveBeenCalledTimes(2));

    unmount();
  });

  it('stops polling when the chips become hidden mid-session', async () => {
    const agent = makeAgent(200_000, {
      'plan.path': '/tmp/plan.json',
      'task.path': '/tmp/task.json',
    });
    const props = {
      agent,
      tokenCounter: makeTokenCounter(),
      activeMaxContext: 200_000,
      effectiveMaxContext: 200_000,
      liveProvider: 'openai',
      liveModel: 'gpt-4o-mini',
      liveTodos: [] as readonly { status: string }[],
      state: makeState(),
      hiddenItems: [] as StatuslineItem[],
    };

    const { rerender, unmount } = renderHook((p: typeof props) => useStatusbarViewModel(p), {
      initialProps: props,
    });

    await waitFor(() => expect(statMock).toHaveBeenCalledTimes(2));

    // Toggle both chips hidden — the effects must re-run and stop polling.
    statMock.mockClear();
    rerender({ ...props, hiddenItems: ['plan', 'tasks'] as const });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(statMock).not.toHaveBeenCalled();

    unmount();
  });
});
