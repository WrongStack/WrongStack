import { describe, expect, it } from 'vitest';
import { fileReducers } from '../src/lib/reducers/files';

describe('fileReducers["git.diff"] blank path guard (F2278)', () => {
  it('ignores git.diff frames with whitespace-only path', () => {
    const state = {
      diffs: { 'a.ts': { path: 'a.ts', oldText: '', newText: '', error: '' } },
    } as never;
    const next = fileReducers['git.diff']!(state, { path: '   ', oldText: '', newText: '' }, {
      type: 'git.diff',
    } as never);
    expect(Object.keys(next.diffs)).toEqual(['a.ts']);
  });
});
