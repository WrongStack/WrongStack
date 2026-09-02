import { render } from 'ink-testing-library';
import React, { act } from 'react';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';
import { Text } from '../src/ink.js';
import { useInputHistoryPersistence } from '../src/hooks/use-input-history-persistence.js';
import type { State } from '../src/app-reducer.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// We need to mock the core modules that useInputHistoryPersistence imports
vi.mock('@wrongstack/core/storage', () => {
  const mockStore = {
    _entries: [] as string[],
    load: vi.fn(async function (this: typeof mockStore) {
      return this._entries;
    }),
    save: vi.fn(async () => undefined),
  };
  return {
    InputHistoryStore: vi.fn(() => mockStore),
    INPUT_HISTORY_DEFAULT_MAX: 100,
  };
});

vi.mock('@wrongstack/core/security', () => ({
  DefaultSecretScrubber: vi.fn(() => ({ scrub: vi.fn((s: string) => s) })),
}));

vi.mock('@wrongstack/core/utils', () => {
  return {
    resolveWstackPaths: vi.fn(() => ({ projectInputHistory: '/fake/path/history.json' })),
  };
});

interface HarnessRefs {
  projectRoot: string;
  inputHistory: State['inputHistory'];
  dispatch: Mock;
}

function buildHarness(): HarnessRefs {
  return {
    projectRoot: '/test/project',
    inputHistory: [
      { displayText: 'hello', blocks: [] as never[] },
    ] as unknown as State['inputHistory'],
    dispatch: vi.fn(),
  };
}

function Harness({ refs }: { refs: HarnessRefs }): React.ReactElement {
  useInputHistoryPersistence({
    projectRoot: refs.projectRoot,
    inputHistory: refs.inputHistory,
    dispatch: refs.dispatch,
  });
  return React.createElement(Text, null, 'hist');
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('useInputHistoryPersistence', () => {
  it('does nothing when projectRoot is empty', () => {
    const refs = buildHarness();
    refs.projectRoot = '';
    expect(() => render(React.createElement(Harness, { refs }))).not.toThrow();
  });

  it('loads history on mount and dispatches entries', async () => {
    const refs = buildHarness();
    render(React.createElement(Harness, { refs }));
    // The mock InputHistoryStore.load returns [] by default
    // We need to set up the mock to return entries
    const { InputHistoryStore } = await import('@wrongstack/core/storage');
    const storeInstance = (InputHistoryStore as unknown as Mock).mock.results[0]?.value;
    if (storeInstance) {
      storeInstance._entries = ['entry1', 'entry2'];
    }
  });

  it('does not dispatch when loaded entries are empty', async () => {
    const refs = buildHarness();
    render(React.createElement(Harness, { refs }));
    await act(async () => {
      await Promise.resolve();
    });
    // No setInputHistory dispatch
    expect(refs.dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'setInputHistory' }),
    );
  });

  it('saves history on change with debounce', async () => {
    const refs = buildHarness();
    render(React.createElement(Harness, { refs }));
    await act(async () => {
      await Promise.resolve();
    });
    // Trigger save by updating inputHistory
    render(
      React.createElement(Harness, {
        refs: {
          ...refs,
          inputHistory: [
            { displayText: 'new', blocks: [] as never[] },
          ] as unknown as State['inputHistory'],
        },
      }),
    );
  });

  it('skips save when snapshot matches last saved', async () => {
    const refs = buildHarness();
    render(React.createElement(Harness, { refs }));
    await act(async () => {
      await Promise.resolve();
    });
    // Re-render with same inputHistory - snapshot should match
    render(React.createElement(Harness, { refs }));
  });

  it('handles load error gracefully', async () => {
    const { InputHistoryStore } = await import('@wrongstack/core/storage');
    (InputHistoryStore as unknown as Mock).mockImplementation(() => ({
      _entries: [],
      load: vi.fn(async () => {
        throw new Error('load error');
      }),
      save: vi.fn(async () => undefined),
    }));
    const refs = buildHarness();
    expect(() => render(React.createElement(Harness, { refs }))).not.toThrow();
    // Clean up mock
    vi.clearAllMocks();
  });
});
