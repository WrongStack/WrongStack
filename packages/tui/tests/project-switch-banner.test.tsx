import { EventBus } from '@wrongstack/contracts/kernel';
import { useReducer, useRef } from 'react';
import { expect, it, vi } from 'vitest';
import { reducer } from '../src/app-reducer.js';
import { Banner } from '../src/components/history/banner.js';
import type { KeyEvent } from '../src/components/input.js';
import { useAppPickerKeys } from '../src/hooks/use-app-picker-keys.js';
import { useTuiEventBridge } from '../src/hooks/use-tui-event-bridge.js';
import { Text } from '../src/ink.js';
import { createTestState } from './helpers/create-test-state.js';
import { renderRealTty, settle } from './helpers/real-tty.js';

it('replaces the old project history and repaints the banner after a committed switch', async () => {
  const events = new EventBus();
  const initial = createTestState();
  initial.entries = [
    {
      id: 0,
      kind: 'banner',
      version: 'test',
      provider: 'test',
      model: 'model',
      cwd: 'D:/old-project',
      sessionId: 'old-session',
    },
    { id: 1, kind: 'info', text: 'old project output' },
  ];
  const onClear = vi.fn();
  const generation = { current: 1 };
  function Harness() {
    const [state, dispatch] = useReducer(reducer, initial);
    const ref = useRef(state);
    ref.current = state;
    useTuiEventBridge({
      events,
      dispatch,
      stateRef: ref,
      setActiveMaxContext: () => {},
      getSessionId: () => 'new-session',
      onClearHistory: onClear,
      sessionGenerationRef: generation,
    });
    return (
      <>
        {state.entries.map((entry) =>
          entry.kind === 'banner' ? (
            <Banner key={state.historyGen} entry={entry} termWidth={100} />
          ) : (
            <Text key={entry.id}>old project output</Text>
          ),
        )}
      </>
    );
  }
  const view = renderRealTty(<Harness />, { columns: 100, rows: 40 });
  try {
    await settle();
    expect(view.lastFrame()).toContain('old-project');
    const emit = events.emit as unknown as (name: string, payload: unknown) => void;
    emit.call(events, 'project.switched', {
      from: 'D:/old-project',
      to: 'D:/new-project',
      name: 'New',
      sessionId: 'other-session',
    });
    await settle();
    expect(view.lastFrame()).toContain('old-project');
    emit.call(events, 'project.switched', {
      from: 'D:/old-project',
      to: 'D:/new-project',
      name: 'New',
      sessionId: 'new-session',
    });
    await settle();
    expect(view.lastFrame()).toContain('new-project');
    expect(view.lastFrame()).not.toContain('old-project');
    expect(view.lastFrame()).not.toContain('old project output');
    expect(view.lastFrame()).toContain('new-session');
    expect(view.lastFrame()).not.toContain('old-session');
    expect(generation.current).toBe(2);
    expect(onClear).toHaveBeenCalledOnce();
  } finally {
    view.unmount();
  }
});

it.each([null, 'Target unavailable'])(
  'serializes in-place F1 switches and reports the result: %s',
  async (error) => {
    const state = createTestState();
    state.projectPicker.open = true;
    state.projectPicker.items = [{ key: 'target', label: 'Target project', kind: 'project' }];
    let finish!: (error: string | null) => void;
    const onProjectSelect = vi.fn(
      () =>
        new Promise<string | null>((resolve) => {
          finish = resolve;
        }),
    );
    const dispatch = vi.fn();
    const requestExit = vi.fn();
    let handler: ReturnType<typeof useAppPickerKeys> | undefined;
    const options = {
      host: { agent: { ctx: { projectRoot: 'D:/old-project' } }, onProjectSelect, requestExit },
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
    } as unknown as Parameters<typeof useAppPickerKeys>[0];
    function Harness() {
      handler = useAppPickerKeys(options);
      return null;
    }
    const view = renderRealTty(<Harness />, { columns: 80, rows: 24 });
    try {
      await settle();
      handler?.('', { return: true } as KeyEvent, true);
      await settle(70);
      handler?.('', { return: true } as KeyEvent, true);
      expect(onProjectSelect).toHaveBeenCalledOnce();
      finish(error);
      await settle();
      expect(requestExit).not.toHaveBeenCalled();
      if (error) {
        expect(dispatch).toHaveBeenCalledWith({
          type: 'projectPickerHint',
          text: 'Project switch failed: Target unavailable',
        });
        expect(dispatch).not.toHaveBeenCalledWith({ type: 'projectPickerClose' });
        expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'addEntry' }));
      } else {
        expect(dispatch).toHaveBeenCalledWith({ type: 'projectPickerClose' });
        expect(dispatch).toHaveBeenCalledWith({
          type: 'addEntry',
          entry: { kind: 'info', text: 'Switched project: Target project.' },
        });
      }
    } finally {
      view.unmount();
    }
  },
);
