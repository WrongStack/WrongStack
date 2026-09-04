import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { gradeLocalManifest } from '../src/graders/local-manifest-grader.js';
import { CORE_TASK_COUNT, createCoreSuite, resolveCoreSuiteDir } from '../src/suites/core.js';
import { createLocalManifestSuite } from '../src/suites/local-manifest.js';

describe('createCoreSuite', () => {
  it('loads six Node agent-edit tasks without an external checkout', async () => {
    const suite = createCoreSuite();
    expect(suite.id).toBe('core');
    const tasks = await suite.loadTasks({});
    expect(tasks).toHaveLength(CORE_TASK_COUNT);
    expect(tasks.map((t) => t.id)).toEqual([
      'core/merge-intervals',
      'core/broken-pager',
      'core/cross-file-rename',
      'core/frozen-contract',
      'core/query-parser',
      'core/rate-limiter',
    ]);
    expect(suite.subsetId(tasks)).toMatch(/^core:[0-9a-f]{12}$/);
    const inner = createLocalManifestSuite({ suiteDir: resolveCoreSuiteDir() });
    const localTasks = await inner.loadTasks({});
    expect(suite.subsetId(tasks)).toBe(`core:${inner.subsetId(localTasks).slice('local:'.length)}`);
  });

  it('grades the shipping fixtures as failures so a no-op model cannot pass', async () => {
    const tasks = await createCoreSuite().loadTasks({});
    for (const task of tasks) {
      const grade = await gradeLocalManifest({ workdir: task.templateDir, task, timeoutMs: 5_000 });
      expect(grade.passed, task.id).toBe(false);
    }
  });

  it('passes merge-intervals when the implementation is correct and tests are intact', async () => {
    const tasks = await createCoreSuite().loadTasks({ limit: 1 });
    const task = tasks[0];
    if (!task) throw new Error('expected merge-intervals');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bench-core-grade-'));
    try {
      await fs.cp(task.templateDir, dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, 'src', 'merge.js'),
        `export function mergeIntervals(intervals) {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [start, end] of sorted) {
    const last = out[out.length - 1];
    if (!last || start > last[1]) out.push([start, end]);
    else last[1] = Math.max(last[1], end);
  }
  return out;
}
`,
        'utf8',
      );
      const grade = await gradeLocalManifest({ workdir: dir, task, timeoutMs: 5_000 });
      expect(grade.passed).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('fails merge-intervals if the agent guts the tests', async () => {
    const tasks = await createCoreSuite().loadTasks({ limit: 1 });
    const task = tasks[0];
    if (!task) throw new Error('expected merge-intervals');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bench-core-cheat-'));
    try {
      await fs.cp(task.templateDir, dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'test.mjs'), 'console.log("ok")\n', 'utf8');
      const grade = await gradeLocalManifest({ workdir: dir, task, timeoutMs: 5_000 });
      expect(grade.passed).toBe(false);
      expect(grade.detail).toMatch(/CORE_SENTINEL_merge-intervals/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
