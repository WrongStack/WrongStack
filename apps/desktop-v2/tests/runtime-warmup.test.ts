import { describe, expect, it } from 'vitest';
import { warmRuntimes } from '../src/runtime-warmup';

const run = (layout: string | null, projects = [{ id: 'p1' }]) => {
  const calls: [string, Record<string, unknown>][] = [];
  const delayed: number[] = [];
  warmRuntimes(
    { projects } as never,
    layout,
    async (method, params) => {
      calls.push([method, params]);
    },
    (start, ms) => {
      delayed.push(ms);
      start();
    },
  );
  return { calls, delayed };
};

describe('runtime warm-up at launch', () => {
  it('starts the project the saved layout returns to at once, the profile engine later', () => {
    const { calls, delayed } = run(JSON.stringify({ project: 'p1', section: 'project' }));
    expect(calls).toEqual([
      ['project.open', { projectId: 'p1' }],
      ['profile.open', {}],
    ]);
    expect(delayed).toEqual([3000]);
  });

  it('starts only the profile engine without a known saved project', () => {
    for (const layout of [null, '{bad', JSON.stringify({ project: 'gone' }), JSON.stringify({})])
      expect(run(layout).calls, String(layout)).toEqual([['profile.open', {}]]);
  });
});
