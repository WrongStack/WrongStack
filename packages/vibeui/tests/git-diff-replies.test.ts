import { expect, it } from 'vitest';
import { initialState, reduceFrame, type SessionState } from '../src/lib/session';

const reply = (path: string, newText: string) =>
  ({ type: 'git.diff', payload: { path, oldText: '', newText } }) as never;

it('keeps the opened file diff when an earlier request answers late', () => {
  let state: SessionState = { ...initialState(), id: 's1' };
  // The server answers each request on its own, so `a.ts` (asked first) can land last.
  state = reduceFrame(state, reply('b.ts', 'B'));
  state = reduceFrame(state, reply('a.ts', 'A'));
  expect(state.diffs['b.ts']?.newText).toBe('B');
  expect(state.diffs['a.ts']?.newText).toBe('A');
});

it('keeps only the most recently answered diffs', () => {
  let state: SessionState = { ...initialState(), id: 's1' };
  for (const n of ['1', '2', '3', '4', '5']) state = reduceFrame(state, reply(`${n}.ts`, n));
  expect(Object.keys(state.diffs)).toEqual(['2.ts', '3.ts', '4.ts', '5.ts']);
});
