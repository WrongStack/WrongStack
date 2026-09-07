import { render } from 'ink-testing-library';
import React, { act, useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Action, reducer, type State } from '../src/app-reducer.js';
import {
  AUTH_PANEL_INITIAL,
  type AuthPanelHost,
  type AuthProviderSetup,
} from '../src/components/auth-panel-model.js';
import { type AuthPanelController, useAuthPanel } from '../src/hooks/use-auth-panel.js';
import { Text } from '../src/ink.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function initialState(): State {
  return {
    authPanel: { ...AUTH_PANEL_INITIAL },
    monitorOpen: false,
    agentsMonitorOpen: false,
    helpOpen: false,
    todosMonitorOpen: false,
    queuePanelOpen: false,
    processListOpen: false,
    auditPanelOpen: false,
    planPanelOpen: false,
    goalPanelOpen: false,
    sessionsPanelOpen: false,
    settingsPicker: { open: false },
    statuslinePicker: { open: false, field: 0, hiddenItems: [], visibleChips: [] },
    pluginPicker: { open: false, items: [], selected: 0, busy: false },
    projectPicker: { open: false, allItems: [], items: [], selected: 0, filter: '' },
    fKeyPicker: { open: false, selected: 0 },
    goalRun: undefined,
    sddBoard: undefined,
    worktreeMonitorOpen: false,
    coordinator: { monitorOpen: false },
  } as unknown as State;
}

interface Harness {
  controller: AuthPanelController;
  state: State;
  actions: Action[];
  dispatch(action: Action): void;
  rerender(): void;
  unmount(): void;
}

function createHarness(authHost?: AuthPanelHost): Harness {
  const stateRef = { current: initialState() };
  const actions: Action[] = [];
  let controller: AuthPanelController | undefined;
  const dispatch = (action: Action) => {
    actions.push(action);
    stateRef.current = reducer(stateRef.current, action);
  };

  function HookHarness(): React.ReactElement {
    const next = useAuthPanel({
      authHost,
      stateRef,
      dispatch,
      open: stateRef.current.authPanel.open,
    });
    useEffect(() => {
      controller = next;
    }, [next]);
    return React.createElement(Text, null, stateRef.current.authPanel.input?.label ?? 'idle');
  }

  const view = render(React.createElement(HookHarness));
  return {
    get controller() {
      if (!controller) throw new Error('Auth panel controller did not mount');
      return controller;
    },
    get state() {
      return stateRef.current;
    },
    actions,
    dispatch,
    rerender: () => view.rerender(React.createElement(HookHarness)),
    unmount: () => view.unmount(),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useAuthPanel standalone secret prompts', () => {
  it('opens a masked prompt, resolves the draft, and closes the standalone panel', async () => {
    let harness!: Harness;
    act(() => {
      harness = createHarness();
    });

    let secret!: Promise<string>;
    act(() => {
      secret = harness.controller.readSecret('Telegram bot token');
      harness.rerender();
    });
    expect(harness.state.authPanel.open).toBe(true);
    expect(harness.state.authPanel.input).toEqual({
      label: 'Telegram bot token',
      masked: true,
      draft: '',
    });

    act(() => harness.dispatch({ type: 'authPromptChange', draft: '123:secret' }));
    act(() => harness.controller.onAuthPromptSubmit());
    await expect(secret).resolves.toBe('123:secret');
    expect(harness.state.authPanel.input).toBeUndefined();
    expect(harness.state.authPanel.open).toBe(false);

    act(() => harness.unmount());
  });

  it('rejects cancellation with AbortError and closes the standalone panel', async () => {
    let harness!: Harness;
    act(() => {
      harness = createHarness();
    });
    let secret!: Promise<string>;
    act(() => {
      secret = harness.controller.readSecret('API key');
    });

    act(() => harness.controller.onAuthPromptCancel());
    await expect(secret).rejects.toMatchObject({ name: 'AbortError', message: 'Cancelled' });
    expect(harness.state.authPanel.input).toBeUndefined();
    expect(harness.state.authPanel.open).toBe(false);

    act(() => harness.unmount());
  });

  it('ends and rejects a displaced prompt before opening its replacement', async () => {
    let harness!: Harness;
    act(() => {
      harness = createHarness();
    });
    let first!: Promise<string>;
    let second!: Promise<string>;
    act(() => {
      first = harness.controller.readSecret('First secret');
      second = harness.controller.readSecret('Second secret');
    });

    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect(harness.actions.map((action) => action.type).slice(-4)).toEqual([
      'authPromptStart',
      'authPromptEnd',
      'authOpen',
      'authPromptStart',
    ]);
    expect(harness.state.authPanel.input).toMatchObject({ label: 'Second secret', masked: true });

    act(() => harness.controller.onAuthPromptCancel());
    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
    act(() => harness.unmount());
  });

  it('rejects a pending standalone prompt when the TUI unmounts', async () => {
    let harness!: Harness;
    act(() => {
      harness = createHarness();
    });
    let secret!: Promise<string>;
    act(() => {
      secret = harness.controller.readSecret('Unmounted secret');
      harness.unmount();
    });

    await expect(secret).rejects.toMatchObject({ name: 'AbortError', message: 'Cancelled' });
  });

  it('the form-based add-provider flow opens a form, then Save calls the host and routes back', async () => {
    const saveProviderSetup = vi.fn(async (_setup: AuthProviderSetup) => null as string | null);
    const host = {
      listProviders: vi.fn(async () => []),
      listCatalog: vi.fn(async () => []),
      localPresets: vi.fn(() => []),
      setActiveKey: vi.fn(async () => null),
      deleteKey: vi.fn(async () => null),
      removeProvider: vi.fn(async () => null),
      addKey: vi.fn(async () => ({ ok: true })),
      updateKey: vi.fn(async () => ({ ok: true })),
      editField: vi.fn(async () => ({ ok: true })),
      editModelDetails: vi.fn(async () => ({ ok: true })),
      addModel: vi.fn(async () => ({ ok: true })),
      removeModel: vi.fn(async () => null),
      resetModelToCatalog: vi.fn(async () => null),
      addCatalogProvider: vi.fn(async () => ({ ok: true })),
      addCustomProvider: vi.fn(async () => ({ ok: true })),
      addLocal: vi.fn(async () => ({ ok: true })),
      oauthLogin: vi.fn(async () => ({ ok: true })),
      saveProviderSetup,
      saveProviderEdit: vi.fn(async () => null),
      getModelEdit: vi.fn(async () => null),
      saveModelEdit: vi.fn(async () => null),
      saveKeyEdit: vi.fn(async () => null),
    } satisfies AuthPanelHost;
    let harness!: Harness;
    act(() => {
      harness = createHarness(host);
    });
    act(() => {
      harness.controller.openAuthPanel();
      harness.rerender();
    });
    await act(async () => {
      await Promise.resolve();
    });

    // "＋ Add custom provider" is the 3rd list-action (catalog, local,
    // custom) — move down 2 rows from the top of the empty list.
    act(() => {
      harness.dispatch({ type: 'authMove', delta: 2 });
      harness.controller.onAuthEnter();
    });
    // The form view is now open with the form slice populated.
    expect(harness.state.authPanel.view).toBe('form');
    expect(harness.state.authPanel.form?.kind).toBe('setup');

    // Edit the alias field by dispatching a form change + moving to Save.
    act(() => {
      harness.dispatch({
        type: 'authFormChange',
        field: 'alias',
        value: 'my-provider',
      });
    });
    expect(harness.state.authPanel.form?.fields.alias).toBe('my-provider');

    // Walk to the Save row (Cancel + Save are the last two rows in the
    // form view, so 9 fields below cursor-0 → 10 steps down).
    act(() => {
      harness.dispatch({ type: 'authMove', delta: 10 });
      harness.controller.onAuthEnter();
    });
    // Save dispatches the host call; once it resolves the panel routes
    // back to the list and reloads providers.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(saveProviderSetup).toHaveBeenCalledTimes(1);
    const savedSetup = saveProviderSetup.mock.calls[0]?.[0];
    expect(savedSetup?.alias).toBe('my-provider');
    expect(savedSetup?.family).toBe('openai-compatible');
    expect(harness.state.authPanel.view).toBe('list');
    expect(harness.state.authPanel.form).toBeUndefined();
  });

  it('keeps the form open and surfaces the error when the host rejects Save', async () => {
    const saveProviderSetup = vi.fn(async () => 'Alias already exists.');
    const host = {
      listProviders: vi.fn(async () => []),
      listCatalog: vi.fn(async () => []),
      localPresets: vi.fn(() => []),
      setActiveKey: vi.fn(async () => null),
      deleteKey: vi.fn(async () => null),
      removeProvider: vi.fn(async () => null),
      addKey: vi.fn(async () => ({ ok: true })),
      updateKey: vi.fn(async () => ({ ok: true })),
      editField: vi.fn(async () => ({ ok: true })),
      editModelDetails: vi.fn(async () => ({ ok: true })),
      addModel: vi.fn(async () => ({ ok: true })),
      removeModel: vi.fn(async () => null),
      resetModelToCatalog: vi.fn(async () => null),
      addCatalogProvider: vi.fn(async () => ({ ok: true })),
      addCustomProvider: vi.fn(async () => ({ ok: true })),
      addLocal: vi.fn(async () => ({ ok: true })),
      oauthLogin: vi.fn(async () => ({ ok: true })),
      saveProviderSetup,
      saveProviderEdit: vi.fn(async () => null),
      getModelEdit: vi.fn(async () => null),
      saveModelEdit: vi.fn(async () => null),
      saveKeyEdit: vi.fn(async () => null),
    } satisfies AuthPanelHost;
    let harness!: Harness;
    act(() => {
      harness = createHarness(host);
    });
    act(() => {
      harness.controller.openAuthPanel();
      harness.rerender();
    });
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      harness.dispatch({ type: 'authMove', delta: 2 });
      harness.controller.onAuthEnter();
    });
    expect(harness.state.authPanel.view).toBe('form');
    act(() => {
      // Walk to the Save row (10 down from row 0).
      harness.dispatch({ type: 'authMove', delta: 10 });
      harness.controller.onAuthEnter();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(saveProviderSetup).toHaveBeenCalledTimes(1);
    // The form is still open so the user can fix the conflict without
    // re-entering every field.
    expect(harness.state.authPanel.view).toBe('form');
    expect(harness.state.authPanel.form?.kind).toBe('setup');
    expect(harness.state.authPanel.hint).toContain('Alias already exists.');
  });

  it('local preset Enter opens the form; Save probes via the flow path', async () => {
    const addLocal = vi.fn(async () => ({ ok: true }) as { ok: boolean; message?: string });
    const host = {
      listProviders: vi.fn(async () => []),
      listCatalog: vi.fn(async () => []),
      localPresets: vi.fn(() => [
        {
          id: 'ollama',
          label: 'Ollama',
          defaultBaseUrl: 'http://localhost:11434',
          noAuth: true,
          hint: '',
        },
      ]),
      setActiveKey: vi.fn(async () => null),
      deleteKey: vi.fn(async () => null),
      removeProvider: vi.fn(async () => null),
      addKey: vi.fn(async () => ({ ok: true })),
      updateKey: vi.fn(async () => ({ ok: true })),
      editField: vi.fn(async () => ({ ok: true })),
      editModelDetails: vi.fn(async () => ({ ok: true })),
      addModel: vi.fn(async () => ({ ok: true })),
      removeModel: vi.fn(async () => null),
      resetModelToCatalog: vi.fn(async () => null),
      addCatalogProvider: vi.fn(async () => ({ ok: true })),
      addCustomProvider: vi.fn(async () => ({ ok: true })),
      addLocal,
      oauthLogin: vi.fn(async () => ({ ok: true })),
      saveProviderSetup: vi.fn(async () => null),
      saveProviderEdit: vi.fn(async () => null),
      getModelEdit: vi.fn(async () => null),
      saveModelEdit: vi.fn(async () => null),
      saveKeyEdit: vi.fn(async () => null),
    } satisfies AuthPanelHost;
    let harness!: Harness;
    act(() => {
      harness = createHarness(host);
    });
    act(() => {
      harness.controller.openAuthPanel();
      harness.rerender();
    });
    await act(async () => {
      await Promise.resolve();
    });

    // List view: 0 providers + 4 actions → 'local' at index 1 → preset list.
    act(() => {
      harness.dispatch({ type: 'authMove', delta: 1 });
      harness.controller.onAuthEnter();
    });
    expect(harness.state.authPanel.view).toBe('local');

    // Enter on the preset row opens the form pre-filled from the preset.
    act(() => harness.controller.onAuthEnter());
    expect(harness.state.authPanel.view).toBe('form');
    expect(harness.state.authPanel.form?.kind).toBe('local');
    expect(harness.state.authPanel.form?.presetId).toBe('ollama');
    expect(harness.state.authPanel.form?.fields.baseUrl).toBe('http://localhost:11434');

    // noAuth preset → rows are baseUrl(0), cancel(1), save(2) → Save.
    act(() => {
      harness.dispatch({ type: 'authMove', delta: 2 });
      harness.controller.onAuthEnter();
    });
    // Save routed to the flow path — the probe view takes over, no prompts.
    expect(harness.state.authPanel.view).toBe('flow');
    expect(harness.state.authPanel.flowTitle).toBe('Add Ollama');
    expect(addLocal).toHaveBeenCalledWith('ollama', expect.anything(), {
      baseUrl: 'http://localhost:11434',
      apiKey: '',
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(harness.state.authPanel.flowDone).toBe(true);
  });
});
