import { expect, it } from 'vitest';
import { Run, type RunEvent } from '../src/run.js';

function delta(text: string): RunEvent {
  return {
    type: 'provider.text_delta',
    payload: { sessionId: 's1', messageId: 'm1', text },
  };
}

it.each([false, true])('delivers each frame once (resubscribe: %s)', (resubscribe) => {
  const run = new Run('r1', 's1', { abort() {}, confirm() {} });
  const received: RunEvent[] = [];
  const other: RunEvent[] = [];
  const listener = (frame: RunEvent) => {
    received.push(frame);
    if (resubscribe && received.length === 1) {
      unsubscribe();
      unsubscribe = run.onEvent(listener);
    }
  };
  let unsubscribe = run.onEvent(listener);
  const stopOther = run.onEvent((frame) => other.push(frame));
  const first = delta('first');
  const second = delta('second');

  run.push(first);
  run.push(second);
  unsubscribe();
  run.push(delta('third'));
  stopOther();

  expect(other).toEqual([first, second, delta('third')]);
  expect(received).toEqual([first, second]);
});

it('does not deliver to a listener removed before its turn', () => {
  const run = new Run('r1', 's1', { abort() {}, confirm() {} });
  const received: RunEvent[] = [];
  run.onEvent(() => unsubscribe());
  const unsubscribe = run.onEvent((frame) => received.push(frame));
  run.push(delta('one'));
  expect(received).toEqual([]);
});
