import { expect, it } from 'vitest';
import { chainCards } from '../src/KanbanTaskChain';

it('reads chain cards in order and skips cards without an id', () => {
  expect(chainCards({ tasks: [{ id: 'a', title: 'A' }, { title: 'x' }, { id: 'b' }] })).toEqual([
    ['a', 'A'],
    ['b', 'b'],
  ]);
  expect(chainCards(null)).toEqual([]);
});
