import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
// We import the grader and the dependencies directly so we can test
// the externalGrade returning undefined path.
import { gradeSwebench } from '../src/graders/swebench-grader.js';
import type { ModelCell } from '../src/types.js';

const cell: ModelCell = { label: 'gpt-4', provider: 'openai', model: 'gpt-4' };

/**
 * Create a temp dir with a minimal git repo so extractModelPatch's
 * git commands succeed.
 */
async function makeGitRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bench-sweb-cov-'));
  await execCommand({
    command: 'git',
    args: ['init'],
    cwd: dir,
    timeoutMs: 10_000,
    shell: false,
  });
  await execCommand({
    command: 'git',
    args: ['config', 'user.email', 'test@test'],
    cwd: dir,
    timeoutMs: 10_000,
    shell: false,
  });
  await execCommand({
    command: 'git',
    args: ['config', 'user.name', 'Test'],
    cwd: dir,
    timeoutMs: 10_000,
    shell: false,
  });
  // Create an initial commit so git refs work
  await fs.writeFile(path.join(dir, 'README.md'), 'test repo', 'utf8');
  await execCommand({
    command: 'git',
    args: ['add', '-A'],
    cwd: dir,
    timeoutMs: 10_000,
    shell: false,
  });
  await execCommand({
    command: 'git',
    args: ['commit', '-m', 'initial'],
    cwd: dir,
    timeoutMs: 10_000,
    shell: false,
  });
  return dir;
}

import { execCommand } from '../src/exec-command.js';

describe('gradeSwebench — edge cases', () => {
  it('returns exported-but-ungraded when externalGrade returns undefined', async () => {
    // externalGrade resolving to undefined means the inline grader
    // could not produce a verdict → graded: false
    const dir = await makeGitRepo();
    // Write a file AFTER the initial commit so git sees a new change
    await fs.writeFile(path.join(dir, 'fix.py'), 'print("fixed")\n', 'utf8');
    try {
      const result = await gradeSwebench({
        workdir: dir,
        task: {
          id: 'django__django-12345',
          suite: 'swebench',
          prompt: 'Fix the bug',
          templateDir: dir,
          meta: {
            instanceId: 'django__django-12345',
            failToPass: ['test_a'],
            passToPass: ['test_b'],
            testPatch: 'diff --git a/test.py b/test.py\n',
          } as never,
        },
        cell,
        timeoutMs: 10_000,
        predictionsDir: path.join(dir, 'preds'),
        externalGrade: async () => undefined, // inline grader returns no verdict
      });
      expect(result.passed).toBe(false);
      expect(result.graded).toBe(false);
      expect(result.detail).toContain('patch exported');
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('returns graded:true when externalGrade resolves true', async () => {
    const dir = await makeGitRepo();
    // Write a file AFTER the initial commit so git sees a new change
    await fs.writeFile(path.join(dir, 'fix.py'), 'print("fixed")\n', 'utf8');
    try {
      const result = await gradeSwebench({
        workdir: dir,
        task: {
          id: 'sympy__sympy-1',
          suite: 'swebench',
          prompt: 'Fix',
          templateDir: dir,
          meta: {
            instanceId: 'sympy__sympy-1',
            failToPass: ['test_x'],
            passToPass: ['test_y'],
            testPatch: 'diff --git a/test.py b/test.py\n',
          } as never,
        },
        cell,
        timeoutMs: 10_000,
        predictionsDir: path.join(dir, 'preds'),
        externalGrade: async () => true,
      });
      expect(result.passed).toBe(true);
      expect(result.graded).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('reports empty patch as a genuine gradeable failure', async () => {
    const dir = await makeGitRepo();
    try {
      // No changes beyond the initial commit → git diff produces no patch
      const result = await gradeSwebench({
        workdir: dir,
        task: {
          id: 'empty__patch',
          suite: 'swebench',
          prompt: 'Do nothing',
          templateDir: dir,
          meta: {
            instanceId: 'empty__patch',
            failToPass: [],
            passToPass: [],
            testPatch: '',
          } as never,
        },
        cell,
        timeoutMs: 10_000,
        predictionsDir: path.join(dir, 'preds'),
      });
      expect(result.passed).toBe(false);
      expect(result.graded).toBe(true);
      expect(result.detail).toContain('empty patch');
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
