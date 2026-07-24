import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalTaskMeta } from '../src/suites/local-manifest.js';
import type { BenchTask } from '../src/types.js';

const doubles = vi.hoisted(() => ({
  execCommand: vi.fn(),
  access: vi.fn(),
  readFile: vi.fn(),
}));

vi.mock('../src/exec-command.js', () => ({ execCommand: doubles.execCommand }));
vi.mock('node:fs/promises', () => ({
  access: doubles.access,
  readFile: doubles.readFile,
}));

import { gradeLocalManifest } from '../src/graders/local-manifest-grader.js';

function task(meta: Partial<LocalTaskMeta>): BenchTask {
  return {
    id: 'local/mocked',
    suite: 'local',
    prompt: 'mocked',
    templateDir: '/work',
    meta: {
      manifestFile: 'bench.local.json',
      rawId: 'mocked',
      templateHash: 'hash',
      ...meta,
    } as never as Record<string, unknown>,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  doubles.access.mockResolvedValue(undefined);
  doubles.readFile.mockResolvedValue('content');
});

describe('local manifest grader mocked edge values', () => {
  it('defaults absent assertions to an empty list', async () => {
    await expect(
      gradeLocalManifest({
        workdir: '/work',
        task: task({}),
        timeoutMs: 100,
      }),
    ).resolves.toEqual({ passed: true });
  });

  it('reports an unknown command exit and keeps only the long output tail', async () => {
    doubles.execCommand
      .mockResolvedValueOnce({
        timedOut: false,
        truncated: false,
        exitCode: null,
        stdout: '',
        stderr: '',
      })
      .mockResolvedValueOnce({
        timedOut: false,
        truncated: false,
        exitCode: 1,
        stdout: 'x'.repeat(600),
        stderr: '',
      });
    const meta: Partial<LocalTaskMeta> = {
      grader: { type: 'command', command: 'mock' },
    };

    const unknown = await gradeLocalManifest({
      workdir: '/work',
      task: task(meta),
      timeoutMs: 100,
    });
    const long = await gradeLocalManifest({
      workdir: '/work',
      task: task(meta),
      timeoutMs: 100,
    });

    expect(unknown.detail).toContain('exit unknown');
    expect(long.detail).toContain(`...${'x'.repeat(500)}`);
  });

  it('stringifies a non-Error read failure', async () => {
    doubles.readFile.mockRejectedValue('plain failure');

    const result = await gradeLocalManifest({
      workdir: '/work',
      task: task({
        assertions: [{ type: 'file_contains', path: 'value.txt', text: 'x' }],
      }),
      timeoutMs: 100,
    });

    expect(result.detail).toContain(`cannot read value.txt: plain failure`);
    expect(doubles.readFile).toHaveBeenCalledWith(path.resolve('/work', 'value.txt'), 'utf8');
  });
});
