import { render } from 'ink-testing-library';
import type React from 'react';
import { act, useEffect, useReducer } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { createInitialState } from '../src/app-initial-state.js';
import { reducer, type State } from '../src/app-reducer.js';
import { AppViewPickers } from '../src/app-view-pickers.js';
import type { KeyEvent } from '../src/components/input.js';
import { ModelPicker } from '../src/components/model-picker.js';
import { SubagentModelsPanel } from '../src/components/subagent-models-panel.js';
import { tryAuthModelPickerKeys } from '../src/hooks/use-picker-keys-auth-model.js';
import { tryToolsSettingsPickerKeys } from '../src/hooks/use-picker-keys-tools-settings.js';
import type { PickerKeysHost } from '../src/hooks/use-picker-keys.js';
import { useModelPickRequest } from '../src/hooks/use-model-pick.js';
import { useSubagentModelsPanel } from '../src/hooks/use-subagent-models-panel.js';
import type { SubagentModelsPanelHost } from '../src/subagent-models-panel-model.js';

function baseState() {
  return createInitialState({
    banner: false,
    appVersion: '0.0.0',
    provider: 'anthropic',
    model: 'anthropic-test-model',
    cwd: '/repo',
    family: 'anthropic',
    keyTail: 'abcd',
    restoredEntries: [],
    enhanceEnabled: false,
    initialAgentsMonitorOpen: false,
  });
}

const lanes = [
  { target: 'anthropic/claude-opus-5', busy: 1 },
  { target: '', busy: 0 },
  { target: 'openai/gpt-5', busy: 0, label: 'cheap lane' },
];

describe('SubagentModelsPanel', () => {
  it('renders lanes, the busy marker and the lock state', () => {
    const { lastFrame } = render(
      <SubagentModelsPanel
        lanes={lanes}
        roles={[]}
        selected={0}
        enabled
        lock
        followSessionModel={false}
        sessionTarget="openai/gpt-5"
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('anthropic/claude-opus-5');
    expect(frame).toContain('cheap lane');
    expect(frame).toContain('inherit');
    expect(frame).toContain('lanes override the leader');
  });

  it('documents the use-session-model shortcut', () => {
    const { lastFrame } = render(
      <SubagentModelsPanel
        lanes={lanes}
        roles={[]}
        selected={0}
        enabled
        lock
        followSessionModel={false}
        sessionTarget="openai/gpt-5"
      />,
    );
    expect(lastFrame() ?? '').toContain('s session model');
  });

  it('says the leader wins when the lock is off', () => {
    const { lastFrame } = render(
      <SubagentModelsPanel
        lanes={lanes}
        roles={[]}
        selected={0}
        enabled
        lock={false}
        followSessionModel={false}
        sessionTarget="openai/gpt-5"
      />,
    );
    expect(lastFrame() ?? '').toContain('leader pins win');
  });

  it('renders role overrides when present', () => {
    const { lastFrame } = render(
      <SubagentModelsPanel
        lanes={lanes}
        roles={[{ role: 'reviewer', target: 'openai/gpt-5' }]}
        selected={1}
        enabled
        lock
        followSessionModel={false}
        sessionTarget="openai/gpt-5"
      />,
    );
    expect(lastFrame() ?? '').toContain('reviewer');
  });
});

describe('SubagentModelsPanel — use session model', () => {
  it('names the session target and marks the lanes inactive', () => {
    const { lastFrame } = render(
      <SubagentModelsPanel
        lanes={lanes}
        roles={[]}
        selected={0}
        enabled
        lock
        followSessionModel
        sessionTarget="openai/gpt-5"
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('openai/gpt-5');
    expect(frame).toContain('lanes are inactive');
  });
});

describe('subagent-models overlay layering', () => {
  it('hides the lane plan while the shared model picker is active', () => {
    const state = baseState();
    state.modelPicker = {
      ...state.modelPicker,
      open: true,
      providerOptions: [{ id: 'openai', family: 'openai', models: ['gpt-5'] }],
      filteredOptions: ['openai'],
    };
    state.subagentModels = {
      ...state.subagentModels,
      open: true,
      lanes,
      sessionTarget: 'openai/gpt-5',
    };

    const { lastFrame } = render(
      <AppViewPickers
        host={{} as never}
        runtime={
          {
            state,
            dispatch: vi.fn(),
            activity: { nowTick: 0, enhanceDots: '' },
            environment: { setYoloLive: vi.fn() },
            viewState: { inputHeight: 1 },
          } as never
        }
        mainColumnWidth={80}
        pickerMaxRows={12}
        routedToSidebar={() => false}
        panelPositions={{} as never}
      />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Switch model');
    expect(frame).not.toContain('Subagent models (this session)');
  });
});

describe('subagent-models picker integration', () => {
  it('routes Enter through the shared picker, updates the lane, and restores the panel', async () => {
    let laneTarget = '';
    const panelHost: SubagentModelsPanelHost = {
      snapshot: () => ({
        enabled: true,
        lock: true,
        followSessionModel: false,
        sessionTarget: 'anthropic/claude-opus-5',
        lanes: [{ target: laneTarget, busy: 0 }],
        roles: [],
      }),
      setLane: vi.fn(async (_index, target) => {
        laneTarget = `${target.provider}/${target.model}`;
        return null;
      }),
      clearLane: vi.fn(async () => null),
      toggle: vi.fn(async () => null),
    };
    const initial = baseState();
    initial.subagentModels = {
      ...initial.subagentModels,
      open: true,
      lanes: panelHost.snapshot().lanes,
      sessionTarget: 'anthropic/claude-opus-5',
    };

    let flow:
      | {
          state: State;
          dispatch: React.Dispatch<Parameters<typeof reducer>[1]>;
          modelPick: ReturnType<typeof useModelPickRequest>;
          controller: ReturnType<typeof useSubagentModelsPanel>;
        }
      | undefined;

    function Harness(): React.ReactElement {
      const [state, dispatch] = useReducer(reducer, initial);
      const modelPick = useModelPickRequest({
        dispatch,
        getPickableProviders: async () => [{ id: 'openai', family: 'openai', models: ['gpt-5'] }],
        pickerOpen: state.modelPicker.open,
      });
      const controller = useSubagentModelsPanel({
        dispatch,
        subagentModelsHost: panelHost,
        requestModelPick: modelPick.requestModelPick,
      });

      useEffect(() => {
        flow = { state, dispatch, modelPick, controller };
      }, [state, dispatch, modelPick, controller]);

      return (
        <>
          {state.modelPicker.open ? (
            <ModelPicker
              step={state.modelPicker.step}
              providerOptions={state.modelPicker.providerOptions}
              modelOptions={state.modelPicker.modelOptions}
              filteredOptions={state.modelPicker.filteredOptions}
              selected={state.modelPicker.selected}
              pickedProviderId={state.modelPicker.pickedProviderId}
              titleLabel={state.modelPicker.title}
            />
          ) : null}
          {state.subagentModels.open && !state.modelPicker.open ? (
            <SubagentModelsPanel
              lanes={state.subagentModels.lanes}
              roles={state.subagentModels.roles}
              selected={state.subagentModels.selected}
              enabled={state.subagentModels.enabled}
              lock={state.subagentModels.lock}
              followSessionModel={state.subagentModels.followSessionModel}
              sessionTarget={state.subagentModels.sessionTarget}
              hint={state.subagentModels.hint}
            />
          ) : null}
        </>
      );
    }

    const view = render(<Harness />);
    const enter: KeyEvent = {
      upArrow: false,
      downArrow: false,
      leftArrow: false,
      rightArrow: false,
      return: true,
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
    };
    const keyHost = {
      get state(): State {
        if (!flow) throw new Error('Harness has not mounted');
        return flow.state;
      },
      dispatch: (action: Parameters<typeof reducer>[1]) => flow?.dispatch(action),
      inputGateRef: { current: false },
      onSubagentLaneEdit: (index: number) => flow?.controller.onSubagentLaneEdit(index),
      onModelPicked: (provider: string, model: string) =>
        flow?.modelPick.handleModelPicked(provider, model),
    } as PickerKeysHost;
    const noDebounce = () => false;

    await act(async () => {
      expect(tryToolsSettingsPickerKeys(keyHost, '', enter, true, noDebounce)).toBe(true);
      await Promise.resolve();
    });
    expect(flow?.state.modelPicker.open).toBe(true);
    expect(view.lastFrame() ?? '').toContain('Lane 1 model');

    await act(async () => {
      expect(tryAuthModelPickerKeys(keyHost, '', enter, true, noDebounce)).toBe(true);
    });
    expect(flow?.state.modelPicker.step).toBe('model');

    await act(async () => {
      expect(tryAuthModelPickerKeys(keyHost, '', enter, true, noDebounce)).toBe(true);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(panelHost.setLane).toHaveBeenCalledWith(0, { provider: 'openai', model: 'gpt-5' });
    expect(flow?.state.modelPicker.open).toBe(false);
    expect(flow?.state.subagentModels.lanes[0]?.target).toBe('openai/gpt-5');
    expect(view.lastFrame() ?? '').toContain('openai/gpt-5');
    view.unmount();
  });
});

describe('subagentModels reducer', () => {
  const open = () =>
    reducer(baseState(), {
      type: 'subagentModelsOpen',
      lanes,
      roles: [],
      enabled: true,
      lock: true,
      followSessionModel: false,
      sessionTarget: 'openai/gpt-5',
    });

  it('opens with the first lane focused', () => {
    const state = open();
    expect(state.subagentModels.open).toBe(true);
    expect(state.subagentModels.selected).toBe(0);
    expect(state.subagentModels.lanes).toHaveLength(3);
  });

  it('wraps the cursor at both ends', () => {
    let state = open();
    state = reducer(state, { type: 'subagentModelsMove', delta: -1 });
    expect(state.subagentModels.selected).toBe(2);
    state = reducer(state, { type: 'subagentModelsMove', delta: 1 });
    expect(state.subagentModels.selected).toBe(0);
  });

  it('keeps the cursor in range when the lane list shrinks', () => {
    let state = open();
    state = reducer(state, { type: 'subagentModelsMove', delta: 2 });
    expect(state.subagentModels.selected).toBe(2);
    state = reducer(state, {
      type: 'subagentModelsUpdate',
      lanes: [lanes[0] as (typeof lanes)[number]],
      roles: [],
      enabled: true,
      lock: false,
      followSessionModel: false,
      sessionTarget: 'openai/gpt-5',
    });
    expect(state.subagentModels.selected).toBe(0);
    expect(state.subagentModels.lock).toBe(false);
  });

  it('closes without losing the rows', () => {
    const state = reducer(open(), { type: 'subagentModelsClose' });
    expect(state.subagentModels.open).toBe(false);
    expect(state.subagentModels.lanes).toHaveLength(3);
  });

  it('does not move when there are no lanes', () => {
    const empty = reducer(baseState(), {
      type: 'subagentModelsOpen',
      lanes: [],
      roles: [],
      enabled: true,
      lock: true,
      followSessionModel: false,
      sessionTarget: 'openai/gpt-5',
    });
    expect(reducer(empty, { type: 'subagentModelsMove', delta: 1 }).subagentModels.selected).toBe(
      0,
    );
  });
});

describe('panel open bridge', () => {
  it('routes subagentModelsOpen to the opener', async () => {
    const { createPanelOpenDispatcher } = await import('../src/on-panel-open.js');
    const openSubagentModelsPanel = vi.fn();
    const dispatcher = createPanelOpenDispatcher({
      dispatch: vi.fn(),
      openProjectPicker: vi.fn(),
      openStatuslinePicker: vi.fn(),
      openSubagentModelsPanel,
    } as never);
    expect(dispatcher('subagentModelsOpen')).toBe(true);
    expect(openSubagentModelsPanel).toHaveBeenCalled();
  });

  it('falls back to text when no opener is wired', async () => {
    const { createPanelOpenDispatcher } = await import('../src/on-panel-open.js');
    const dispatcher = createPanelOpenDispatcher({
      dispatch: vi.fn(),
      openProjectPicker: vi.fn(),
      openStatuslinePicker: vi.fn(),
    } as never);
    expect(dispatcher('subagentModelsOpen')).toBe(false);
  });
});
