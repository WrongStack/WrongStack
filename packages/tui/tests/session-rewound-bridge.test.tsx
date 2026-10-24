import { EventBus } from '@wrongstack/contracts/kernel';
import { useReducer, useRef } from 'react';
import { expect, it, vi } from 'vitest';
import { reducer } from '../src/app-reducer.js';
import type { State } from '../src/app-state.js';
import { useTuiEventBridge } from '../src/hooks/use-tui-event-bridge.js';
import { Text } from '../src/ink.js';
import { createTestState } from './helpers/create-test-state.js';
import { renderRealTty, settle } from './helpers/real-tty.js';

const cp = (promptIndex: number) => ({
  promptIndex,
  promptPreview: `prompt ${promptIndex}`,
  ts: 't',
  fileCount: 0,
});

it('a rewind keeps the checkpoints it did not take back and leaves /clear alone', async () => {
  const events = new EventBus();
  const initial = createTestState();
  initial.checkpoints = [cp(0), cp(1), cp(2)];
  const onClear = vi.fn();
  const seen: { current: State | undefined } = { current: undefined };
  function Harness() {
    const [state, dispatch] = useReducer(reducer, initial);
    const ref = useRef(state);
    ref.current = state;
    seen.current = state;
    useTuiEventBridge({
      events,
      dispatch,
      stateRef: ref,
      setActiveMaxContext: () => {},
      getSessionId: () => 'sess',
      onClearHistory: onClear,
    });
    return <Text>{state.checkpoints.length}</Text>;
  }
  const view = renderRealTty(<Harness />, { columns: 60, rows: 10 });
  try {
    await settle();
    const emit = events.emit as unknown as (name: string, payload: unknown) => void;
    emit.call(events, 'session.rewound', { sessionId: 'sess', toPromptIndex: 1 });
    await settle();
    // The /rewind timeline and message-jump still need the earlier prompts.
    expect(seen.current?.checkpoints.map((c) => c.promptIndex)).toEqual([0, 1]);
    // The host's /clear hook would also drop the pending attachments.
    expect(onClear).not.toHaveBeenCalled();
  } finally {
    view.unmount();
  }
});
