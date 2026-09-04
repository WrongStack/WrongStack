import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSwebenchSuite, loadSubset, type SwebenchMeta } from '../src/suites/swebench.js';

let dir: string;
const subsetPath = () => path.join(dir, 'subset.json');

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'swebench-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('loadSubset', () => {
  it('reads the committed default subset when no file is given', async () => {
    const ids = await loadSubset();
    expect(Array.isArray(ids)).toBe(true);
    expect(ids.length).toBeGreaterThan(0);
    expect(typeof ids[0]).toBe('string');
  });

  it('reads a custom subset file and filters out non-strings', async () => {
    await fs.writeFile(subsetPath(), JSON.stringify({ instances: ['a', 'b', 42, null] }));
    expect(await loadSubset(subsetPath())).toEqual(['a', 'b']);
  });

  it('throws when the instances array is missing', async () => {
    await fs.writeFile(subsetPath(), JSON.stringify({ notInstances: [] }));
    await expect(loadSubset(subsetPath())).rejects.toThrow(/missing an "instances" array/);
  });
});

describe('createSwebenchSuite.loadTasks', () => {
  async function writeInstance(id: string, meta: Record<string, unknown>): Promise<void> {
    const d = path.join(dir, 'dataset', id);
    await fs.mkdir(d, { recursive: true });
    await fs.writeFile(path.join(d, 'instance.json'), JSON.stringify(meta));
  }

  it('throws an actionable error without a dataset directory', async () => {
    await fs.writeFile(subsetPath(), JSON.stringify({ instances: ['x'] }));
    const suite = createSwebenchSuite({ subsetFile: subsetPath() });
    await expect(suite.loadTasks({})).rejects.toThrow(/prepared dataset directory/);
  });

  it('builds tasks from materialized instances and skips missing ones', async () => {
    await fs.writeFile(subsetPath(), JSON.stringify({ instances: ['inst-1', 'inst-2'] }));
    await writeInstance('inst-1', {
      problem_statement: 'Fix the bug',
      image: 'swebench/inst-1:latest',
      FAIL_TO_PASS: ['test_a'],
      PASS_TO_PASS: ['test_b'],
      test_patch: 'diff --git ...',
    });
    // inst-2 is NOT materialized → should be skipped.
    const suite = createSwebenchSuite({
      subsetFile: subsetPath(),
      datasetDir: path.join(dir, 'dataset'),
    });
    const tasks = await suite.loadTasks({});
    expect(tasks).toHaveLength(1);
    const t = tasks[0]!;
    expect(t.id).toBe('swebench/inst-1');
    expect(t.prompt).toMatch(/Fix the bug/);
    expect(t.templateDir).toBe(path.join(dir, 'dataset', 'inst-1', 'repo'));
    const meta = t.meta as never as SwebenchMeta;
    expect(meta).toMatchObject({
      instanceId: 'inst-1',
      image: 'swebench/inst-1:latest',
      failToPass: ['test_a'],
      passToPass: ['test_b'],
    });
  });

  it('defaults missing fields and a non-string problem statement', async () => {
    await fs.writeFile(subsetPath(), JSON.stringify({ instances: ['inst-min'] }));
    await writeInstance('inst-min', { problem_statement: 123 }); // non-string → ''
    const suite = createSwebenchSuite({
      subsetFile: subsetPath(),
      datasetDir: path.join(dir, 'dataset'),
    });
    const tasks = await suite.loadTasks({});
    const meta = tasks[0]!.meta as never as SwebenchMeta;
    expect(meta.failToPass).toEqual([]);
    expect(meta.passToPass).toEqual([]);
    expect(meta.image).toBeUndefined();
  });

  it('respects the limit', async () => {
    await fs.writeFile(subsetPath(), JSON.stringify({ instances: ['i1', 'i2'] }));
    await writeInstance('i1', { problem_statement: 'a' });
    await writeInstance('i2', { problem_statement: 'b' });
    const suite = createSwebenchSuite({
      subsetFile: subsetPath(),
      datasetDir: path.join(dir, 'dataset'),
    });
    expect(await suite.loadTasks({ limit: 1 })).toHaveLength(1);
  });
});

describe('createSwebenchSuite.subsetId', () => {
  it('is order-independent', () => {
    const suite = createSwebenchSuite();
    const a = suite.subsetId([{ id: 'swebench/x' }, { id: 'swebench/y' }] as never);
    const b = suite.subsetId([{ id: 'swebench/y' }, { id: 'swebench/x' }] as never);
    expect(a).toBe(b);
    expect(a).toMatch(/^swebench:[0-9a-f]{12}$/);
  });
});
