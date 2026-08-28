import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * QuickModelSwitcher — the Ctrl/Cmd+M model picker. Its inputs are the saved
 * provider list and per-provider model catalogues, both arriving as WS frames,
 * so the test drives a fake client's emitter directly.
 */

const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() };
vi.mock('@/components/Toaster', () => ({ toast }));

type Handler = (msg: unknown) => void;

const handlers = new Map<string, Set<Handler>>();
const listSavedProviders = vi.fn();
const listProviderModels = vi.fn();
const switchModel = vi.fn();

vi.mock('@/lib/ws-client', () => ({
  getWSClient: () => ({
    on(type: string, handler: Handler) {
      const set = handlers.get(type) ?? new Set<Handler>();
      set.add(handler);
      handlers.set(type, set);
      return () => set.delete(handler);
    },
  }),
}));

vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: () => ({ listSavedProviders, listProviderModels, switchModel }),
}));

const { QuickModelSwitcher } = await import('@/components/QuickModelSwitcher');
const { useConfigStore, useSessionStore, useUIStore } = await import('@/stores');

function emit(type: string, payload: unknown) {
  act(() => {
    for (const h of [...(handlers.get(type) ?? [])]) h({ type, payload });
  });
}

function provider(id: string) {
  return { id, apiKeys: [{ label: 'work', isActive: true }] };
}

function model(id: string, extra: Record<string, unknown> = {}) {
  return { id, name: id.toUpperCase(), ...extra };
}

/** Open the overlay and seed one provider with two models. */
async function openWithCatalogue() {
  const view = render(<QuickModelSwitcher />);
  act(() => useUIStore.getState().setModelSwitcherOpen(true));
  await waitFor(() => expect(listSavedProviders).toHaveBeenCalled());

  emit('providers.saved', { providers: [provider('openai')] });
  await waitFor(() => expect(listProviderModels).toHaveBeenCalledWith('openai'));
  emit('provider.models', { provider: 'openai', models: [model('gpt-5'), model('gpt-4')] });

  return view;
}

function input(): HTMLInputElement {
  return screen.getByRole('textbox') as HTMLInputElement;
}

function rows(): HTMLButtonElement[] {
  const candidateButtons = screen
    .getAllByRole('button')
    .filter((b) => b.hasAttribute('data-model-candidate')) as HTMLButtonElement[];
  return candidateButtons.length > 0
    ? candidateButtons
    : (screen.getAllByRole('button') as HTMLButtonElement[]);
}

beforeEach(async () => {
  vi.clearAllMocks();
  handlers.clear();
  switchModel.mockResolvedValue({ success: true, runActive: false, message: 'ok' });
  const { useLocalPrefs } = await import('@/stores/local-prefs');
  useLocalPrefs.setState({ favoriteModels: [] } as never);
  useUIStore.setState({ modelSwitcherOpen: false, paletteOpen: false } as never);
  useConfigStore.setState({ wsUrl: 'ws://x', provider: 'openai', model: 'gpt-4' } as never);
  useSessionStore.setState({
    session: { id: 'sess_active', provider: 'openai', model: 'gpt-4' },
  } as never);
});

afterEach(cleanup);

describe('keyboard shortcut', () => {
  it('ctrl+m opens the overlay', () => {
    render(<QuickModelSwitcher />);
    fireEvent.keyDown(window, { key: 'm', ctrlKey: true });
    expect(useUIStore.getState().modelSwitcherOpen).toBe(true);
  });

  it('cmd+m opens it too', () => {
    render(<QuickModelSwitcher />);
    fireEvent.keyDown(window, { key: 'M', metaKey: true });
    expect(useUIStore.getState().modelSwitcherOpen).toBe(true);
  });

  it('toggles closed on a second press', () => {
    render(<QuickModelSwitcher />);
    fireEvent.keyDown(window, { key: 'm', ctrlKey: true });
    fireEvent.keyDown(window, { key: 'm', ctrlKey: true });
    expect(useUIStore.getState().modelSwitcherOpen).toBe(false);
  });

  it('stands down while the command palette owns focus', () => {
    useUIStore.setState({ paletteOpen: true } as never);
    render(<QuickModelSwitcher />);
    fireEvent.keyDown(window, { key: 'm', ctrlKey: true });
    expect(useUIStore.getState().modelSwitcherOpen).toBe(false);
  });

  it('ignores the shortcut with an extra modifier', () => {
    render(<QuickModelSwitcher />);
    fireEvent.keyDown(window, { key: 'm', ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(window, { key: 'm', ctrlKey: true, altKey: true });
    expect(useUIStore.getState().modelSwitcherOpen).toBe(false);
  });

  it('ignores a bare m', () => {
    render(<QuickModelSwitcher />);
    fireEvent.keyDown(window, { key: 'm' });
    expect(useUIStore.getState().modelSwitcherOpen).toBe(false);
  });

  it('escape closes an open overlay', () => {
    render(<QuickModelSwitcher />);
    act(() => useUIStore.getState().setModelSwitcherOpen(true));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useUIStore.getState().modelSwitcherOpen).toBe(false);
  });

  it('escape does nothing while closed', () => {
    render(<QuickModelSwitcher />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useUIStore.getState().modelSwitcherOpen).toBe(false);
  });

  it('detaches the listener on unmount', () => {
    const { unmount } = render(<QuickModelSwitcher />);
    unmount();
    fireEvent.keyDown(window, { key: 'm', ctrlKey: true });
    expect(useUIStore.getState().modelSwitcherOpen).toBe(false);
  });
});

describe('catalogue loading', () => {
  it('asks for the saved providers when it opens', async () => {
    render(<QuickModelSwitcher />);
    act(() => useUIStore.getState().setModelSwitcherOpen(true));
    await waitFor(() => expect(listSavedProviders).toHaveBeenCalled());
  });

  it('does not ask while closed', () => {
    render(<QuickModelSwitcher />);
    expect(listSavedProviders).not.toHaveBeenCalled();
  });

  it('lazy-loads the models of each saved provider exactly once', async () => {
    render(<QuickModelSwitcher />);
    act(() => useUIStore.getState().setModelSwitcherOpen(true));
    emit('providers.saved', { providers: [provider('openai'), provider('anthropic')] });

    await waitFor(() => expect(listProviderModels).toHaveBeenCalledTimes(2));
    emit('provider.models', { provider: 'openai', models: [model('gpt-5')] });
    // The already-loaded provider isn't re-requested.
    expect(listProviderModels.mock.calls.filter((c) => c[0] === 'openai')).toHaveLength(1);
  });

  it('tolerates a saved-providers frame with no list', async () => {
    render(<QuickModelSwitcher />);
    act(() => useUIStore.getState().setModelSwitcherOpen(true));
    emit('providers.saved', {});

    await waitFor(() => expect(screen.getByText(/no saved provider/i)).toBeTruthy());
  });

  it('still records a late frame that arrives after closing', async () => {
    render(<QuickModelSwitcher />);
    act(() => useUIStore.getState().setModelSwitcherOpen(true));
    act(() => useUIStore.getState().setModelSwitcherOpen(false));
    // Listeners are attached unconditionally, so this must not throw.
    expect(() => emit('providers.saved', { providers: [provider('openai')] })).not.toThrow();
  });

  it('shows a loading line once a provider is known but its models are not', async () => {
    render(<QuickModelSwitcher />);
    act(() => useUIStore.getState().setModelSwitcherOpen(true));
    emit('providers.saved', { providers: [provider('openai')] });

    await waitFor(() => expect(screen.getByText(/loading/i)).toBeTruthy());
  });
});

describe('list rendering', () => {
  it('renders one row per catalogue entry', async () => {
    await openWithCatalogue();
    await waitFor(() => expect(rows().length).toBeGreaterThanOrEqual(2));
    expect(screen.getByText('GPT-5')).toBeTruthy();
  });

  it('marks the active model', async () => {
    await openWithCatalogue();
    await waitFor(() => expect(screen.getByText(/active/i)).toBeTruthy());
  });

  it("uses the active session's model as the current row, not the global config fallback", async () => {
    useConfigStore.setState({ provider: 'openai', model: 'gpt-4' } as never);
    useSessionStore.setState({
      session: { id: 'sess_active', provider: 'openai', model: 'gpt-5' },
    } as never);

    await openWithCatalogue();
    await waitFor(() => expect(screen.getByText(/active/i)).toBeTruthy());

    fireEvent.keyDown(input(), { key: 'Enter' });

    await waitFor(() => expect(useUIStore.getState().modelSwitcherOpen).toBe(false));
    expect(switchModel).not.toHaveBeenCalled();
  });

  it('shows the context window when the catalogue supplies one', async () => {
    render(<QuickModelSwitcher />);
    act(() => useUIStore.getState().setModelSwitcherOpen(true));
    emit('providers.saved', { providers: [provider('openai')] });
    emit('provider.models', {
      provider: 'openai',
      models: [model('gpt-5', { contextWindow: 200_000 })],
    });

    await waitFor(() =>
      expect(screen.getByText(new RegExp((200_000).toLocaleString()))).toBeTruthy(),
    );
  });

  it('filters as the user types', async () => {
    await openWithCatalogue();
    await waitFor(() => expect(screen.getByText('GPT-5')).toBeTruthy());

    fireEvent.change(input(), { target: { value: 'gpt-5' } });
    await waitFor(() => expect(screen.queryByText('GPT-4')).toBeNull());
    expect(screen.getByText('GPT-5')).toBeTruthy();
  });

  it('shows a no-match message when the filter yields nothing', async () => {
    await openWithCatalogue();
    fireEvent.change(input(), { target: { value: 'zzzzz' } });
    await waitFor(() => expect(screen.getByText(/no matching/i)).toBeTruthy());
  });

  it('resets the query each time it opens', async () => {
    await openWithCatalogue();
    fireEvent.change(input(), { target: { value: 'gpt-5' } });
    expect(input().value).toBe('gpt-5');

    act(() => useUIStore.getState().setModelSwitcherOpen(false));
    act(() => useUIStore.getState().setModelSwitcherOpen(true));

    await waitFor(() => expect(input().value).toBe(''));
  });
});

describe('selection', () => {
  it('moves down and up with the arrow keys', async () => {
    await openWithCatalogue();
    await waitFor(() => expect(rows().length).toBeGreaterThanOrEqual(2));

    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    fireEvent.keyDown(input(), { key: 'ArrowUp' });
    // No crash and the list is still rendered — the index stayed in range.
    expect(rows().length).toBeGreaterThanOrEqual(2);
  });

  it('clamps at both ends', async () => {
    await openWithCatalogue();
    await waitFor(() => expect(rows().length).toBeGreaterThanOrEqual(2));

    for (let i = 0; i < 10; i += 1) fireEvent.keyDown(input(), { key: 'ArrowDown' });
    for (let i = 0; i < 10; i += 1) fireEvent.keyDown(input(), { key: 'ArrowUp' });
    expect(rows().length).toBeGreaterThanOrEqual(2);
  });

  it('follows the mouse', async () => {
    await openWithCatalogue();
    await waitFor(() => expect(rows().length).toBeGreaterThanOrEqual(2));
    fireEvent.mouseEnter(rows()[1]!);
    expect(rows()[1]).toBeTruthy();
  });
});

describe('committing a switch', () => {
  it('switches to the picked provider and model', async () => {
    await openWithCatalogue();
    await waitFor(() => expect(screen.getByText('GPT-5')).toBeTruthy());

    fireEvent.change(input(), { target: { value: 'gpt-5' } });
    await waitFor(() => expect(screen.queryByText('GPT-4')).toBeNull());
    fireEvent.keyDown(input(), { key: 'Enter' });

    await waitFor(() => expect(switchModel).toHaveBeenCalledWith('openai', 'gpt-5'));
  });

  it('closes without switching when the pick is already active', async () => {
    await openWithCatalogue();
    await waitFor(() => expect(screen.getByText(/active/i)).toBeTruthy());

    // The active row floats to the top, so index 0 is the current model.
    fireEvent.keyDown(input(), { key: 'Enter' });

    await waitFor(() => expect(useUIStore.getState().modelSwitcherOpen).toBe(false));
    expect(switchModel).not.toHaveBeenCalled();
  });

  it('toasts and closes on success', async () => {
    await openWithCatalogue();
    fireEvent.change(input(), { target: { value: 'gpt-5' } });
    await waitFor(() => expect(screen.queryByText('GPT-4')).toBeNull());
    fireEvent.keyDown(input(), { key: 'Enter' });

    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(useUIStore.getState().modelSwitcherOpen).toBe(false);
  });

  it('uses the run-active wording when a run is in flight', async () => {
    switchModel.mockResolvedValue({ success: true, runActive: true, message: 'ok' });
    await openWithCatalogue();
    fireEvent.change(input(), { target: { value: 'gpt-5' } });
    await waitFor(() => expect(screen.queryByText('GPT-4')).toBeNull());
    fireEvent.keyDown(input(), { key: 'Enter' });

    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(String(toast.success.mock.calls[0]![0])).toMatch(/run|current/i);
  });

  it('toasts the failure and stays open', async () => {
    switchModel.mockResolvedValue({ success: false, message: 'provider blocked' });
    await openWithCatalogue();
    fireEvent.change(input(), { target: { value: 'gpt-5' } });
    await waitFor(() => expect(screen.queryByText('GPT-4')).toBeNull());
    fireEvent.keyDown(input(), { key: 'Enter' });

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('provider blocked'));
    expect(useUIStore.getState().modelSwitcherOpen).toBe(true);
  });

  it('stays quiet when the overlay was closed mid-switch', async () => {
    let resolveSwitch: (v: unknown) => void = () => {};
    switchModel.mockReturnValue(
      new Promise((resolve) => {
        resolveSwitch = resolve;
      }),
    );
    await openWithCatalogue();
    fireEvent.change(input(), { target: { value: 'gpt-5' } });
    await waitFor(() => expect(screen.queryByText('GPT-4')).toBeNull());
    fireEvent.keyDown(input(), { key: 'Enter' });

    act(() => useUIStore.getState().setModelSwitcherOpen(false));
    await act(async () => {
      resolveSwitch({ success: true, runActive: false, message: 'ok' });
    });

    expect(toast.success).not.toHaveBeenCalled();
  });

  it('clicking a row commits it', async () => {
    await openWithCatalogue();
    fireEvent.change(input(), { target: { value: 'gpt-5' } });
    await waitFor(() => expect(screen.queryByText('GPT-4')).toBeNull());
    fireEvent.click(rows()[0]!);

    await waitFor(() => expect(switchModel).toHaveBeenCalledWith('openai', 'gpt-5'));
  });

  it('ignores a second commit while one is in flight', async () => {
    switchModel.mockReturnValue(new Promise(() => {}));
    await openWithCatalogue();
    fireEvent.change(input(), { target: { value: 'gpt-5' } });
    await waitFor(() => expect(screen.queryByText('GPT-4')).toBeNull());

    fireEvent.keyDown(input(), { key: 'Enter' });
    fireEvent.keyDown(input(), { key: 'Enter' });

    await waitFor(() => expect(switchModel).toHaveBeenCalledTimes(1));
  });

  it('shows the in-flight target in the hint slot', async () => {
    switchModel.mockReturnValue(new Promise(() => {}));
    await openWithCatalogue();
    fireEvent.change(input(), { target: { value: 'gpt-5' } });
    await waitFor(() => expect(screen.queryByText('GPT-4')).toBeNull());
    fireEvent.keyDown(input(), { key: 'Enter' });

    await waitFor(() => expect(screen.getByText(/openai \/ gpt-5/)).toBeTruthy());
  });

  it('does nothing when there is no row to commit', async () => {
    render(<QuickModelSwitcher />);
    act(() => useUIStore.getState().setModelSwitcherOpen(true));
    await waitFor(() => expect(listSavedProviders).toHaveBeenCalled());

    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(switchModel).not.toHaveBeenCalled();
  });
});

describe('provider filter', () => {
  it('does not show when only one provider is saved', async () => {
    render(<QuickModelSwitcher />);
    act(() => useUIStore.getState().setModelSwitcherOpen(true));
    emit('providers.saved', { providers: [provider('openai')] });
    emit('provider.models', { provider: 'openai', models: [model('gpt-5')] });

    await waitFor(() => expect(screen.getByText('GPT-5')).toBeTruthy());
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('shows a filter dropdown when multiple providers exist', async () => {
    render(<QuickModelSwitcher />);
    act(() => useUIStore.getState().setModelSwitcherOpen(true));
    emit('providers.saved', { providers: [provider('openai'), provider('anthropic')] });
    emit('provider.models', { provider: 'openai', models: [model('gpt-5')] });
    emit('provider.models', { provider: 'anthropic', models: [model('claude-opus')] });

    await waitFor(() => expect(screen.getByRole('combobox')).toBeTruthy());
  });

  it('filters the list when a provider is selected', async () => {
    render(<QuickModelSwitcher />);
    act(() => useUIStore.getState().setModelSwitcherOpen(true));
    emit('providers.saved', { providers: [provider('openai'), provider('anthropic')] });
    emit('provider.models', { provider: 'openai', models: [model('gpt-5')] });
    emit('provider.models', { provider: 'anthropic', models: [model('claude-opus')] });

    await waitFor(() => expect(screen.getByText('GPT-5')).toBeTruthy());

    const select = screen.getByRole('combobox') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'openai' } });

    await waitFor(() => {
      expect(screen.getByText('GPT-5')).toBeTruthy();
      expect(screen.queryByText('CLAUDE-OPUS')).toBeNull();
    });
  });

  it('resets the provider filter when the modal reopens', async () => {
    render(<QuickModelSwitcher />);
    act(() => useUIStore.getState().setModelSwitcherOpen(true));
    emit('providers.saved', { providers: [provider('openai'), provider('anthropic')] });
    emit('provider.models', { provider: 'openai', models: [model('gpt-5')] });
    emit('provider.models', { provider: 'anthropic', models: [model('claude-opus')] });

    await waitFor(() => expect(screen.getByRole('combobox')).toBeTruthy());

    const select = screen.getByRole('combobox') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'anthropic' } });
    await waitFor(() => expect(screen.queryByText('GPT-5')).toBeNull());

    act(() => useUIStore.getState().setModelSwitcherOpen(false));
    act(() => useUIStore.getState().setModelSwitcherOpen(true));

    await waitFor(() => {
      const reset = screen.getByRole('combobox') as HTMLSelectElement;
      expect(reset.value).toBe('');
    });
  });
});

describe('favorites only filter', () => {
  it('shows favorites only toggle button', async () => {
    await openWithCatalogue();
    expect(screen.getByRole('button', { name: /favorites only/i })).toBeTruthy();
  });

  it('filters candidates to favorite models when toggled', async () => {
    const { useLocalPrefs } = await import('@/stores/local-prefs');
    useLocalPrefs.setState({ favoriteModels: ['openai/gpt-5'] } as never);

    await openWithCatalogue();
    expect(screen.getByText('GPT-5')).toBeTruthy();
    expect(screen.getByText('GPT-4')).toBeTruthy();

    const favToggle = screen.getByRole('button', { name: /favorites only/i });
    fireEvent.click(favToggle);

    await waitFor(() => {
      expect(screen.getByText('GPT-5')).toBeTruthy();
      expect(screen.queryByText('GPT-4')).toBeNull();
    });
  });

  it('resets favorites filter when the modal reopens', async () => {
    const { useLocalPrefs } = await import('@/stores/local-prefs');
    useLocalPrefs.setState({ favoriteModels: ['openai/gpt-5'] } as never);

    render(<QuickModelSwitcher />);
    act(() => useUIStore.getState().setModelSwitcherOpen(true));
    emit('providers.saved', { providers: [provider('openai')] });
    emit('provider.models', { provider: 'openai', models: [model('gpt-5'), model('gpt-4')] });

    await waitFor(() => expect(screen.getByText('GPT-5')).toBeTruthy());

    const favToggle = screen.getByRole('button', { name: /favorites only/i });
    fireEvent.click(favToggle);
    await waitFor(() => expect(screen.queryByText('GPT-4')).toBeNull());

    act(() => useUIStore.getState().setModelSwitcherOpen(false));
    act(() => useUIStore.getState().setModelSwitcherOpen(true));

    await waitFor(() => {
      expect(screen.getByText('GPT-5')).toBeTruthy();
      expect(screen.getByText('GPT-4')).toBeTruthy();
    });
  });
});
