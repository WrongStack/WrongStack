import { expect, it } from 'vitest';
import { readInjections } from '../src/SageInjectionHistory';

it('reads injection audit events and drops other or empty ones', () => {
  expect(
    readInjections([
      {
        event: 'memory.injected',
        at: '2',
        details: { memoryIds: ['a', 7], trigger: 'tool', sessionId: 's' },
      },
      { event: 'memory.used', at: '1', details: { memoryIds: ['a'] } },
      { event: 'memory.injected', at: '0', details: { memoryIds: [] } },
    ]),
  ).toEqual([{ at: '2', trigger: 'tool', sessionId: 's', memoryIds: ['a'] }]);
});
