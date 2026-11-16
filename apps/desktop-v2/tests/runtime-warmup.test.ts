import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { warmRuntimes } from '../src/runtime-warmup';

const run = (layout: string | null, projects = [{ id: 'p1' }]) => {
  const calls: [string, Record<string, unknown>][] = [];
  warmRuntimes({ projects }, layout, async (method, params) => {
    calls.push([method, params]);
  });
  vi.runAllTimers();
  return calls;
};

describe('demand-driven runtime warm-up at launch', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it('starts only the project whose workspace is visible', () => {
    expect(run(JSON.stringify({ project: 'p1', section: 'project' }))).toEqual([
      ['project.open', { projectId: 'p1' }],
    ]);
  });

  it('does not start engines for fleet or the project list', () => {
    for (const section of ['fleet', 'projects', 'activity'])
      expect(run(JSON.stringify({ project: 'p1', section })), section).toEqual([]);
  });

  it.each(['wrongstack', 'engine'])(
    'starts only the profile when returning to %s settings',
    (section) => {
      expect(run(JSON.stringify({ project: 'p1', section }))).toEqual([['profile.open', {}]]);
    },
  );

  it('does not start engines without a valid visible workspace', () => {
    for (const layout of [
      null,
      '{bad',
      'null',
      '[]',
      '42',
      JSON.stringify({ project: 'gone', section: 'project' }),
      JSON.stringify({ project: 'p1' }),
      JSON.stringify({}),
    ])
      expect(run(layout), String(layout)).toEqual([]);
  });
});
