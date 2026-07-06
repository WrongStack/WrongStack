import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalManifestSuite } from '../src/suites/local-manifest.js';

let tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tmpDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  tmpDirs = [];
});

async function makeTmp(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bench-local-suite-'));
  tmpDirs.push(dir);
  return dir;
}

describe('createLocalManifestSuite', () => {
  it('loads manifest tasks and includes template content in the subset id', async () => {
    const dir = await makeTmp();
    const fixture = path.join(dir, 'fixtures', 'hello');
    await fs.mkdir(path.join(fixture, '.hidden'), { recursive: true });
    await fs.writeFile(path.join(fixture, 'answer.txt'), 'hello\n', 'utf8');
    await fs.writeFile(path.join(fixture, '.hidden', 'reference.txt'), 'secret\n', 'utf8');
    await fs.writeFile(
      path.join(dir, 'bench.local.json'),
      JSON.stringify(
        {
          tasks: [
            {
              id: 'hello',
              prompt: 'Make answer.txt say hello.',
              templateDir: './fixtures/hello',
              templateExclude: ['.hidden'],
              assertions: [{ type: 'file_contains', path: 'answer.txt', text: 'hello' }],
            },
          ],
        },
        null,
        2,
      ),
      'utf8',
    );

    const suite = createLocalManifestSuite({ suiteDir: dir });
    const tasks = await suite.loadTasks({});
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.id).toBe('local/hello');
    expect(tasks[0]?.suite).toBe('local');
    expect(tasks[0]?.templateDir).toBe(fixture);
    expect(tasks[0]?.templateExclude).toEqual(['.hidden']);

    const firstSubset = suite.subsetId(tasks);
    await fs.writeFile(path.join(fixture, 'answer.txt'), 'hello changed\n', 'utf8');
    const secondSubset = suite.subsetId(await suite.loadTasks({}));
    expect(secondSubset).not.toBe(firstSubset);
  });

  it('validates tasks have at least one deterministic grader signal', async () => {
    const dir = await makeTmp();
    await fs.mkdir(path.join(dir, 'fixture'), { recursive: true });
    await fs.writeFile(
      path.join(dir, 'bench.local.json'),
      JSON.stringify({
        tasks: [{ id: 'bad', prompt: 'Do something.', templateDir: './fixture' }],
      }),
      'utf8',
    );

    const suite = createLocalManifestSuite({ suiteDir: dir });
    await expect(suite.loadTasks({})).rejects.toThrow(/grader or at least one assertion/);
  });

  it('respects the task limit', async () => {
    const dir = await makeTmp();
    await fs.mkdir(path.join(dir, 'fixture'), { recursive: true });
    await fs.writeFile(path.join(dir, 'fixture', 'x.txt'), 'x', 'utf8');
    await fs.writeFile(
      path.join(dir, 'bench.local.json'),
      JSON.stringify({
        tasks: [
          {
            id: 'one',
            prompt: 'One.',
            templateDir: './fixture',
            assertions: [{ type: 'file_exists', path: 'x.txt' }],
          },
          {
            id: 'two',
            prompt: 'Two.',
            templateDir: './fixture',
            assertions: [{ type: 'file_exists', path: 'x.txt' }],
          },
        ],
      }),
      'utf8',
    );

    const suite = createLocalManifestSuite({ suiteDir: dir });
    const tasks = await suite.loadTasks({ limit: 1 });
    expect(tasks.map((task) => task.id)).toEqual(['local/one']);
  });
});
