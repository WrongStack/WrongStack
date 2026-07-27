import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock seams ──────────────────────────────────────────────────────────────
// ModelEditor calls `getWSClient(wsUrl).searchProviderModels(query, limit)` and
// listens for `provider.models.search_result`. We capture the `on` callback so
// the test can emit synthetic search results.

const { mockOn, mockSearchProviderModels, mockEmit } = vi.hoisted(() => {
  const listeners = new Map<string, ((msg: unknown) => void) | undefined>();
  return {
    mockOn: vi.fn((type: string, cb: (msg: unknown) => void) => {
      listeners.set(type, cb);
      return () => listeners.delete(type);
    }),
    mockSearchProviderModels: vi.fn(),
    mockEmit: (type: string, msg: unknown) => listeners.get(type)?.(msg),
  };
});

vi.mock('@/lib/ws-client', () => ({
  getWSClient: () => ({
    on: (...args: unknown[]) => mockOn(args[0] as string, args[1] as (msg: unknown) => void),
    searchProviderModels: (...args: unknown[]) => mockSearchProviderModels(...args),
  }),
}));

vi.mock('@/stores', () => ({
  useConfigStore: (selector?: (s: Record<string, unknown>) => unknown) =>
    selector ? selector({ wsUrl: 'ws://test' }) : { wsUrl: 'ws://test' },
}));

vi.mock('@/i18n', () => ({
  useAppTranslation: () => ({
    t: (key: string) => {
      const map: Record<string, string> = {
        'setup:screen.custom.models': 'Models',
        'setup:screen.custom.addModel': 'Add model',
        'setup:screen.custom.modelSearchPlaceholder': 'Search catalog models…',
        'setup:screen.custom.noCatalogMatch': 'No catalog match.',
        'setup:screen.custom.useCustomId': 'Enter custom ID',
        'setup:screen.custom.customModelIdPlaceholder': 'Custom model id',
        'setup:screen.custom.cancel': 'Cancel',
        'setup:screen.custom.add': 'Add',
        'setup:screen.custom.modelSingular': 'model',
        'setup:screen.custom.modelPlural': 'models',
      };
      return map[key] ?? key;
    },
  }),
}));

vi.mock('lucide-react', () => ({
  Check: () => null,
  Loader2: () => null,
  Plus: () => null,
  Search: () => null,
  X: () => null,
}));

import { ModelEditor, type ModelEntry } from '@/components/SetupScreen/ModelEditor';

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

/** Advance past the 250ms debounce and flush React state updates. */
function flushDebounce() {
  return act(() => {
    vi.advanceTimersByTime(300);
  });
}

describe('ModelEditor', () => {
  it('shows Add model button when empty and opens search on click', () => {
    render(<ModelEditor models={[]} onChange={() => {}} />);
    expect(screen.getByText('Add model')).toBeTruthy();
    fireEvent.click(screen.getByText('Add model'));
    expect(screen.getByPlaceholderText('Search catalog models…')).toBeTruthy();
  });

  it('sends search request after debounce when typing', async () => {
    render(<ModelEditor models={[]} onChange={() => {}} />);
    fireEvent.click(screen.getByText('Add model'));
    const input = screen.getByPlaceholderText('Search catalog models…');
    fireEvent.change(input, { target: { value: 'deepseek' } });
    // Before debounce fires
    expect(mockSearchProviderModels).not.toHaveBeenCalled();
    // After 250ms debounce
    await flushDebounce();
    expect(mockSearchProviderModels).toHaveBeenCalledWith('deepseek', 8);
  });

  it('renders catalog matches and adds model with metadata on click', async () => {
    const onChange = vi.fn();
    render(<ModelEditor models={[]} onChange={onChange} />);

    fireEvent.click(screen.getByText('Add model'));
    const input = screen.getByPlaceholderText('Search catalog models…');
    fireEvent.change(input, { target: { value: 'gpt-4o' } });
    await flushDebounce();

    // Emit synthetic search result
    act(() => {
      mockEmit('provider.models.search_result', {
        type: 'provider.models.search_result',
        payload: {
          query: 'gpt-4o',
          matches: [
            {
              providerId: 'openai',
              providerName: 'OpenAI',
              modelId: 'gpt-4o',
              name: 'GPT-4o',
              contextWindow: 128_000,
              maxOutput: 16_384,
              capabilities: ['tools', 'vision'],
            },
          ],
        },
      });
    });

    // Match card appears
    await waitFor(() => {
      expect(screen.getByText('GPT-4o')).toBeTruthy();
    });

    // Click the match
    fireEvent.click(screen.getByText('GPT-4o'));

    expect(onChange).toHaveBeenCalledTimes(1);
    const added = onChange.mock.calls[0]![0] as ModelEntry[];
    expect(added).toHaveLength(1);
    expect(added[0]!.id).toBe('gpt-4o');
    expect(added[0]!.name).toBe('GPT-4o');
    expect(added[0]!.maxOutput).toBe(16_384);
    expect(added[0]!.capabilities?.maxContext).toBe(128_000);
    expect(added[0]!.capabilities?.tools).toBe(true);
    expect(added[0]!.capabilities?.vision).toBe(true);
  });

  it('shows custom ID entry when no catalog matches', async () => {
    render(<ModelEditor models={[]} onChange={() => {}} />);
    fireEvent.click(screen.getByText('Add model'));
    const input = screen.getByPlaceholderText('Search catalog models…');
    fireEvent.change(input, { target: { value: 'my-custom-model' } });
    await flushDebounce();

    // The 5s search timeout in the component sets searching=false after expiry.
    // Advance past it so the "no match" UI appears.
    await act(() => {
      vi.advanceTimersByTime(6000);
    });

    await waitFor(() => {
      expect(screen.getByText('No catalog match.')).toBeTruthy();
    });

    // Click "Enter custom ID"
    fireEvent.click(screen.getByText('Enter custom ID'));
    expect(screen.getByPlaceholderText('Custom model id')).toBeTruthy();
  });

  it('adds custom model ID without catalog metadata', async () => {
    const onChange = vi.fn();
    render(<ModelEditor models={[]} onChange={onChange} />);
    fireEvent.click(screen.getByText('Add model'));
    const search = screen.getByPlaceholderText('Search catalog models…');
    fireEvent.change(search, { target: { value: 'my-model' } });
    await flushDebounce();

    await act(() => {
      vi.advanceTimersByTime(6000);
    });

    await waitFor(() => screen.getByText('Enter custom ID'));
    fireEvent.click(screen.getByText('Enter custom ID'));

    const customInput = screen.getByPlaceholderText('Custom model id');
    fireEvent.change(customInput, { target: { value: 'my-custom-id' } });
    fireEvent.click(screen.getByText('Add'));

    expect(onChange).toHaveBeenCalledTimes(1);
    const added = onChange.mock.calls[0]![0] as ModelEntry[];
    expect(added).toHaveLength(1);
    expect(added[0]!.id).toBe('my-custom-id');
    expect(added[0]!.name).toBe('my-custom-id'); // falls back to id
    expect(added[0]!.maxOutput).toBeUndefined();
    expect(added[0]!.capabilities?.maxContext).toBeUndefined();
  });

  it('prevents adding duplicate model IDs', async () => {
    const onChange = vi.fn();
    const existing: ModelEntry[] = [{ id: 'gpt-4o', name: 'GPT-4o' }];
    render(<ModelEditor models={existing} onChange={onChange} />);

    fireEvent.click(screen.getByText('Add model'));
    const input = screen.getByPlaceholderText('Search catalog models…');
    fireEvent.change(input, { target: { value: 'gpt-4o' } });
    await flushDebounce();

    act(() => {
      mockEmit('provider.models.search_result', {
        type: 'provider.models.search_result',
        payload: {
          query: 'gpt-4o',
          matches: [
            {
              providerId: 'openai',
              providerName: 'OpenAI',
              modelId: 'gpt-4o',
              name: 'GPT-4o',
              contextWindow: 128_000,
              capabilities: ['tools'],
            },
          ],
        },
      });
    });

    await waitFor(() => screen.getAllByText('GPT-4o'));
    // Click the match card (the button containing the match, not the chip)
    const matchCards = screen.getAllByText('GPT-4o').map((el) => el.closest('button'));
    const matchCard = matchCards.find((btn) => btn !== null);
    fireEvent.click(matchCard!);

    // onChange should NOT fire because gpt-4o already exists
    expect(onChange).not.toHaveBeenCalled();
  });

  it('removes a model when the X button is clicked', () => {
    const onChange = vi.fn();
    const existing: ModelEntry[] = [{ id: 'model-a', name: 'Model A' }];
    render(<ModelEditor models={existing} onChange={onChange} />);

    // The chip should be visible
    expect(screen.getByText('Model A')).toBeTruthy();

    // Click the remove button (the only button inside the chip)
    const chip = screen.getByText('Model A').closest('div');
    const removeBtn = chip?.querySelector('button');
    expect(removeBtn).toBeTruthy();
    fireEvent.click(removeBtn!);

    expect(onChange).toHaveBeenCalledWith([]);
  });
});
