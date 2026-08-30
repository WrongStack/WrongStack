import { render } from 'ink-testing-library';
import React, { useEffect } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { State } from '../src/app-reducer.js';
import type { KeyEvent } from '../src/components/input.js';
import type { ModeOption } from '../src/components/mode-picker.js';
import type { ProviderOption } from '../src/components/model-picker.js';
import { useAppPickerKeys } from '../src/hooks/use-app-picker-keys.js';
import { type PickerKeysHost, usePickerKeys } from '../src/hooks/use-picker-keys.js';

function key(overrides: Partial<KeyEvent> = {}): KeyEvent {
  return {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    return: false,
    escape: false,
    ctrl: false,
    meta: false,
    shift: false,
    tab: false,
    backspace: false,
    delete: false,
    pageUp: false,
    pageDown: false,
    home: false,
    end: false,
    ...overrides,
  };
}

function baseState(overrides: Partial<State> | Record<string, unknown> = {}): State {
  // The overrides are deliberately loose (many call sites pass nested partials
  // or focused slices); build the full base then cast the merged result to
  // State so exactOptionalPropertyTypes doesn't reject the spread widening.
  return {
    authPanel: { open: false } as never,
    modelPicker: {
      open: false,
      step: 'provider',
      providerOptions: [],
      modelOptions: [],
      filteredOptions: [],
      selected: 0,
      searchQuery: '',
      purpose: 'switch',
    },
    modePicker: { open: false, modes: [], selected: 0 },
    autonomyPicker: { open: false, options: [], selected: 0 },
    themePicker: { open: false, selected: 0 },
    skillPicker: { open: false, entries: [], selected: 0 },
    resourceMenu: { open: false, snapshot: null, selected: 0, filter: '', filtering: false },
    designPicker: { open: false, kits: [], selected: 0, stack: 'web' },
    promptPicker: {
      open: false,
      all: [],
      categories: [],
      recentSlugs: [],
      catIndex: 0,
      selected: 0,
    },
    resumePicker: { open: false, sessions: [], selected: 0, busy: false },
    settingsPicker: {
      open: false,
      field: 0,
      mode: 'off',
      delayMs: 0,
      thinkingWordEditing: false,
      thinkingWordDraft: '',
      filter: '',
    } as never,
    pluginPicker: { open: false, items: [], selected: 0, busy: false },
    mcpPicker: { open: false, items: [], selected: 0, busy: false },
    toolsPicker: { open: false, items: [], selected: 0, busy: false, filter: undefined },
    helpPanel: { open: false, entries: [], selected: 0, filter: '' },
    brainPanel: {
      open: false,
      riskLevel: 'off',
      log: [],
      selected: 0,
      row: 0,
      busy: false,
      hint: undefined,
      view: 'log',
      settings: undefined,
    },
    shadowPanel: { open: false } as never,
    fKeyPicker: { open: false, selected: 0 },
    picker: { open: false, query: '', matches: [], selected: 0 },
    slashPicker: { open: false, query: '', matches: [], selected: 0 },
    projectPicker: { open: false, allItems: [], items: [], selected: 0, filter: '' },
    statuslinePicker: { open: false, field: 0, hiddenItems: [], visibleChips: [] },
    sendModePicker: null,
    processListOpen: false,
    helpOpen: false,
    monitorOpen: false,
    agentsMonitorOpen: false,
    worktreeMonitorOpen: false,
    todosMonitorOpen: false,
    queuePanelOpen: false,
    goalPanelOpen: false,
    sessionsPanelOpen: false,
    coordinator: { monitorOpen: false, goals: [], timeline: [], knowledgeCount: 0, healthy: false },
    goalRun: null,
    rewindOverlay: null,
    ...overrides,
  } as State;
}

function makeHost(
  state: State,
  overrides: Partial<PickerKeysHost> = {},
): PickerKeysHost & {
  dispatch: ReturnType<typeof vi.fn>;
  submit: ReturnType<typeof vi.fn>;
  switchProviderAndModel: ReturnType<typeof vi.fn>;
  setLiveProvider: ReturnType<typeof vi.fn>;
  setLiveModel: ReturnType<typeof vi.fn>;
  setActiveMaxContext: ReturnType<typeof vi.fn>;
} {
  const dispatch = vi.fn<() => void>();
  const submit = vi.fn<() => void>();
  const switchProviderAndModel = vi.fn().mockReturnValue(null);
  const setLiveProvider = vi.fn<() => void>();
  const setLiveModel = vi.fn<() => void>();
  const setActiveMaxContext = vi.fn<() => void>();
  return {
    state,
    dispatch,
    lastEnterAtRef: { current: 0 },
    inputGateRef: { current: false },
    switchProviderAndModel,
    setLiveProvider,
    setLiveModel,
    setActiveMaxContext,
    getAgentCtxMaxContext: () => 200_000,
    activeMaxContext: 200_000,
    currentContextTokens: 0,
    currentProvider: undefined,
    currentModel: undefined,
    switchAutonomy: vi.fn<() => void>(),
    submit,
    onAuthEnter: vi.fn<() => void>(),
    onAuthBack: vi.fn<() => void>(),
    onAuthShortcut: vi.fn<() => void>(),
    onAuthPromptSubmit: vi.fn<() => void>(),
    onAuthPromptCancel: vi.fn(),
    onAuthConfirm: vi.fn(),
    onAuthFlowCancel: vi.fn(),
    onAuthCtrlC: vi.fn(),
    onPromptPickerEnter: vi.fn(),
    onPromptPickerFavorite: vi.fn(),
    onPromptPickerEdit: vi.fn(),
    onResumePickerEnter: vi.fn(),
    onSessionsPanelEnter: vi.fn(),
    onProjectPickerEnter: vi.fn(),
    onSlashPickerEnter: vi.fn(),
    onSettingsPickerEnter: vi.fn(),
    onPluginPickerToggle: vi.fn(),
    onFKeyPickerEnter: vi.fn(),
    onPickerEnter: vi.fn(),
    onSlashPickerTab: vi.fn(),
    ...overrides,
  } as unknown as PickerKeysHost & {
    dispatch: ReturnType<typeof vi.fn>;
    submit: ReturnType<typeof vi.fn>;
    switchProviderAndModel: ReturnType<typeof vi.fn>;
    setLiveProvider: ReturnType<typeof vi.fn>;
    setLiveModel: ReturnType<typeof vi.fn>;
    setActiveMaxContext: ReturnType<typeof vi.fn>;
  };
}

function runPickerKey(
  host: PickerKeysHost,
  input: string,
  event: KeyEvent,
  isEnter: boolean,
): void {
  function Probe(): React.ReactElement | null {
    const handler = usePickerKeys(host);
    useEffect(() => {
      handler(input, event, isEnter);
    }, [handler]);
    return null;
  }

  const { unmount } = render(React.createElement(Probe));
  unmount();
}

describe('usePickerKeys — model and mode flows', () => {
  it('picks a provider from the model picker on Enter', () => {
    const providers: ProviderOption[] = [
      { id: 'openai', family: 'openai', models: ['gpt-4.1', 'gpt-4o'] },
    ];
    const host = makeHost(
      baseState({
        modelPicker: {
          open: true,
          step: 'provider',
          providerOptions: providers,
          modelOptions: [],
          filteredOptions: [],
          selected: 0,
          searchQuery: '',
          purpose: 'switch',
        },
      }),
    );

    runPickerKey(host, '', key(), true);

    expect(host.dispatch).toHaveBeenCalledWith({
      type: 'modelPickerPickProvider',
      providerId: 'openai',
      models: ['gpt-4.1', 'gpt-4o'],
    });
  });

  it('searches and selects a model, then closes the picker and emits structured switch history', () => {
    const host = makeHost(
      baseState({
        modelPicker: {
          open: true,
          step: 'model',
          providerOptions: [],
          modelOptions: ['gpt-4.1', 'gpt-4o'],
          filteredOptions: ['gpt-4o'],
          selected: 0,
          searchQuery: 'o',
          pickedProviderId: 'openai',
          purpose: 'switch',
        },
      }),
    );

    runPickerKey(host, '4', key(), false);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'modelPickerSearch', query: 'o4' });

    host.dispatch.mockClear();
    host.lastEnterAtRef.current = 0;

    runPickerKey(host, '', key(), true);
    expect(host.switchProviderAndModel).toHaveBeenCalledWith('openai', 'gpt-4o');
    expect(host.setLiveProvider).toHaveBeenCalledWith('openai');
    expect(host.setLiveModel).toHaveBeenCalledWith('gpt-4o');
    expect(host.setActiveMaxContext).toHaveBeenCalledWith(200_000);
    expect(host.dispatch).toHaveBeenCalledWith({
      type: 'addEntry',
      entry: {
        kind: 'model-switch',
        fromProvider: undefined,
        fromModel: undefined,
        fromContext: 200_000,
        toProvider: 'openai',
        toModel: 'gpt-4o',
        toContext: 200_000,
        requestTokens: undefined,
        runActive: true,
      },
    });
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'modelPickerClose' });
  });

  it('treats a CR/LF-normalized Enter as selection, not model-search text', () => {
    const host = makeHost(
      baseState({
        modelPicker: {
          open: true,
          step: 'model',
          providerOptions: [],
          modelOptions: ['gpt-4o'],
          filteredOptions: ['gpt-4o'],
          selected: 0,
          searchQuery: '',
          pickedProviderId: 'openai',
          purpose: 'switch',
        },
      }),
    );

    runPickerKey(host, '\r', key(), true);

    expect(host.switchProviderAndModel).toHaveBeenCalledWith('openai', 'gpt-4o');
    expect(host.dispatch).not.toHaveBeenCalledWith({ type: 'modelPickerSearch', query: '\r' });
  });

  it('warns when manual model selection reduces the context window', () => {
    const host = makeHost(
      baseState({
        modelPicker: {
          open: true,
          step: 'model',
          providerOptions: [],
          modelOptions: ['small'],
          filteredOptions: ['small'],
          selected: 0,
          searchQuery: '',
          pickedProviderId: 'openai',
          purpose: 'switch',
        },
      }),
      {
        getAgentCtxMaxContext: () => 32_000,
        activeMaxContext: 200_000,
        currentContextTokens: 24_000,
      },
    );

    runPickerKey(host, '', key(), true);

    expect(host.dispatch).toHaveBeenCalledWith({
      type: 'addEntry',
      entry: {
        kind: 'model-switch',
        fromProvider: undefined,
        fromModel: undefined,
        fromContext: 200_000,
        toProvider: 'openai',
        toModel: 'small',
        toContext: 32_000,
        requestTokens: 24_000,
        runActive: true,
      },
    });
  });

  it('closes the mode picker and submits /mode <id> on Enter', () => {
    const modes: ModeOption[] = [
      {
        id: 'default',
        family: 'balanced',
        name: 'Default',
        description: 'Balanced',
        isActive: false,
      },
      {
        id: 'review',
        family: 'deep',
        name: 'Review',
        description: 'Review-oriented',
        isActive: true,
      },
    ];
    const host = makeHost(
      baseState({
        modePicker: {
          open: true,
          modes,
          selected: 1,
        },
      }),
    );

    runPickerKey(host, '', key(), true);

    expect(host.dispatch).toHaveBeenCalledWith({ type: 'modePickerClose' });
    expect(host.submit).toHaveBeenCalledWith('/mode review');
  });

  it('does nothing on empty mode picker Enter', () => {
    const host = makeHost(
      baseState({
        modePicker: { open: true, modes: [], selected: 0 },
      }),
    );
    host.dispatch.mockClear();

    runPickerKey(host, '', key(), true);

    expect(host.dispatch).not.toHaveBeenCalledWith({ type: 'modePickerClose' });
  });

  it('navigates model picker with arrow keys', () => {
    const host = makeHost(
      baseState({
        modelPicker: {
          open: true,
          step: 'provider',
          providerOptions: [{ id: 'openai', family: 'openai', models: ['gpt-4'] }],
          modelOptions: [],
          filteredOptions: [],
          selected: 0,
          searchQuery: '',
          purpose: 'switch',
        },
      }),
    );

    runPickerKey(host, '', key({ upArrow: true }), false);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'modelPickerMove', delta: -1 });

    host.dispatch.mockClear();
    runPickerKey(host, '', key({ downArrow: true }), false);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'modelPickerMove', delta: 1 });
  });

  it('handles model picker escape - step model goes back, step provider closes', () => {
    const host = makeHost(
      baseState({
        modelPicker: {
          open: true,
          step: 'model',
          providerOptions: [],
          modelOptions: ['gpt-4'],
          filteredOptions: ['gpt-4'],
          selected: 0,
          searchQuery: '',
          pickedProviderId: 'openai',
          purpose: 'switch',
        },
      }),
    );

    runPickerKey(host, '', key({ escape: true }), false);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'modelPickerBack' });

    host.dispatch.mockClear();
    // Provider step should close
    const host2 = makeHost(
      baseState({
        modelPicker: {
          open: true,
          step: 'provider',
          providerOptions: [],
          modelOptions: [],
          filteredOptions: [],
          selected: 0,
          searchQuery: '',
          purpose: 'switch',
        },
      }),
    );
    runPickerKey(host2, '', key({ escape: true }), false);
    expect(host2.dispatch).toHaveBeenCalledWith({ type: 'modelPickerClose' });
  });

  it('handles model picker search on model step', () => {
    const host = makeHost(
      baseState({
        modelPicker: {
          open: true,
          step: 'model',
          providerOptions: [],
          modelOptions: ['gpt-4', 'gpt-4o'],
          filteredOptions: ['gpt-4', 'gpt-4o'],
          selected: 0,
          searchQuery: '',
          pickedProviderId: 'openai',
          purpose: 'switch',
        },
      }),
    );

    runPickerKey(host, '4', key(), false);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'modelPickerSearch', query: '4' });
  });

  it('handles model picker backspace on model step (pop char or go back)', () => {
    const host = makeHost(
      baseState({
        modelPicker: {
          open: true,
          step: 'model',
          providerOptions: [],
          modelOptions: ['gpt-4'],
          filteredOptions: ['gpt-4'],
          selected: 0,
          searchQuery: 'g',
          pickedProviderId: 'openai',
          purpose: 'switch',
        },
      }),
    );

    // First backspace with searchQuery='g' pops the char (search becomes '')
    runPickerKey(host, '', key({ backspace: true }), false);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'modelPickerSearch', query: '' });
  });

  it('handles model picker wheel', () => {
    const host = makeHost(
      baseState({
        modelPicker: {
          open: true,
          step: 'provider',
          providerOptions: [{ id: 'openai', family: 'openai', models: ['gpt-4'] }],
          modelOptions: [],
          filteredOptions: [],
          selected: 0,
          searchQuery: '',
          purpose: 'switch',
        },
      }),
    );

    // Wheel < 0 means scroll down → delta 1
    runPickerKey(
      host,
      '',
      key({
        mouse: {
          kind: 'wheel',
          button: 'none',
          x: 1,
          y: 1,
          wheel: -1,
          shift: false,
          meta: false,
          ctrl: false,
          motion: false,
        },
      }),
      false,
    );
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'modelPickerMove', delta: 1 });

    host.dispatch.mockClear();
    // Wheel > 0 means scroll up → delta -1
    runPickerKey(
      host,
      '',
      key({
        mouse: {
          kind: 'wheel',
          button: 'none',
          x: 1,
          y: 1,
          wheel: 1,
          shift: false,
          meta: false,
          ctrl: false,
          motion: false,
        },
      }),
      false,
    );
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'modelPickerMove', delta: -1 });
  });

  it('handles model picker with purpose pick on Enter', () => {
    const onModelPicked = vi.fn();
    const host = makeHost(
      baseState({
        modelPicker: {
          open: true,
          step: 'model',
          providerOptions: [],
          modelOptions: ['gpt-4o'],
          filteredOptions: ['gpt-4o'],
          selected: 0,
          searchQuery: '',
          pickedProviderId: 'openai',
          purpose: 'pick',
        },
      }),
      { onModelPicked },
    );
    host.dispatch.mockClear();
    host.lastEnterAtRef.current = 0;

    runPickerKey(host, '', key(), true);

    expect(onModelPicked).toHaveBeenCalledWith('openai', 'gpt-4o');
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'modelPickerClose' });
  });

  it('handles model picker Enter with async switchProviderAndModel', () => {
    const switchProviderAndModel = vi.fn().mockResolvedValue(null);
    const host = makeHost(
      baseState({
        modelPicker: {
          open: true,
          step: 'model',
          providerOptions: [],
          modelOptions: ['gpt-4o'],
          filteredOptions: ['gpt-4o'],
          selected: 0,
          searchQuery: '',
          pickedProviderId: 'openai',
          purpose: 'switch',
        },
      }),
      { switchProviderAndModel },
    );
    host.dispatch.mockClear();
    host.lastEnterAtRef.current = 0;

    runPickerKey(host, '', key(), true);

    expect(switchProviderAndModel).toHaveBeenCalledWith('openai', 'gpt-4o');
  });

  it('handles selected provider out of bounds on Enter', () => {
    const host = makeHost(
      baseState({
        modelPicker: {
          open: true,
          step: 'provider',
          providerOptions: [],
          modelOptions: [],
          filteredOptions: [],
          selected: 999,
          searchQuery: '',
          purpose: 'switch',
        },
      }),
    );
    host.dispatch.mockClear();

    runPickerKey(host, '', key(), true);

    // No dispatch because opt is undefined
    expect(host.dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'modelPickerPickProvider' }),
    );
  });
});

describe('usePickerKeys — auth panel', () => {
  it('handles Ctrl+C in auth panel', () => {
    const onAuthCtrlC = vi.fn();
    const host = makeHost(
      baseState({
        authPanel: { open: true, view: 'list' },
      }),
      { onAuthCtrlC },
    );

    runPickerKey(host, 'c', key({ ctrl: true }), false);
    expect(onAuthCtrlC).toHaveBeenCalled();
  });

  it('handles Ctrl+C with uppercase C', () => {
    const onAuthCtrlC = vi.fn();
    const host = makeHost(
      baseState({
        authPanel: { open: true, view: 'list' },
      }),
      { onAuthCtrlC },
    );

    runPickerKey(host, 'C', key({ ctrl: true }), false);
    expect(onAuthCtrlC).toHaveBeenCalled();
  });

  it('handles auth panel input escape and submit', () => {
    const onAuthPromptCancel = vi.fn();
    const onAuthPromptSubmit = vi.fn();
    const host = makeHost(
      baseState({
        authPanel: { open: true, input: { label: 'key', masked: true, draft: 'test' } },
      }),
      { onAuthPromptCancel, onAuthPromptSubmit },
    );

    runPickerKey(host, '', key({ escape: true }), false);
    expect(onAuthPromptCancel).toHaveBeenCalled();

    host.lastEnterAtRef.current = 0;
    runPickerKey(host, '', key(), true);
    expect(onAuthPromptSubmit).toHaveBeenCalled();
  });

  it('handles auth panel input backspace', () => {
    const host = makeHost(
      baseState({
        authPanel: { open: true, input: { label: 'key', masked: true, draft: 'test' } },
      }),
    );

    runPickerKey(host, '', key({ backspace: true }), false);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'authPromptChange', draft: 'tes' });
  });

  it('handles auth panel input printable characters', () => {
    const host = makeHost(
      baseState({
        authPanel: { open: true, input: { label: 'key', masked: true, draft: '' } },
      }),
    );

    runPickerKey(host, 'hello', key(), false);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'authPromptChange', draft: 'hello' });
  });

  it('filters control characters from pasted input', () => {
    const host = makeHost(
      baseState({
        authPanel: { open: true, input: { label: 'key', masked: true, draft: '' } },
      }),
    );

    // Input with a newline (0x0a) that should be filtered
    runPickerKey(host, 'key\n', key(), false);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'authPromptChange', draft: 'key' });
  });

  it('handles auth confirm y/n', () => {
    const onAuthConfirm = vi.fn();
    const host = makeHost(
      baseState({
        authPanel: {
          open: true,
          confirm: {
            question: 'Delete?',
            action: { kind: 'delete-key', providerId: 'p', label: 'k' },
          },
        },
      }),
      { onAuthConfirm },
    );

    runPickerKey(host, 'y', key(), false);
    expect(onAuthConfirm).toHaveBeenCalledWith(true);

    onAuthConfirm.mockClear();
    runPickerKey(host, 'n', key(), false);
    expect(onAuthConfirm).toHaveBeenCalledWith(false);

    onAuthConfirm.mockClear();
    runPickerKey(host, '', key({ escape: true }), false);
    expect(onAuthConfirm).toHaveBeenCalledWith(false);
  });

  it('handles auth confirm with N uppercase', () => {
    const onAuthConfirm = vi.fn();
    const host = makeHost(
      baseState({
        authPanel: {
          open: true,
          confirm: { question: '?', action: { kind: 'delete-key', providerId: 'p', label: 'k' } },
        },
      }),
      { onAuthConfirm },
    );

    runPickerKey(host, 'N', key(), false);
    expect(onAuthConfirm).toHaveBeenCalledWith(false);

    onAuthConfirm.mockClear();
    runPickerKey(host, 'Y', key(), false);
    expect(onAuthConfirm).toHaveBeenCalledWith(true);
  });

  it('handles auth flow view escape and Enter', () => {
    const onAuthFlowCancel = vi.fn();
    const onAuthEnter = vi.fn();
    const host = makeHost(
      baseState({
        authPanel: { open: true, view: 'flow', busy: false },
      }),
      { onAuthFlowCancel, onAuthEnter },
    );

    runPickerKey(host, '', key({ escape: true }), false);
    expect(onAuthFlowCancel).toHaveBeenCalled();

    host.lastEnterAtRef.current = 0;
    runPickerKey(host, '', key(), true);
    expect(onAuthEnter).toHaveBeenCalled();
  });

  it('handles auth panel escape back', () => {
    const onAuthBack = vi.fn();
    const host = makeHost(
      baseState({
        authPanel: { open: true, view: 'provider', providerId: 'openai' },
      }),
      { onAuthBack },
    );

    runPickerKey(host, '', key({ escape: true }), false);
    expect(onAuthBack).toHaveBeenCalled();
  });

  it('handles auth panel navigation with arrows and wheel', () => {
    const host = makeHost(
      baseState({
        authPanel: { open: true, view: 'list' },
      }),
    );

    runPickerKey(host, '', key({ upArrow: true }), false);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'authMove', delta: -1 });

    host.dispatch.mockClear();
    runPickerKey(host, '', key({ downArrow: true }), false);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'authMove', delta: 1 });

    // Wheel > 0 (scroll up) → delta -1
    host.dispatch.mockClear();
    runPickerKey(
      host,
      '',
      key({
        mouse: {
          kind: 'wheel',
          button: 'none',
          x: 1,
          y: 1,
          wheel: 1,
          shift: false,
          meta: false,
          ctrl: false,
          motion: false,
        },
      }),
      false,
    );
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'authMove', delta: -1 });

    // Wheel < 0 (scroll down) → delta 1
    host.dispatch.mockClear();
    runPickerKey(
      host,
      '',
      key({
        mouse: {
          kind: 'wheel',
          button: 'none',
          x: 1,
          y: 1,
          wheel: -1,
          shift: false,
          meta: false,
          ctrl: false,
          motion: false,
        },
      }),
      false,
    );
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'authMove', delta: 1 });
  });

  it('handles auth panel Enter on list view', () => {
    const onAuthEnter = vi.fn();
    const host = makeHost(
      baseState({
        authPanel: { open: true, view: 'list' },
      }),
      { onAuthEnter },
    );
    host.lastEnterAtRef.current = 0;

    runPickerKey(host, '', key(), true);
    expect(onAuthEnter).toHaveBeenCalled();
  });

  it('handles auth catalog filter mode typing', () => {
    const host = makeHost(
      baseState({
        authPanel: { open: true, view: 'catalog', filter: '' },
      }),
    );

    runPickerKey(host, 'a', key(), false);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'authFilter', filter: 'a' });
  });

  it('handles auth catalog filter backspace', () => {
    const host = makeHost(
      baseState({
        authPanel: { open: true, view: 'catalog', filter: 'ab' },
      }),
    );

    runPickerKey(host, '', key({ backspace: true }), false);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'authFilter', filter: 'a' });
  });

  it('handles auth provider view shortcuts u and d', () => {
    const onAuthShortcut = vi.fn();
    const host = makeHost(
      baseState({
        authPanel: { open: true, view: 'provider', providerId: 'openai' },
      }),
      { onAuthShortcut },
    );

    runPickerKey(host, 'u', key(), false);
    expect(onAuthShortcut).toHaveBeenCalledWith('u');

    onAuthShortcut.mockClear();
    runPickerKey(host, 'd', key(), false);
    expect(onAuthShortcut).toHaveBeenCalledWith('d');
  });
});

describe('usePickerKeys — autonomy picker', () => {
  it('navigates and selects autonomy picker on Enter', () => {
    const switchAutonomy = vi.fn();
    const host = makeHost(
      baseState({
        autonomyPicker: { open: true, options: [{ mode: 'auto', label: 'Auto' }], selected: 0 },
      }),
      { switchAutonomy },
    );
    host.lastEnterAtRef.current = 0;

    runPickerKey(host, '', key({ downArrow: true }), false);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'autonomyPickerMove', delta: 1 });

    host.dispatch.mockClear();
    runPickerKey(host, '', key({ upArrow: true }), false);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'autonomyPickerMove', delta: -1 });

    host.dispatch.mockClear();
    // Wheel > 0 → scroll up → delta -1
    runPickerKey(
      host,
      '',
      key({
        mouse: {
          kind: 'wheel',
          button: 'none',
          x: 1,
          y: 1,
          wheel: 1,
          shift: false,
          meta: false,
          ctrl: false,
          motion: false,
        },
      }),
      false,
    );
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'autonomyPickerMove', delta: -1 });

    host.dispatch.mockClear();
    runPickerKey(host, '', key({ escape: true }), false);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'autonomyPickerClose' });

    host.dispatch.mockClear();
    runPickerKey(host, '', key(), true);
    expect(switchAutonomy).toHaveBeenCalledWith('auto');
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'autonomyPickerClose' });
  });

  it('shows hint when autonomy switch returns error', () => {
    const switchAutonomy = vi.fn().mockReturnValue('Error message');
    const host = makeHost(
      baseState({
        autonomyPicker: { open: true, options: [{ mode: 'auto', label: 'Auto' }], selected: 0 },
      }),
      { switchAutonomy },
    );
    host.lastEnterAtRef.current = 0;

    runPickerKey(host, '', key(), true);
    expect(host.dispatch).toHaveBeenCalledWith({
      type: 'autonomyPickerHint',
      text: 'Error message',
    });
  });

  it('does nothing on autonomy picker Enter with no option', () => {
    const switchAutonomy = vi.fn();
    const host = makeHost(
      baseState({
        autonomyPicker: { open: true, options: [], selected: 0 },
      }),
      { switchAutonomy },
    );

    runPickerKey(host, '', key(), true);
    expect(switchAutonomy).not.toHaveBeenCalled();
  });
});

describe('usePickerKeys — theme picker', () => {
  it('navigates, applies, and closes the theme picker', () => {
    const onThemePickerEnter = vi.fn();
    const host = makeHost(baseState({ themePicker: { open: true, selected: 0 } }), {
      onThemePickerEnter,
    });

    runPickerKey(host, '', key({ downArrow: true }), false);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'themePickerMove', delta: 1 });

    host.dispatch.mockClear();
    runPickerKey(host, '', key({ upArrow: true }), false);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'themePickerMove', delta: -1 });

    host.dispatch.mockClear();
    runPickerKey(
      host,
      '',
      key({
        mouse: {
          kind: 'wheel',
          button: 'none',
          x: 1,
          y: 1,
          wheel: -1,
          shift: false,
          meta: false,
          ctrl: false,
          motion: false,
        },
      }),
      false,
    );
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'themePickerMove', delta: 1 });

    host.lastEnterAtRef.current = 0;
    runPickerKey(host, '', key(), true);
    expect(onThemePickerEnter).toHaveBeenCalledTimes(1);
    expect(host.inputGateRef.current).toBe(false);

    host.dispatch.mockClear();
    runPickerKey(host, '', key({ escape: true }), false);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'themePickerClose' });
  });
});

describe('usePickerKeys — skill picker', () => {
  it('navigates, opens the focused skill, and closes', () => {
    const host = makeHost(
      baseState({
        skillPicker: {
          open: true,
          entries: [
            {
              name: 'release-check',
              trigger: 'release validation',
              scope: ['release'],
              source: 'bundled',
              path: '/skills/release-check/SKILL.md',
            },
          ],
          selected: 0,
        },
      }),
    );

    runPickerKey(host, '', key({ downArrow: true }), false);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'skillPickerMove', delta: 1 });

    host.dispatch.mockClear();
    host.lastEnterAtRef.current = 0;
    runPickerKey(host, '', key(), true);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'skillPickerClose' });
    expect(host.submit).toHaveBeenCalledWith('/skill release-check');

    host.dispatch.mockClear();
    runPickerKey(host, '', key({ escape: true }), false);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'skillPickerClose' });
  });
});

describe('usePickerKeys — resource menu', () => {
  const action = {
    key: 'x',
    label: 'clear history',
    command: '/provider-status clear openai gpt-test',
    confirm: true,
  } as const;
  const snapshot = {
    id: 'provider-status' as const,
    title: 'Provider health',
    items: [{ id: 'pair', label: 'openai/gpt-test', details: [], actions: [action] }],
  };

  it('navigates and asks before a destructive action', () => {
    const host = makeHost(
      baseState({
        resourceMenu: { open: true, snapshot, selected: 0, filter: '', filtering: false },
      }),
    );
    runPickerKey(host, '', key({ downArrow: true }), false);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'resourceMenuMove', delta: 1 });

    host.dispatch.mockClear();
    runPickerKey(host, 'x', key(), false);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'resourceMenuConfirm', action });
    expect(host.submit).not.toHaveBeenCalled();
  });

  it('runs a confirmed action only after y', () => {
    const host = makeHost(
      baseState({
        resourceMenu: {
          open: true,
          snapshot,
          selected: 0,
          filter: '',
          filtering: false,
          pendingAction: action,
        },
      }),
    );
    runPickerKey(host, 'y', key(), false);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'resourceMenuClose' });
    expect(host.submit).toHaveBeenCalledWith(action.command);
  });

  it('filters detail text and exits filter mode without closing', () => {
    const host = makeHost(
      baseState({
        resourceMenu: { open: true, snapshot, selected: 0, filter: '', filtering: false },
      }),
    );
    runPickerKey(host, '/', key(), false);
    expect(host.dispatch).toHaveBeenCalledWith({
      type: 'resourceMenuFilter',
      filter: '',
      active: true,
    });

    const filtering = makeHost(
      baseState({
        resourceMenu: { open: true, snapshot, selected: 0, filter: 'ope', filtering: true },
      }),
    );
    runPickerKey(filtering, 'n', key(), false);
    expect(filtering.dispatch).toHaveBeenCalledWith({
      type: 'resourceMenuFilter',
      filter: 'open',
      active: true,
    });
  });
});

describe('usePickerKeys — design picker', () => {
  it('navigates design picker and selects on Enter', () => {
    const host = makeHost(
      baseState({
        designPicker: {
          open: true,
          kits: [{ id: 'modern', name: 'Modern' }],
          selected: 0,
          stack: 'web',
        },
      }),
    );
    host.lastEnterAtRef.current = 0;

    runPickerKey(host, '', key({ downArrow: true }), false);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'designPickerMove', delta: 1 });

    // Test left arrow separately (right arrow from 'web' goes to idx 1 = 'react-native')
    runPickerKey(host, '', key({ leftArrow: true }), false);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'designPickerStack', stack: 'compose' });

    host.dispatch.mockClear();
    runPickerKey(host, '', key(), true);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'designPickerClose' });
    expect(host.submit).toHaveBeenCalledWith('/design modern web');
  });

  it('submits nothing on design picker Enter with no kit', () => {
    const host = makeHost(
      baseState({
        designPicker: {
          open: true,
          kits: [],
          selected: 0,
          stack: 'web',
        },
      }),
    );
    host.lastEnterAtRef.current = 0;

    runPickerKey(host, '', key(), true);
    expect(host.submit).not.toHaveBeenCalled();
  });
});

describe('usePickerKeys — prompt picker', () => {
  it('navigates prompt picker with arrows and category arrows', () => {
    const onPromptPickerEnter = vi.fn();
    const onPromptPickerFavorite = vi.fn();
    const onPromptPickerEdit = vi.fn();
    const host = makeHost(
      baseState({
        promptPicker: {
          open: true,
          all: [],
          categories: [],
          recentSlugs: [],
          catIndex: 0,
          selected: 0,
        },
      }),
      { onPromptPickerEnter, onPromptPickerFavorite, onPromptPickerEdit },
    );
    host.lastEnterAtRef.current = 0;

    runPickerKey(host, '', key({ leftArrow: true }), false);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'promptPickerCategory', delta: -1 });

    runPickerKey(host, '', key({ rightArrow: true }), false);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'promptPickerCategory', delta: 1 });

    runPickerKey(host, '', key(), true);
    expect(onPromptPickerEnter).toHaveBeenCalled();

    runPickerKey(host, 'f', key(), false);
    expect(onPromptPickerFavorite).toHaveBeenCalled();

    runPickerKey(host, 'e', key(), false);
    expect(onPromptPickerEdit).toHaveBeenCalled();
  });
});

describe('usePickerKeys — resume picker', () => {
  it('navigates resume picker and calls onResumePickerEnter on Enter', () => {
    const onResumePickerEnter = vi.fn().mockResolvedValue(undefined);
    const host = makeHost(
      baseState({
        resumePicker: {
          open: true,
          sessions: [{ id: 's1', title: 'Session 1' }],
          selected: 0,
          busy: false,
        },
      }),
      { onResumePickerEnter },
    );
    host.lastEnterAtRef.current = 0;

    runPickerKey(host, '', key({ downArrow: true }), false);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'resumePickerMove', delta: 1 });

    host.dispatch.mockClear();
    runPickerKey(host, '', key({ escape: true }), false);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'resumePickerClose' });

    host.dispatch.mockClear();
    // Wheel > 0 → scroll up → delta -1
    runPickerKey(
      host,
      '',
      key({
        mouse: {
          kind: 'wheel',
          button: 'none',
          x: 1,
          y: 1,
          wheel: 1,
          shift: false,
          meta: false,
          ctrl: false,
          motion: false,
        },
      }),
      false,
    );
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'resumePickerMove', delta: -1 });

    host.dispatch.mockClear();
    runPickerKey(host, '', key(), true);
    expect(onResumePickerEnter).toHaveBeenCalled();
  });
});

describe('usePickerKeys — settings picker', () => {
  it('handles thinking word editing escape and Enter', () => {
    const host = makeHost(
      baseState({
        settingsPicker: {
          open: true,
          field: 0,
          mode: 'off',
          delayMs: 0,
          thinkingWordEditing: true,
          thinkingWordDraft: 'custom',
        },
      }),
    );

    runPickerKey(host, '', key({ escape: true }), false);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'settingsThinkingEditCancel' });

    host.lastEnterAtRef.current = 0;
    runPickerKey(host, '', key(), true);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'settingsThinkingEditCommit' });
  });

  it('handles thinking word editing backspace and typing', () => {
    const host = makeHost(
      baseState({
        settingsPicker: {
          open: true,
          field: 0,
          mode: 'off',
          delayMs: 0,
          thinkingWordEditing: true,
          thinkingWordDraft: 'abc',
        },
      }),
    );

    runPickerKey(host, '', key({ backspace: true }), false);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'settingsThinkingEditChange', draft: 'ab' });

    host.dispatch.mockClear();
    runPickerKey(host, 'd', key(), false);
    expect(host.dispatch).toHaveBeenCalledWith({
      type: 'settingsThinkingEditChange',
      draft: 'abcd',
    });
  });

  it('handles settings picker escape and ctrl+s to close', () => {
    const host = makeHost(
      baseState({
        settingsPicker: { open: true, field: 0, mode: 'off', delayMs: 0 },
      }),
    );

    runPickerKey(host, '', key({ escape: true }), false);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'settingsClose' });

    host.dispatch.mockClear();
    runPickerKey(host, 's', key({ ctrl: true }), false);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'settingsClose' });
  });

  it('handles settings picker ctrl+letter jump and slash filter', () => {
    const host = makeHost(
      baseState({
        settingsPicker: { open: true, field: 0, mode: 'off', delayMs: 0, filter: '' },
      }),
    );

    // Ctrl+B - should attempt field jump
    runPickerKey(host, 'b', key({ ctrl: true }), false);

    host.dispatch.mockClear();
    // Slash starts filter mode (filter starts as '')
    runPickerKey(host, '/', key(), false);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'settingsFilterSet', filter: '/' });
  });

  it('handles settings filter mode with escape, backspace, and typing', () => {
    const host = makeHost(
      baseState({
        settingsPicker: { open: true, field: 0, mode: 'off', delayMs: 0, filter: 'test' },
      }),
    );

    // Escape in filter mode is caught by the outer escape handler → settingsClose
    runPickerKey(host, '', key({ escape: true }), false);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'settingsClose' });

    host.dispatch.mockClear();
    // Backspace on filter with 'test' → 'tes'
    const host2 = makeHost(
      baseState({
        settingsPicker: { open: true, field: 0, mode: 'off', delayMs: 0, filter: 'test' },
      }),
    );
    runPickerKey(host2, '', key({ backspace: true }), false);
    expect(host2.dispatch).toHaveBeenCalledWith({ type: 'settingsFilterSet', filter: 'tes' });

    host2.dispatch.mockClear();
    // Set filter to single char
    const host3 = makeHost(
      baseState({
        settingsPicker: { open: true, field: 0, mode: 'off', delayMs: 0, filter: 't' },
      }),
    );
    runPickerKey(host3, '', key({ backspace: true }), false);
    expect(host3.dispatch).toHaveBeenCalledWith({ type: 'settingsFilterSet', filter: '' });

    host3.dispatch.mockClear();
    const host4 = makeHost(
      baseState({
        settingsPicker: { open: true, field: 0, mode: 'off', delayMs: 0, filter: 'te' },
      }),
    );
    runPickerKey(host4, 's', key(), false);
    expect(host4.dispatch).toHaveBeenCalledWith({ type: 'settingsFilterSet', filter: 'tes' });
  });

  it('handles settings arrow navigation and value change', () => {
    const host = makeHost(
      baseState({
        settingsPicker: { open: true, field: 0, mode: 'off', delayMs: 0 },
      }),
    );

    runPickerKey(host, '', key({ upArrow: true }), false);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'settingsFieldMove', delta: -1 });

    runPickerKey(host, '', key({ downArrow: true }), false);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'settingsFieldMove', delta: 1 });

    runPickerKey(host, '', key({ leftArrow: true }), false);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'settingsValueChange', delta: -1 });

    runPickerKey(host, '', key({ rightArrow: true }), false);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'settingsValueChange', delta: 1 });

    runPickerKey(
      host,
      '',
      key({
        mouse: {
          kind: 'wheel',
          button: 'none',
          x: 1,
          y: 1,
          wheel: 1,
          shift: false,
          meta: false,
          ctrl: false,
          motion: false,
        },
      }),
      false,
    );
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'settingsFieldMove', delta: -1 });
  });

  it('handles settings Enter calls onSettingsPickerEnter', () => {
    const onSettingsPickerEnter = vi.fn();
    const host = makeHost(
      baseState({
        settingsPicker: { open: true, field: 0, mode: 'off', delayMs: 0 },
      }),
      { onSettingsPickerEnter },
    );
    host.lastEnterAtRef.current = 0;

    runPickerKey(host, '', key(), true);
    expect(onSettingsPickerEnter).toHaveBeenCalled();
  });
});

describe('usePickerKeys — plugin picker', () => {
  it('navigates plugin picker and toggles on Enter/arrow', () => {
    const onPluginPickerToggle = vi.fn();
    const host = makeHost(
      baseState({
        pluginPicker: {
          open: true,
          items: [{ id: 'p1', name: 'Plugin 1', enabled: false }],
          selected: 0,
          busy: false,
        },
      }),
      { onPluginPickerToggle },
    );
    host.lastEnterAtRef.current = 0;

    runPickerKey(host, '', key({ leftArrow: true }), false);
    expect(onPluginPickerToggle).toHaveBeenCalled();
  });
});

describe('usePickerKeys — MCP picker', () => {
  it('navigates MCP picker and handles r/R restart', () => {
    const onMcpPickerRestart = vi.fn();
    const onMcpPickerToggle = vi.fn();
    const host = makeHost(
      baseState({
        mcpPicker: {
          open: true,
          items: [{ id: 'm1', name: 'MCP 1', enabled: true }],
          selected: 0,
          busy: false,
        },
      }),
      { onMcpPickerRestart, onMcpPickerToggle },
    );
    host.lastEnterAtRef.current = 0;

    runPickerKey(host, 'r', key(), false);
    expect(onMcpPickerRestart).toHaveBeenCalled();

    runPickerKey(host, 'R', key(), false);
    expect(onMcpPickerRestart).toHaveBeenCalledTimes(2);

    runPickerKey(host, '', key({ leftArrow: true }), false);
    expect(onMcpPickerToggle).toHaveBeenCalled();
  });
});

describe('usePickerKeys — tools picker', () => {
  it('navigates tools picker and handles filter mode', () => {
    const onToolsPickerToggle = vi.fn();
    const host = makeHost(
      baseState({
        toolsPicker: {
          open: true,
          items: [{ name: 'tool1', enabled: true }],
          selected: 0,
          busy: false,
        },
      }),
      { onToolsPickerToggle },
    );
    host.lastEnterAtRef.current = 0;

    // Escape with filter clears it
    const hostWithFilter = makeHost(
      baseState({
        toolsPicker: { open: true, items: [], selected: 0, busy: false, filter: 'search' },
      }),
    );
    runPickerKey(hostWithFilter, '', key({ escape: true }), false);
    expect(hostWithFilter.dispatch).toHaveBeenCalledWith({ type: 'toolsPickerFilter', filter: '' });

    // Escape without filter closes
    runPickerKey(host, '', key({ escape: true }), false);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'toolsPickerClose' });

    // Printable chars → filter
    host.dispatch.mockClear();
    runPickerKey(host, 'x', key(), false);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'toolsPickerFilter', filter: 'x' });

    // Backspace on empty filter
    host.dispatch.mockClear();
    runPickerKey(host, '', key({ backspace: true }), false);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'toolsPickerFilter', filter: '' });
  });
});

describe('usePickerKeys — help panel', () => {
  it('navigates help panel with arrows and filter', () => {
    const onHelpPanelEnter = vi.fn();
    const host = makeHost(
      baseState({
        helpPanel: {
          open: true,
          entries: [{ command: '/help', description: 'Help' }],
          selected: 0,
          filter: '',
        },
      }),
      { onHelpPanelEnter },
    );
    host.lastEnterAtRef.current = 0;

    runPickerKey(host, '', key({ upArrow: true }), false);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'helpMove', delta: -1 });

    runPickerKey(host, '', key({ downArrow: true }), false);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'helpMove', delta: 1 });

    runPickerKey(
      host,
      '',
      key({
        mouse: {
          kind: 'wheel',
          button: 'none',
          x: 1,
          y: 1,
          wheel: 1,
          shift: false,
          meta: false,
          ctrl: false,
          motion: false,
        },
      }),
      false,
    );
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'helpMove', delta: -1 });

    // Escape closes
    runPickerKey(host, '', key({ escape: true }), false);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'helpClose' });

    // Typing filters
    host.dispatch.mockClear();
    runPickerKey(host, 't', key(), false);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'helpFilter', filter: 't' });

    // Backspace with filter clears char
    host.dispatch.mockClear();
    const hostFiltered = makeHost(
      baseState({
        helpPanel: {
          open: true,
          entries: [{ command: '/help', description: 'Help' }],
          selected: 0,
          filter: 'ab',
        },
      }),
    );
    runPickerKey(hostFiltered, '', key({ backspace: true }), false);
    expect(hostFiltered.dispatch).toHaveBeenCalledWith({ type: 'helpFilter', filter: 'a' });
  });
});

describe('usePickerKeys — brain panel', () => {
  it('handles brain panel settings view navigation', () => {
    const host = makeHost(
      baseState({
        brainPanel: {
          open: true,
          view: 'settings',
          row: 0,
          settings: {
            mode: 'interactive',
            riskLevel: 'medium',
            strategy: 'fallback',
            pool: ['gpt-4'],
            poolResolved: ['gpt-4'],
            usingSessionModel: false,
            councilEnabled: false,
            councilMinRisk: 'medium',
            voters: [],
            councilSeats: [],
            ledgerEnabled: false,
          },
          busy: false,
        },
      }),
    );

    runPickerKey(host, '', key({ escape: true }), false);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'brainClose' });

    runPickerKey(host, '', key({ tab: true }), false);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'brainView', view: 'log' });

    runPickerKey(host, '', key({ upArrow: true }), false);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'brainRowMove', delta: -1 });

    runPickerKey(host, '', key({ downArrow: true }), false);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'brainRowMove', delta: 1 });
  });

  it('handles brain panel settings left/right adjust', () => {
    const onBrainAdjust = vi.fn();
    const host = makeHost(
      baseState({
        brainPanel: {
          open: true,
          view: 'settings',
          row: 0,
          settings: {
            mode: 'interactive',
            riskLevel: 'medium',
            strategy: 'fallback',
            pool: ['gpt-4'],
            poolResolved: ['gpt-4'],
            usingSessionModel: false,
            councilEnabled: false,
            councilMinRisk: 'medium',
            voters: [],
            councilSeats: [],
            ledgerEnabled: false,
          },
          busy: false,
        },
      }),
      { onBrainAdjust },
    );

    runPickerKey(host, '', key({ leftArrow: true }), false);
    expect(onBrainAdjust).toHaveBeenCalledWith(expect.objectContaining({ kind: 'mode' }), -1);

    runPickerKey(host, '', key({ rightArrow: true }), false);
    expect(onBrainAdjust).toHaveBeenCalledWith(expect.objectContaining({ kind: 'mode' }), 1);
  });

  it('handles brain panel Enter on settings row', () => {
    const onBrainEnter = vi.fn();
    const host = makeHost(
      baseState({
        brainPanel: {
          open: true,
          view: 'settings',
          row: 0,
          settings: {
            mode: 'interactive',
            riskLevel: 'medium',
            strategy: 'fallback',
            pool: ['gpt-4'],
            poolResolved: ['gpt-4'],
            usingSessionModel: false,
            councilEnabled: false,
            councilMinRisk: 'medium',
            voters: [],
            councilSeats: [],
            ledgerEnabled: false,
          },
          busy: false,
        },
      }),
      { onBrainEnter },
    );
    host.lastEnterAtRef.current = 0;

    runPickerKey(host, '', key(), true);
    expect(onBrainEnter).toHaveBeenCalledWith(expect.objectContaining({ kind: 'mode' }));
  });

  it('handles brain panel delete on removable row', () => {
    const onBrainDelete = vi.fn();
    // Row 2 = poolModel(index=0) — supports delete
    const host = makeHost(
      baseState({
        brainPanel: {
          open: true,
          view: 'settings',
          row: 2,
          settings: {
            mode: 'interactive',
            riskLevel: 'medium',
            strategy: 'fallback',
            pool: ['gpt-4'],
            poolResolved: ['gpt-4'],
            usingSessionModel: false,
            councilEnabled: false,
            councilMinRisk: 'medium',
            voters: [],
            councilSeats: [],
            ledgerEnabled: false,
          },
          busy: false,
        },
      }),
      { onBrainDelete },
    );

    runPickerKey(host, 'd', key(), false);
    expect(onBrainDelete).toHaveBeenCalled();
  });

  it('handles brain panel voter modifier keys', () => {
    const onBrainVoterMod = vi.fn();
    // Settings with council enabled, 1 voter, no pool.
    // Rows: mode(0), risk(1), poolAdd(2), timeout(3), humanTimeout(4),
    //        terminalPolicy(5), councilToggle(6), councilMinRisk(7), voter(8),
    //        voterAdd(9), judge(10), ledgerToggle(11), heuristics(12-16), …
    // Row 8 = voter(index=0)
    const host = makeHost(
      baseState({
        brainPanel: {
          open: true,
          view: 'settings',
          row: 8,
          settings: {
            mode: 'interactive',
            riskLevel: 'medium',
            strategy: 'fallback',
            pool: [],
            poolResolved: [],
            usingSessionModel: false,
            councilEnabled: true,
            councilMinRisk: 'medium',
            voters: [{ label: 'Voter 1' }],
            councilSeats: ['Voter 1'],
            ledgerEnabled: false,
          },
          busy: false,
        },
      }),
      { onBrainVoterMod },
    );

    runPickerKey(host, 'p', key(), false);
    expect(onBrainVoterMod).toHaveBeenCalledWith(0, 'persona');

    onBrainVoterMod.mockClear();
    runPickerKey(host, 'v', key(), false);
    expect(onBrainVoterMod).toHaveBeenCalledWith(0, 'veto');
  });

  it('handles brain panel log view navigation', () => {
    const onBrainRiskChange = vi.fn();
    const host = makeHost(
      baseState({
        brainPanel: {
          open: true,
          view: 'log',
          row: 0,
          settings: undefined,
          log: [{ kind: 'tool', question: 'Q?', outcome: 'Y', age: '30s' }],
          selected: 0,
        },
      }),
      { onBrainRiskChange },
    );

    runPickerKey(host, '', key({ escape: true }), false);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'brainClose' });

    runPickerKey(host, '', key({ upArrow: true }), false);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'brainMove', delta: -1 });

    runPickerKey(host, '', key({ leftArrow: true }), false);
    expect(onBrainRiskChange).toHaveBeenCalledWith(-1);

    runPickerKey(host, '', key({ rightArrow: true }), false);
    expect(onBrainRiskChange).toHaveBeenCalledWith(1);
  });

  it('handles brain panel log view tab back to settings', () => {
    const host = makeHost(
      baseState({
        brainPanel: {
          open: true,
          view: 'log',
          row: 0,
          settings: {
            mode: 'interactive',
            riskLevel: 'medium',
            strategy: 'fallback',
            pool: [],
            poolResolved: [],
            usingSessionModel: false,
            councilEnabled: false,
            councilMinRisk: 'medium',
            voters: [],
            councilSeats: [],
            ledgerEnabled: false,
          },
          log: [],
          selected: 0,
          busy: false,
        },
      }),
    );

    runPickerKey(host, '', key({ tab: true }), false);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'brainView', view: 'settings' });
  });
});

describe('usePickerKeys — shadow panel', () => {
  it('handles shadow panel s and t keys', () => {
    const onShadowStart = vi.fn();
    const onShadowStop = vi.fn();
    const host = makeHost(
      baseState({
        shadowPanel: { open: true },
      }),
      { onShadowStart, onShadowStop },
    );

    runPickerKey(host, 's', key(), false);
    expect(onShadowStart).toHaveBeenCalled();

    runPickerKey(host, 'S', key(), false);
    expect(onShadowStart).toHaveBeenCalledTimes(2);

    runPickerKey(host, 't', key(), false);
    expect(onShadowStop).toHaveBeenCalled();

    runPickerKey(host, 'T', key(), false);
    expect(onShadowStop).toHaveBeenCalledTimes(2);

    runPickerKey(host, '', key({ escape: true }), false);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'shadowClose' });
  });
});

describe('usePickerKeys — statusline picker', () => {
  it('navigates statusline picker with arrows and toggles on arrows/Enter', () => {
    const host = makeHost(
      baseState({
        statuslinePicker: { open: true, field: 0, hiddenItems: [], visibleChips: [] },
      }),
    );

    runPickerKey(host, '', key({ upArrow: true }), false);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'statuslineFieldMove', delta: -1 });

    runPickerKey(host, '', key({ downArrow: true }), false);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'statuslineFieldMove', delta: 1 });

    runPickerKey(host, '', key({ leftArrow: true }), false);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'statuslineToggle', item: 'project' });

    host.lastEnterAtRef.current = 0;
    runPickerKey(host, '', key(), true);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'statuslineToggle', item: 'project' });

    runPickerKey(host, '', key({ escape: true }), false);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'statuslineClose' });
  });
});

describe('usePickerKeys — project picker', () => {
  it('navigates project picker with arrows, filter, and backspace', () => {
    const onProjectPickerEnter = vi.fn().mockResolvedValue(undefined);
    const host = makeHost(
      baseState({
        projectPicker: {
          open: true,
          allItems: [{ path: '/project1' }],
          items: [{ path: '/project1' }],
          selected: 0,
          filter: '',
        },
      }),
      { onProjectPickerEnter },
    );
    host.lastEnterAtRef.current = 0;

    runPickerKey(host, '', key({ upArrow: true }), false);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'projectPickerMove', delta: -1 });

    runPickerKey(host, '', key({ downArrow: true }), false);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'projectPickerMove', delta: 1 });

    runPickerKey(host, 'x', key(), false);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'projectPickerFilter', filter: 'x' });

    host.dispatch.mockClear();
    const hostWithFilter = makeHost(
      baseState({
        projectPicker: {
          open: true,
          allItems: [{ path: '/p1' }],
          items: [{ path: '/p1' }],
          selected: 0,
          filter: 'xy',
        },
      }),
    );
    runPickerKey(hostWithFilter, '', key({ backspace: true }), false);
    expect(hostWithFilter.dispatch).toHaveBeenCalledWith({
      type: 'projectPickerFilter',
      filter: 'x',
    });

    // Enter
    host.dispatch.mockClear();
    runPickerKey(host, '', key(), true);
    expect(onProjectPickerEnter).toHaveBeenCalled();
  });

  it('handles project picker escape with/without filter', () => {
    const host = makeHost(
      baseState({
        projectPicker: { open: true, allItems: [], items: [], selected: 0, filter: 'search' },
      }),
    );

    runPickerKey(host, '', key({ escape: true }), false);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'projectPickerFilter', filter: '' });

    host.dispatch.mockClear();
    const hostNoFilter = makeHost(
      baseState({
        projectPicker: { open: true, allItems: [], items: [], selected: 0, filter: '' },
      }),
    );
    runPickerKey(hostNoFilter, '', key({ escape: true }), false);
    expect(hostNoFilter.dispatch).toHaveBeenCalledWith({ type: 'projectPickerClose' });
  });
});

describe('usePickerKeys — sessions panel', () => {
  it('navigates sessions panel with arrows, wheel and escape', () => {
    const onSessionsPanelEnter = vi.fn().mockResolvedValue(undefined);
    const host = makeHost(
      baseState({
        sessionsPanelOpen: true,
      }),
      { onSessionsPanelEnter },
    );
    host.lastEnterAtRef.current = 0;

    runPickerKey(host, '', key({ upArrow: true }), false);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'sessionsPanelMove', delta: -1 });

    runPickerKey(host, '', key({ downArrow: true }), false);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'sessionsPanelMove', delta: 1 });

    runPickerKey(
      host,
      '',
      key({
        mouse: {
          kind: 'wheel',
          button: 'none',
          x: 1,
          y: 1,
          wheel: 1,
          shift: false,
          meta: false,
          ctrl: false,
          motion: false,
        },
      }),
      false,
    );
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'sessionsPanelMove', delta: -1 });

    // Enter
    runPickerKey(host, '', key(), true);
    expect(onSessionsPanelEnter).toHaveBeenCalled();
  });

  it('handles sessions panel escape with/without resume confirm', () => {
    const host = makeHost(
      baseState({
        sessionsPanelOpen: true,
        sessionResumeConfirm: { sessionId: 's1' },
      }),
    );

    runPickerKey(host, '', key({ escape: true }), false);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'sessionResumeConfirmClear' });

    host.dispatch.mockClear();
    const hostNoConfirm = makeHost(
      baseState({
        sessionsPanelOpen: true,
      }),
    );
    runPickerKey(hostNoConfirm, '', key({ escape: true }), false);
    expect(hostNoConfirm.dispatch).toHaveBeenCalledWith({ type: 'toggleSessionsPanel' });
  });
});

describe('usePickerKeys — slash picker', () => {
  it('navigates slash picker with arrows, Enter, and Tab', () => {
    const onSlashPickerEnter = vi.fn();
    const onSlashPickerTab = vi.fn();
    const host = makeHost(
      baseState({
        slashPicker: { open: true, query: '/', matches: ['/help'], selected: 0 },
      }),
      { onSlashPickerEnter, onSlashPickerTab },
    );
    host.lastEnterAtRef.current = 0;

    runPickerKey(host, '', key({ upArrow: true }), false);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'slashPickerMove', delta: -1 });

    runPickerKey(host, '', key({ downArrow: true }), false);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'slashPickerMove', delta: 1 });

    runPickerKey(host, '', key({ escape: true }), false);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'slashPickerClose' });

    host.dispatch.mockClear();
    runPickerKey(host, '', key({ tab: true }), false);
    expect(onSlashPickerTab).toHaveBeenCalled();

    host.dispatch.mockClear();
    runPickerKey(host, '', key(), true);
    expect(onSlashPickerEnter).toHaveBeenCalled();
  });

  it('returns false on slash picker with no matches and tab', () => {
    const onSlashPickerTab = vi.fn();
    const host = makeHost(
      baseState({
        slashPicker: { open: true, query: '/x', matches: [], selected: 0 },
      }),
      { onSlashPickerTab },
    );

    runPickerKey(host, '', key({ tab: true }), false);
    expect(onSlashPickerTab).not.toHaveBeenCalled();
  });
});

describe('usePickerKeys — F-key picker', () => {
  it('navigates F-key picker with arrows and Enter', () => {
    const onFKeyPickerEnter = vi.fn();
    const host = makeHost(
      baseState({
        fKeyPicker: { open: true, selected: 0 },
      }),
      { onFKeyPickerEnter },
    );
    host.lastEnterAtRef.current = 0;

    runPickerKey(host, '', key({ upArrow: true }), false);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'fKeyPickerMove', delta: -1 });

    runPickerKey(host, '', key({ downArrow: true }), false);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'fKeyPickerMove', delta: 1 });

    runPickerKey(
      host,
      '',
      key({
        mouse: {
          kind: 'wheel',
          button: 'none',
          x: 1,
          y: 1,
          wheel: -1,
          shift: false,
          meta: false,
          ctrl: false,
          motion: false,
        },
      }),
      false,
    );
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'fKeyPickerMove', delta: 1 });

    runPickerKey(host, '', key({ escape: true }), false);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'fKeyPickerClose' });

    runPickerKey(host, '', key(), true);
    expect(onFKeyPickerEnter).toHaveBeenCalled();
  });
});

describe('usePickerKeys — general picker', () => {
  it('navigates general picker with arrows and mouse', () => {
    const onPickerEnter = vi.fn().mockResolvedValue(undefined);
    const host = makeHost(
      baseState({
        picker: { open: true, query: '', matches: [], selected: 0 },
      }),
      { onPickerEnter },
    );
    host.lastEnterAtRef.current = 0;

    runPickerKey(host, '', key({ upArrow: true }), false);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'pickerMove', delta: -1 });

    runPickerKey(host, '', key({ downArrow: true }), false);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'pickerMove', delta: 1 });

    runPickerKey(
      host,
      '',
      key({
        mouse: {
          kind: 'wheel',
          button: 'none',
          x: 1,
          y: 1,
          wheel: -1,
          shift: false,
          meta: false,
          ctrl: false,
          motion: false,
        },
      }),
      false,
    );
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'pickerMove', delta: 1 });

    runPickerKey(host, '', key({ escape: true }), false);
    expect(host.dispatch).toHaveBeenCalledWith({ type: 'pickerClose' });

    runPickerKey(host, '', key(), true);
    expect(onPickerEnter).toHaveBeenCalled();
  });
});

describe('usePickerKeys — auth panel catalog filter with empty filter backspace', () => {
  it('does not dispatch when backspace on empty auth catalog filter', () => {
    const host = makeHost(
      baseState({
        authPanel: { open: true, view: 'catalog', filter: '' },
      }),
    );

    runPickerKey(host, '', key({ backspace: true }), false);
    // Backspace on empty filter length should still return true but not dispatch
    expect(host.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'authFilter' }));
  });
});

describe('usePickerKeys — auth panel provider view non-u/d input', () => {
  it('handles non-u/d input in provider view (just returns true)', () => {
    const host = makeHost(
      baseState({
        authPanel: { open: true, view: 'provider', providerId: 'openai' },
      }),
    );

    // Any key other than u/d in provider view should just return true
    runPickerKey(host, 'x', key(), false);
    // No dispatch should occur - just returns true
    expect(host.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'authMove' }));
  });
});

describe('usePickerKeys — brain panel busy state guards', () => {
  it('clamps out-of-bounds row to last valid row and adjusts it', () => {
    const onBrainAdjust = vi.fn();
    const onBrainEnter = vi.fn();
    const host = makeHost(
      baseState({
        brainPanel: {
          open: true,
          view: 'settings',
          row: 999,
          settings: {
            mode: 'interactive',
            riskLevel: 'medium',
            strategy: 'fallback',
            pool: [],
            poolResolved: [],
            usingSessionModel: false,
            councilEnabled: false,
            councilMinRisk: 'medium',
            voters: [],
            councilSeats: [],
            ledgerEnabled: false,
          },
          busy: false,
        },
      }),
      { onBrainAdjust, onBrainEnter },
    );

    // Row 999 gets clamped to last row (index 5 = ledgerToggle) which exists
    runPickerKey(host, '', key({ leftArrow: true }), false);
    expect(onBrainAdjust).toHaveBeenCalled();
  });

  it('does not handle left/right/enter when panel is busy', () => {
    const onBrainAdjust = vi.fn();
    const onBrainEnter = vi.fn();
    const host = makeHost(
      baseState({
        brainPanel: {
          open: true,
          view: 'settings',
          row: 0,
          settings: {
            mode: 'interactive',
            riskLevel: 'medium',
            strategy: 'fallback',
            pool: [],
            poolResolved: [],
            usingSessionModel: false,
            councilEnabled: false,
            councilMinRisk: 'medium',
            voters: [],
            councilSeats: [],
            ledgerEnabled: false,
          },
          busy: true,
        },
      }),
      { onBrainAdjust, onBrainEnter },
    );

    runPickerKey(host, '', key({ leftArrow: true }), false);
    expect(onBrainAdjust).not.toHaveBeenCalled();

    runPickerKey(host, '', key(), true);
    expect(onBrainEnter).not.toHaveBeenCalled();
  });
});

describe('usePickerKeys — debounced Enter double tap', () => {
  it('blocks Enter within 50ms of previous Enter', () => {
    const onAuthEnter = vi.fn();
    const host = makeHost(
      baseState({
        authPanel: { open: true, view: 'list' },
      }),
      { onAuthEnter },
    );
    // Pin the clock. The handler runs inside an Ink render, which on a loaded
    // machine takes longer than the 50ms debounce window — reading the real
    // clock made this assertion depend on render latency rather than on the
    // debounce logic, so it failed intermittently.
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      host.lastEnterAtRef.current = Date.now();

      runPickerKey(host, '', key(), true);
      expect(onAuthEnter).not.toHaveBeenCalled(); // Debounced
    } finally {
      nowSpy.mockRestore();
    }
  });
});

describe('usePickerKeys — settings picker filter empty handling', () => {
  it('does not enter filter mode on slash when filter already active', () => {
    const host = makeHost(
      baseState({
        settingsPicker: { open: true, field: 0, mode: 'off', delayMs: 0, filter: 'already' },
      }),
    );

    // dispatch should not be called because filter is already non-empty
    // and the '/' case is only when filter === ''
    runPickerKey(host, '/', key(), false);
    // Shouldn't set filter to '/' + 'already'
    expect(host.dispatch).not.toHaveBeenCalledWith({
      type: 'settingsFilterSet',
      filter: '/already',
    });
  });
});

describe('usePickerKeys — model picker async switch with error', () => {
  it('handles async switchProviderAndModel error', () => {
    const switchProviderAndModel = vi.fn().mockResolvedValue('Error message');
    const host = makeHost(
      baseState({
        modelPicker: {
          open: true,
          step: 'model',
          providerOptions: [],
          modelOptions: ['gpt-4o'],
          filteredOptions: ['gpt-4o'],
          selected: 0,
          searchQuery: '',
          pickedProviderId: 'openai',
          purpose: 'switch',
        },
      }),
      { switchProviderAndModel },
    );
    host.dispatch.mockClear();
    host.lastEnterAtRef.current = 0;

    runPickerKey(host, '', key(), true);

    // The async callback should dispatch modelPickerHint with the error
    // Since it's async, we need to flush promises (but in a simple render test
    // we verify the switchProviderAndModel was called)
    expect(switchProviderAndModel).toHaveBeenCalledWith('openai', 'gpt-4o');
  });
});

describe('usePickerKeys — settings picker ctrl+meta jump with shift', () => {
  it('handles alt+shift modifier for field jump', () => {
    const host = makeHost(
      baseState({
        settingsPicker: { open: true, field: 0, mode: 'off', delayMs: 0 },
      }),
    );

    // Alt+Shift+letter (meta with shift)
    runPickerKey(host, 'b', key({ ctrl: false, meta: true, shift: true }), false);
    // Should attempt settingsFieldSet dispatch via the jump chords
    // (might or might not find a chord depending on letter, but shouldn't crash)
    expect(host.dispatch).toHaveBeenCalled();
  });
});

describe('usePickerKeys — auth panel model shortcuts (x/r/a + models view)', () => {
  it.each(['x', 'r', 'a'])('forwards %s in provider view to onAuthShortcut', (k) => {
    const onAuthShortcut = vi.fn();
    const host = makeHost(
      baseState({
        authPanel: { open: true, view: 'provider', providerId: 'openai' },
      }),
      { onAuthShortcut },
    );

    runPickerKey(host, k, key(), false);
    expect(onAuthShortcut).toHaveBeenCalledWith(k);
  });

  it.each(['u', 'd', 'x', 'r', 'a'])('forwards %s in models view to onAuthShortcut', (k) => {
    const onAuthShortcut = vi.fn();
    const host = makeHost(
      baseState({
        authPanel: { open: true, view: 'models', providerId: 'openai' },
      }),
      { onAuthShortcut },
    );

    runPickerKey(host, k, key(), false);
    expect(onAuthShortcut).toHaveBeenCalledWith(k);
  });

  it('does not forward non-shortcut letters in models view', () => {
    const onAuthShortcut = vi.fn();
    const host = makeHost(
      baseState({
        authPanel: { open: true, view: 'models', providerId: 'openai' },
      }),
      { onAuthShortcut },
    );

    runPickerKey(host, 'q', key(), false);
    expect(onAuthShortcut).not.toHaveBeenCalled();
    // And it swallows the key rather than leaking to other handlers
    expect(host.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'authMove' }));
  });
});

// ── /resume in-flight guard (double-Enter regression) ─────────────────────
// The guard lives inside the REAL onResumePickerEnter built by useAppPickerKeys.
// Every describe above mocks that prop (they test key ROUTING), which makes
// them blind to the lock. These tests mount the real hook ONCE — the lock is a
// useRef, so a remount between Enters (runPickerKey's per-key pattern) would
// reset it and silently re-arm the bug — and drive a double-Enter through a
// single handler instance with real timers (the 50ms paint yield and the
// 50ms Enter debounce are both real-time windows).
describe('useAppPickerKeys — resume in-flight guards (/resume picker + F10 sessions panel)', () => {
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  function resumePickerState(): State {
    return baseState({
      resumePicker: {
        open: true,
        sessions: [
          {
            id: 'sess_current',
            title: 'current session',
            lastActivityAt: '2026-08-29T10:00:00.000Z',
            startedAt: '2026-08-29T09:00:00.000Z',
            tokenTotal: 1000,
            isCurrent: true,
          },
          {
            id: 'sess_target',
            title: 'target session',
            lastActivityAt: '2026-08-29T08:00:00.000Z',
            startedAt: '2026-08-29T07:00:00.000Z',
            tokenTotal: 2000,
            isCurrent: false,
          },
        ],
        selected: 1,
        busy: false,
        hint: undefined,
        error: undefined,
      },
    });
  }

  // Minimal UseAppPickerKeysOptions (the interface is module-private, hence the
  // parameter-type cast). The tested paths only touch host.agent.ctx.projectRoot,
  // host.onResumeSession, state.<picker slices>, dispatch, lastEnterAtRef and
  // inputGateRef — everything else is destructured but never invoked here.
  function mountRealPickerKeys(
    state: State,
    onResumeSession: (sessionId: string) => Promise<unknown>,
    setSuggestionsSpy: ReturnType<typeof vi.fn> = vi.fn(),
  ): {
    dispatch: ReturnType<typeof vi.fn>;
    fire: () => void;
    unmount: () => void;
    setSuggestionsSpy: ReturnType<typeof vi.fn>;
  } {
    const dispatch = vi.fn();
    // Deliberately optional: the mount may settle AFTER render() returns
    // (React 19 concurrent root defers the initial commit off the sync call).
    let handler: ((input: string, event: KeyEvent, isEnter: boolean) => boolean) | undefined;
    const options = {
      host: {
        agent: { ctx: { projectRoot: '/proj' } },
        onResumeSession,
        setSuggestions: setSuggestionsSpy,
      },
      state,
      dispatch,
      environment: {},
      statusbar: {},
      panelControllers: {},
      authPanelController: {},
      brainController: {},
      lastEnterAtRef: { current: 0 },
      inputGateRef: { current: false },
      submitRef: { current: () => {} },
      promptUsageRef: { current: null },
      setDraft: vi.fn(),
      acceptSlashPickerSelection: vi.fn(),
      changeBrainRisk: vi.fn(),
      handleModelPicked: vi.fn(),
      handleShadowStart: vi.fn(),
      handleShadowStop: vi.fn(),
      statuslineHiddenForPicker: vi.fn(() => []),
      onPickerEnter: vi.fn(),
      setPromptFavorite: vi.fn(),
    } as unknown as Parameters<typeof useAppPickerKeys>[0];

    function Probe(): null {
      handler = useAppPickerKeys(options);
      return null;
    }
    // ink-testing-library defers the commit: render() alone leaves the tree
    // pending, and unmount() would flush it only to immediately tear the
    // component down — which the unmount-cancelled guard treats as "drop
    // every dispatch". A rerender flushes the commit while the component
    // STAYS MOUNTED, so the in-flight tests fire against a live instance and
    // unmount() at the end runs the real cleanup.
    const instance = render(React.createElement(Probe));
    instance.rerender(React.createElement(Probe));
    if (typeof handler !== 'function') throw new Error('Probe never mounted');
    const settled = handler;
    let unmounted = false;
    return {
      dispatch,
      setSuggestionsSpy,
      fire: () => settled('', key({ return: true }), true),
      // Idempotent: the guard tests unmount mid-flight and again at the end.
      unmount: () => {
        if (unmounted) return;
        unmounted = true;
        instance.unmount();
      },
    };
  }

  it('double-Enter fires onResumeSession exactly once while the first resume is in flight', async () => {
    let resolveResume!: (value: unknown) => void;
    const onResumeSession = vi.fn(
      (
        _sessionId: string,
        onProgress?: (progress: { loadedBytes: number; totalBytes: number }) => void,
      ) => {
        // Drive the parse-progress sink the hook forwards: the hint must
        // stream byte progress instead of staying on the static loading text.
        onProgress?.({ loadedBytes: 5_242_880, totalBytes: 10_485_760 });
        return new Promise((resolve) => {
          resolveResume = resolve;
        });
      },
    );
    const { dispatch, fire, unmount } = mountRealPickerKeys(
      resumePickerState(),
      onResumeSession as unknown as (sessionId: string) => Promise<unknown>,
    );

    await fire(); // Enter #1 — claims the in-flight lock
    await sleep(70); // 50ms paint yield fires; the 50ms Enter debounce window also passes
    expect(onResumeSession).toHaveBeenCalledTimes(1);
    // Three sinks now: the id, byte progress, and the live stage names that
    // drive the loading block's rolling rows.
    expect(onResumeSession).toHaveBeenCalledWith(
      'sess_target',
      expect.any(Function),
      expect.any(Function),
    );
    // Enter is a commit: the picker closes at once and the screen is wiped to
    // the loading block, instead of the panel sitting frozen over a transcript
    // that belongs to a different session.
    expect(dispatch).toHaveBeenCalledWith({ type: 'resumePickerClose' });
    expect(dispatch).toHaveBeenCalledWith({
      type: 'resumeLoadStart',
      sessionId: 'sess_target',
      label: 'target session',
    });

    // The forwarded sink drives the block's progress bar. It deliberately does
    // NOT open a chat entry per tick — the loader fires ~4x/sec and that would
    // bury the transcript it is about to replay.
    const tickCalls = dispatch.mock.calls.filter(
      (call) => (call[0] as { type?: string }).type === 'resumeLoadTick',
    );
    expect(tickCalls).toContainEqual([
      { type: 'resumeLoadTick', loadedBytes: 5_242_880, totalBytes: 10_485_760 },
    ]);

    // Enter #2 arrives after the debounce window but before any re-render: the
    // branch's `state.resumePicker.busy` snapshot is still false (this test has
    // no reducer), so ONLY the in-flight ref can reject it.
    await fire();
    await sleep(20);
    expect(onResumeSession).toHaveBeenCalledTimes(1);

    resolveResume({ entries: [], nextId: 1, sessionId: 'sess_target' });
    await sleep(0);
    unmount();
  });

  it('streams the replayed transcript in batches and ends waiting, not running', async () => {
    // The user's ask: clear the screen, show the load, then let the whole chat
    // history scroll in piece by piece the way it looked live — and stop there.
    const entries = Array.from({ length: 120 }, (_, index) => ({
      id: index + 1,
      kind: 'info' as const,
      text: `entry-${index + 1}`,
    }));
    const onResumeSession = vi.fn(async () => ({
      entries,
      nextId: entries.length + 1,
      sessionId: 'sess_target',
      attached: true,
      warnings: [],
      contextSnapshot: { tokens: 4321, maxContext: 200_000 },
    }));
    const { dispatch, fire, unmount } = mountRealPickerKeys(
      resumePickerState(),
      onResumeSession as unknown as (sessionId: string) => Promise<unknown>,
    );

    await fire();
    // Long enough for the 50ms paint yield plus the whole batched stream.
    await sleep(900);

    const chunks = dispatch.mock.calls
      .map((call) => call[0] as { type?: string; entries?: unknown[]; done?: boolean })
      .filter((action) => action.type === 'resumeStreamChunk');

    // More than one batch: a single dispatch would paint the transcript as an
    // instantaneous wall of text instead of scrolling it into place.
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.reduce((sum, chunk) => sum + (chunk.entries?.length ?? 0), 0)).toBe(120);
    // Exactly one terminating chunk, and it carries the context snapshot.
    expect(chunks.filter((chunk) => chunk.done)).toHaveLength(1);
    expect(chunks.at(-1)?.done).toBe(true);

    const lines = dispatch.mock.calls
      .map((call) => call[0] as { type?: string; entry?: { kind?: string; text?: string } })
      .filter((action) => action.type === 'addEntry');
    // The closing line says the session is attached AND that nothing will
    // happen until the user acts.
    expect(lines.at(-1)?.entry?.text).toContain('Resumed session sess_target');
    expect(lines.at(-1)?.entry?.text).toContain('auto-proceed stays paused');
    unmount();
  });

  it('offers the resumed session next steps instead of running them', async () => {
    // The reported behaviour: a session that ended on a <nextsteps> block came
    // back and just carried on. It must come back with the steps LISTED and
    // nothing running until the user picks one.
    const onResumeSession = vi.fn(async () => ({
      entries: [{ id: 1, kind: 'info' as const, text: 'transcript' }],
      nextId: 2,
      sessionId: 'sess_target',
      attached: true,
      warnings: [],
      nextSteps: ['Run the release check', 'Update the changelog'],
    }));
    const { dispatch, setSuggestionsSpy, fire, unmount } = mountRealPickerKeys(
      resumePickerState(),
      onResumeSession as unknown as (sessionId: string) => Promise<unknown>,
    );

    await fire();
    await sleep(400);

    const texts = dispatch.mock.calls
      .map((call) => call[0] as { type?: string; entry?: { text?: string } })
      .filter((action) => action.type === 'addEntry')
      .map((action) => action.entry?.text ?? '');
    const listing = texts.find((text) => text.includes('Next steps this session proposed'));
    expect(listing).toBeDefined();
    expect(listing).toContain('1. Run the release check');
    expect(listing).toContain('2. Update the changelog');
    expect(listing).toContain('/next');

    // They are offered through the same store /next reads — written LAST, so
    // the per-entry parsers that fire while the transcript mounts cannot leave
    // a mid-transcript block armed instead of the final turn's.
    expect(setSuggestionsSpy).toHaveBeenCalledWith([
      'Run the release check',
      'Update the changelog',
    ]);

    // And nothing was submitted.
    const submitted = dispatch.mock.calls
      .map((call) => call[0] as { type?: string; entry?: { kind?: string } })
      .filter((action) => action.type === 'addEntry' && action.entry?.kind === 'user');
    expect(submitted).toHaveLength(0);
    unmount();
  });

  it('clears stale suggestions when the resumed session proposed none', async () => {
    // Otherwise the session being LEFT keeps its next steps armed, and they
    // fire the moment the post-resume hold is released.
    const onResumeSession = vi.fn(async () => ({
      entries: [],
      nextId: 1,
      sessionId: 'sess_target',
      attached: true,
      warnings: [],
      nextSteps: [],
    }));
    const { dispatch, setSuggestionsSpy, fire, unmount } = mountRealPickerKeys(
      resumePickerState(),
      onResumeSession as unknown as (sessionId: string) => Promise<unknown>,
    );

    await fire();
    await sleep(400);

    expect(setSuggestionsSpy).toHaveBeenCalledWith([]);
    const texts = dispatch.mock.calls
      .map((call) => call[0] as { type?: string; entry?: { text?: string } })
      .filter((action) => action.type === 'addEntry')
      .map((action) => action.entry?.text ?? '');
    expect(texts.some((text) => text.includes('Next steps this session proposed'))).toBe(false);
    unmount();
  });

  it('releases the in-flight lock once the resume settles, so a later Enter resumes again', async () => {
    const onResumeSession = vi.fn(
      () =>
        new Promise((resolve) => {
          queueMicrotask(() => resolve({ entries: [], nextId: 1, sessionId: 'sess_target' }));
        }),
    );
    const { fire, unmount } = mountRealPickerKeys(
      resumePickerState(),
      onResumeSession as unknown as (sessionId: string) => Promise<unknown>,
    );

    await fire(); // Enter #1
    await sleep(70);
    expect(onResumeSession).toHaveBeenCalledTimes(1);
    await sleep(10); // flush the .then/.finally chain that releases the lock

    await fire(); // Enter #2 — lock released, a fresh resume must go through
    await sleep(70);
    expect(onResumeSession).toHaveBeenCalledTimes(2);
    unmount();
  });

  // ── F10 sessions-panel resume (same lock, two-step confirm flow) ─────────
  // The confirm branch of onSessionsPanelEnter reads the render-time
  // `sessionResumeConfirm` snapshot; a third Enter before React re-renders
  // still sees it and would re-run onResumeSession. That branch has NO
  // busy-state guard at all, so the sync in-flight ref is the only
  // protection against a double resume.
  function sessionsPanelState(
    sessionResumeConfirm: { sessionId: string; sessionName: string } | null,
  ): State {
    return baseState({
      // The F10 Enter branch gates on the standalone boolean flag, not on
      // `sessionsPanel.open`.
      sessionsPanelOpen: true,
      sessionsPanel: {
        open: true,
        sessions: [
          {
            sessionId: 'sess_target',
            pid: null,
            projectRoot: '/proj',
            projectName: 'project',
          },
        ],
        selected: 0,
        busy: false,
      },
      sessionResumeConfirm,
    });
  }

  it('asks for confirmation on the first Enter of a stopped same-project session', () => {
    const onResumeSession = vi.fn();
    const { dispatch, fire, unmount } = mountRealPickerKeys(
      sessionsPanelState(null),
      onResumeSession as unknown as (sessionId: string) => Promise<unknown>,
    );

    fire();
    expect(dispatch).toHaveBeenCalledWith({
      type: 'sessionResumeConfirmSet',
      sessionId: 'sess_target',
      sessionName: 'project',
    });
    expect(onResumeSession).not.toHaveBeenCalled();
    unmount();
  });

  it('double-Enter fires onResumeSession exactly once while the first F10 resume is in flight', async () => {
    let resolveResume!: (value: unknown) => void;
    const onResumeSession = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveResume = resolve;
        }),
    );
    const { dispatch, fire, unmount } = mountRealPickerKeys(
      sessionsPanelState({ sessionId: 'sess_target', sessionName: 'project' }),
      onResumeSession as unknown as (sessionId: string) => Promise<unknown>,
    );

    await fire(); // Enter #1 — executes the confirmed resume, claims the lock
    await sleep(70); // the 50ms Enter debounce window passes
    expect(onResumeSession).toHaveBeenCalledTimes(1);
    expect(onResumeSession).toHaveBeenCalledWith(
      'sess_target',
      expect.any(Function),
      expect.any(Function),
    );
    // The panel closes as part of the synchronous commit prefix now: the
    // loading block belongs on the chat screen, not underneath a panel the
    // user has already mentally dismissed. Same reason the /resume picker
    // closes on Enter.
    expect(dispatch).toHaveBeenCalledWith({ type: 'toggleSessionsPanel' });
    expect(dispatch).toHaveBeenCalledWith({
      type: 'resumeLoadStart',
      sessionId: 'sess_target',
      label: 'project',
    });

    // Enter #2: the state snapshot still carries the confirm (this test has
    // no reducer), so ONLY the in-flight ref can reject it.
    await fire();
    await sleep(70);
    expect(onResumeSession).toHaveBeenCalledTimes(1);

    resolveResume({ entries: [], nextId: 1, sessionId: 'sess_target' });
    await sleep(0);
    unmount();
  });

  it('releases the in-flight lock once the F10 resume settles, so a later Enter resumes again', async () => {
    const onResumeSession = vi.fn(
      () =>
        new Promise((resolve) => {
          queueMicrotask(() => resolve({ entries: [], nextId: 1, sessionId: 'sess_target' }));
        }),
    );
    const { fire, unmount } = mountRealPickerKeys(
      sessionsPanelState({ sessionId: 'sess_target', sessionName: 'project' }),
      onResumeSession as unknown as (sessionId: string) => Promise<unknown>,
    );

    await fire(); // Enter #1
    await sleep(70);
    expect(onResumeSession).toHaveBeenCalledTimes(1);
    await sleep(10); // flush the .then/.finally chain that releases the lock

    await fire(); // Enter #2 — lock released, a fresh resume must go through
    await sleep(70);
    expect(onResumeSession).toHaveBeenCalledTimes(2);
    unmount();
  });

  it('drops /resume chain dispatches after unmount and refuses new work afterwards', async () => {
    let resolveResume!: (value: unknown) => void;
    const onResumeSession = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveResume = resolve;
        }),
    );
    const { dispatch, fire, unmount } = mountRealPickerKeys(
      resumePickerState(),
      onResumeSession as unknown as (sessionId: string) => Promise<unknown>,
    );

    await fire(); // Enter #1 — resume in flight
    await sleep(70);
    expect(onResumeSession).toHaveBeenCalledTimes(1);

    unmount(); // the TUI tears down mid-resume
    resolveResume({ entries: [], nextId: 1, sessionId: 'sess_target' });
    await sleep(0); // the chain settles after unmount

    // The sync-prefix dispatches (close + the "Resuming…" entry) happened
    // before the teardown; everything the unmounted chain would still emit
    // must be dropped.
    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'replaceHistory' }));
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'addEntry',
        entry: expect.objectContaining({ text: expect.stringContaining('Resumed session') }),
      }),
    );

    // The .finally released the lock unconditionally, but the post-yield
    // unmount guard must refuse to START a fresh resume for a dead
    // component — that refusal is the point of the guard. Lock release on a
    // live component is proven by the sibling "releases the in-flight lock"
    // test above.
    await fire();
    await sleep(70);
    expect(onResumeSession).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('drops F10 chain dispatches after unmount but still releases the lock', async () => {
    let resolveResume!: (value: unknown) => void;
    const onResumeSession = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveResume = resolve;
        }),
    );
    const { dispatch, fire, unmount } = mountRealPickerKeys(
      sessionsPanelState({ sessionId: 'sess_target', sessionName: 'project' }),
      onResumeSession as unknown as (sessionId: string) => Promise<unknown>,
    );

    await fire(); // Enter — confirmed resume in flight
    await sleep(70);
    expect(onResumeSession).toHaveBeenCalledTimes(1);

    unmount(); // teardown mid-resume
    resolveResume({ entries: [], nextId: 1, sessionId: 'sess_target' });
    await sleep(0);

    // Nothing the unmounted chain would still emit reaches the dead reducer:
    // no streamed transcript, no completion line.
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'resumeStreamChunk' }),
    );
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'addEntry',
        entry: expect.objectContaining({ text: expect.stringContaining('Resumed session') }),
      }),
    );

    // Both surfaces share one resume flow now, so F10 gets the picker's
    // post-yield unmount guard too: a dead component refuses to START fresh
    // work. Previously the F10 branch called the host synchronously and so
    // reached it even after teardown.
    await fire();
    await sleep(70);
    expect(onResumeSession).toHaveBeenCalledTimes(1);
    unmount();
  });
});
