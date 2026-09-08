import { beforeEach, describe, expect, it, vi } from 'vitest';

const controls = vi.hoisted(() => ({
  readdir: undefined as ((...args: unknown[]) => unknown) | undefined,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readdir: (...args: unknown[]) =>
      controls.readdir ? controls.readdir(...args) : actual.readdir(...(args as [never, never])),
  };
});

import { createPolyglotSuite } from '../src/suites/polyglot.js';

beforeEach(() => {
  controls.readdir = undefined;
});

describe('polyglot mocked fs', () => {
  it('handles duplicate directory entries when sorting slugs', async () => {
    controls.readdir = () =>
      Promise.resolve([
        {
          name: 'beta',
          isDirectory: () => true,
        },
        {
          name: 'alpha',
          isDirectory: () => true,
        },
        {
          name: 'beta',
          isDirectory: () => true,
        },
      ]);

    const suite = createPolyglotSuite({ polyglotDir: '/fake/polyglot' });
    const tasks = await suite.loadTasks({ limit: 1 });
    expect(tasks).toBeDefined();
  });
});
