import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { gradeLocalManifest } from '../src/graders/local-manifest-grader.js';
import { createLocalManifestSuite } from '../src/suites/local-manifest.js';
import { createSmokeSuite, resolveSmokeSuiteDir, SMOKE_TASK_COUNT } from '../src/suites/smoke.js';

describe('createSmokeSuite', () => {
  it('loads the bundled three-task Node suite without an external checkout', async () => {
    const suite = createSmokeSuite();
    expect(suite.id).toBe('smoke');
    const tasks = await suite.loadTasks({});
    expect(tasks).toHaveLength(SMOKE_TASK_COUNT);
    expect(tasks.map((t) => t.id)).toEqual([
      'smoke/add-banner',
      'smoke/rename-export',
      'smoke/strip-todo',
    ]);
    expect(suite.subsetId(tasks)).toMatch(/^smoke:[0-9a-f]{12}$/);
    await expect(
      fs.access(path.join(resolveSmokeSuiteDir(), 'bench.local.json')),
    ).resolves.toBeUndefined();

    const inner = createLocalManifestSuite({ suiteDir: resolveSmokeSuiteDir() });
    const localTasks = await inner.loadTasks({});
    expect(suite.subsetId(tasks)).toBe(
      `smoke:${inner.subsetId(localTasks).slice('local:'.length)}`,
    );
  });

  it('honors --limit', async () => {
    const tasks = await createSmokeSuite().loadTasks({ limit: 1 });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.id).toBe('smoke/add-banner');
  });

  it('grades the pre-edit fixtures as failures (so a no-op model cannot pass)', async () => {
    const tasks = await createSmokeSuite().loadTasks({});
    for (const task of tasks) {
      const grade = await gradeLocalManifest({ workdir: task.templateDir, task, timeoutMs: 5_000 });
      expect(grade.passed, task.id).toBe(false);
    }
  });

  it('grades a correctly edited add-banner fixture as a pass', async () => {
    const tasks = await createSmokeSuite().loadTasks({ limit: 1 });
    const task = tasks[0];
    if (!task) throw new Error('expected add-banner');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bench-smoke-grade-'));
    try {
      await fs.copyFile(path.join(task.templateDir, 'README.md'), path.join(dir, 'README.md'));
      await fs.writeFile(
        path.join(dir, 'README.md'),
        '# WrongStack\nNotes for the sample project.\n',
        'utf8',
      );
      const grade = await gradeLocalManifest({ workdir: dir, task, timeoutMs: 5_000 });
      expect(grade.passed).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
