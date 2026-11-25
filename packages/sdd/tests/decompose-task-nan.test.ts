import { describe, expect, it } from 'vitest';
import { makeLlmSubtaskGenerator, makePlanningDecomposer } from '../src/decompose-task.js';

describe('decompose-task non-finite subtask bounds', () => {
  it('falls back to defaults when minSubtasks or maxSubtasks is NaN', async () => {
    const json = JSON.stringify([
      { title: 'Step 1', description: 'Do part 1' },
      { title: 'Step 2', description: 'Do part 2' },
    ]);
    const decompose = makePlanningDecomposer({
      minSubtasks: Number.NaN,
      maxSubtasks: Number.NaN,
      run: async () => json,
    });
    expect(
      await decompose({ title: 'Big', description: 'Task', reasons: ['too big'] }),
    ).toHaveLength(2);

    const gen = makeLlmSubtaskGenerator({
      minSubtasks: Number.NaN,
      maxSubtasks: Number.NaN,
      run: async () => json,
    });
    expect(
      await gen({
        task: { id: 't1', title: 'Big', description: 'Task' } as never,
        error: 'failed',
      }),
    ).toHaveLength(2);
  });
});
