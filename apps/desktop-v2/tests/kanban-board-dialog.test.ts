import { expect, it } from 'vitest';
import { boardListTasks } from '../src/KanbanBoardDialog';

it('turns each non-empty line into one task the way the engine does', () => {
  expect(
    boardListTasks('- Design the schema\n\n  * Write the migration  \n# Add the route\nPlain\n'),
  ).toEqual(['Design the schema', 'Write the migration', 'Add the route', 'Plain']);
  expect(boardListTasks('\n  \n-\n')).toEqual([]);
  // Only one leading marker is removed, as in the engine.
  expect(boardListTasks('- - nested')).toEqual(['- nested']);
});
