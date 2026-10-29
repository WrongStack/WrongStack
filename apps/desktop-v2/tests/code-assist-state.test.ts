import { expect, it } from 'vitest';
import { emptyEngineState, reduceEngine } from '../src/engine-state';

it('keeps concurrent code-analysis streams and edit outcomes attached to their own request', () => {
  let state = reduceEngine(emptyEngineState, {
    type: 'code.assist.started',
    payload: { requestId: 'file' },
  });
  state = reduceEngine(state, { type: 'code.assist.started', payload: { requestId: 'symbol' } });
  state = reduceEngine(state, {
    type: 'code.assist.delta',
    payload: { requestId: 'file', text: 'File overview' },
  });
  state = reduceEngine(state, {
    type: 'code.assist.delta',
    payload: { requestId: 'symbol', text: 'Symbol explanation' },
  });
  state = reduceEngine(state, {
    type: 'code.assist.result',
    payload: { requestId: 'file', status: 'done', text: 'Final file overview', appliedEdits: true },
  });
  expect(state.assists['symbol']).toEqual({ text: 'Symbol explanation', status: 'running' });
  expect(state.assists['file']).toMatchObject({
    text: 'Final file overview',
    status: 'done',
    appliedEdits: true,
  });
  state = reduceEngine(state, {
    type: 'code.assist.result',
    payload: { requestId: 'symbol', status: 'aborted' },
  });
  expect(state.assists['symbol']?.status).toBe('aborted');
});

it('keeps the engine-captured files of an editing run and drops malformed entries', () => {
  const state = reduceEngine(emptyEngineState, {
    type: 'code.assist.result',
    payload: {
      requestId: 'fix',
      status: 'done',
      appliedEdits: true,
      edits: [
        { path: 'src/a.ts', before: 'old' },
        { path: 'created.ts', before: null },
        { path: 'bad.ts' },
      ],
      uncaptured: ['bash'],
    },
  });
  expect(state.assists['fix']).toMatchObject({
    edits: [
      { path: 'src/a.ts', before: 'old' },
      { path: 'created.ts', before: null },
    ],
    uncaptured: ['bash'],
  });
});
