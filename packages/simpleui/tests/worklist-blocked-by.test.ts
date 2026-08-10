import { describe, expect, it } from 'vitest';
import { parseSimpleTodos } from '../src/lib/worklist-store.js';

/**
 * `blockedBy` is board-derived and travels over the wire as plain JSON. Every
 * surface redeclares its own todo shape, so a field added in core reaches a UI
 * only if that UI's parser was taught about it — which is exactly why the
 * readiness the board computes on every mutation never used to arrive here.
 */
describe('SimpleUI worklist parses the blocking reason', () => {
  it('carries blockedBy through the wire parser', () => {
    const [todo] = parseSimpleTodos([
      {
        id: 't1',
        content: 'Backfill rows',
        status: 'pending',
        blockedBy: ['Migrate schema', 'Take backup'],
      },
    ]);

    expect(todo?.blockedBy).toEqual(['Migrate schema', 'Take backup']);
  });

  it('drops non-string entries instead of rendering them', () => {
    const [todo] = parseSimpleTodos([
      { id: 't1', content: 'Work', status: 'pending', blockedBy: ['Real', 42, null, '  '] },
    ]);

    expect(todo?.blockedBy).toEqual(['Real']);
  });

  it('omits the field when there is nothing blocking', () => {
    const [plain] = parseSimpleTodos([{ id: 't1', content: 'Work', status: 'pending' }]);
    const [empty] = parseSimpleTodos([
      { id: 't2', content: 'Work', status: 'pending', blockedBy: [] },
    ]);

    expect(plain?.blockedBy).toBeUndefined();
    expect(empty?.blockedBy).toBeUndefined();
  });
});
