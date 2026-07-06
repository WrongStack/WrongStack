import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { gradeLocalManifest } from '../src/graders/local-manifest-grader.js';
import type { LocalTaskMeta } from '../src/suites/local-manifest.js';
import type { BenchTask } from '../src/types.js';

let tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tmpDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  tmpDirs = [];
});

async function makeWorkdir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bench-local-grader-'));
  tmpDirs.push(dir);
  return dir;
}

function task(meta: LocalTaskMeta, templateDir: string): BenchTask {
  return {
    id: 'local/test',
    suite: 'local',
    prompt: 'test',
    templateDir,
    meta: meta as never as Record<string, unknown>,
  };
}

describe('gradeLocalManifest', () => {
  it('passes when command and file assertions pass', async () => {
    const workdir = await makeWorkdir();
    await fs.writeFile(path.join(workdir, 'answer.txt'), 'hello\n', 'utf8');

    const result = await gradeLocalManifest({
      workdir,
      task: task(
        {
          manifestFile: 'bench.local.json',
          rawId: 'test',
          templateHash: 'abc',
          grader: {
            type: 'command',
            command: process.execPath,
            args: ['-e', 'process.exit(0)'],
            shell: false,
          },
          assertions: [
            { type: 'file_exists', path: 'answer.txt' },
            { type: 'file_contains', path: 'answer.txt', text: 'hello' },
            { type: 'file_not_contains', path: 'answer.txt', text: 'TODO' },
          ],
        },
        workdir,
      ),
      timeoutMs: 10_000,
    });

    expect(result).toEqual({ passed: true });
  });

  it('fails with command output when the command exits nonzero', async () => {
    const workdir = await makeWorkdir();
    const result = await gradeLocalManifest({
      workdir,
      task: task(
        {
          manifestFile: 'bench.local.json',
          rawId: 'test',
          templateHash: 'abc',
          grader: {
            type: 'command',
            command: process.execPath,
            args: ['-e', 'console.error("bad local grader"); process.exit(7)'],
            shell: false,
          },
        },
        workdir,
      ),
      timeoutMs: 10_000,
    });

    expect(result.passed).toBe(false);
    expect(result.detail).toContain('exit 7');
    expect(result.detail).toContain('bad local grader');
  });

  it('reports file assertion failures and blocks path escapes', async () => {
    const workdir = await makeWorkdir();
    await fs.writeFile(path.join(workdir, 'answer.txt'), 'hello\n', 'utf8');

    const result = await gradeLocalManifest({
      workdir,
      task: task(
        {
          manifestFile: 'bench.local.json',
          rawId: 'test',
          templateHash: 'abc',
          assertions: [
            { type: 'file_contains', path: 'answer.txt', text: 'goodbye' },
            { type: 'file_exists', path: '../outside.txt' },
          ],
        },
        workdir,
      ),
      timeoutMs: 10_000,
    });

    expect(result.passed).toBe(false);
    expect(result.detail).toContain('expected answer.txt to contain');
    expect(result.detail).toContain('assertion path escapes workdir');
  });
});
