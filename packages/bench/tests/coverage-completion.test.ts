import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { gradeLocalManifest } from '../src/graders/local-manifest-grader.js';
import { createLocalManifestSuite, type LocalTaskMeta } from '../src/suites/local-manifest.js';
import type { BenchTask } from '../src/types.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) =>
      fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {}),
    ),
  );
});

async function makeSuiteDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bench-coverage-completion-'));
  tempDirs.push(dir);
  await fs.mkdir(path.join(dir, 'fixture'), { recursive: true });
  await fs.writeFile(path.join(dir, 'fixture', 'value.txt'), 'value', 'utf8');
  return dir;
}

async function writeManifest(dir: string, tasks: Record<string, unknown>[]): Promise<void> {
  await fs.writeFile(path.join(dir, 'bench.local.json'), JSON.stringify({ tasks }), 'utf8');
}

function graderTask(workdir: string, meta: Partial<LocalTaskMeta>): BenchTask {
  return {
    id: 'local/coverage',
    suite: 'local',
    prompt: 'cover',
    templateDir: workdir,
    meta: {
      manifestFile: 'bench.local.json',
      rawId: 'coverage',
      templateHash: 'hash',
      ...meta,
    } as never as Record<string, unknown>,
  };
}

describe('bench final coverage branches', () => {
  it('loads a grader-only task with optional fields omitted and hashes its subset', async () => {
    const dir = await makeSuiteDir();
    await writeManifest(dir, [
      {
        id: 'grader-only',
        prompt: 'Run',
        templateDir: './fixture',
        grader: { type: 'command', command: process.execPath },
      },
    ]);
    const suite = createLocalManifestSuite({ suiteDir: dir });

    const tasks = await suite.loadTasks({});

    expect(tasks).toHaveLength(1);
    expect(suite.subsetId(tasks)).toMatch(/^local:/);
  });

  it('includes trace metadata in subset hashing and accepts resumed sessions with corrupt rows', async () => {
    const dir = await makeSuiteDir();
    const transcriptDir = path.join(dir, 'corpus');
    await fs.mkdir(transcriptDir, { recursive: true });
    const raw = [
      '{ corrupt',
      JSON.stringify('not a record'),
      JSON.stringify({ type: 'session_resumed', id: 'session-1' }),
      JSON.stringify({ type: 'tool_use', id: 'read-1', name: 'read' }),
    ].join('\n');
    const transcriptPath = path.join(transcriptDir, 'source.jsonl');
    await fs.writeFile(transcriptPath, raw, 'utf8');
    const sha256 = createHash('sha256').update(raw).digest('hex');
    await writeManifest(dir, [
      {
        id: 'trace',
        prompt: 'Trace',
        templateDir: './fixture',
        assertions: [{ type: 'file_exists', path: 'value.txt' }],
        traceEval: {
          source: {
            sessionId: 'session-1',
            transcriptPath: './corpus/source.jsonl',
            sha256,
            eventStart: 0,
            eventEnd: 1,
          },
          retrieval: [{ contains: 'value' }],
          recall: { inputContains: ['value'] },
        },
      },
    ]);
    const suite = createLocalManifestSuite({ suiteDir: dir });

    const tasks = await suite.loadTasks({});

    expect(tasks[0]?.traceEval?.source.transcriptPath).toBe(transcriptPath);
    expect(suite.subsetId(tasks)).toMatch(/^local:/);
  });

  it.each([
    ['retrieval expectation', { retrieval: [false], recall: { inputContains: ['x'] } }],
    ['recall expectation', { retrieval: [{ contains: 'x' }], recall: false }],
  ])('rejects a non-object %s', async (_label, traceFields) => {
    const dir = await makeSuiteDir();
    await writeManifest(dir, [
      {
        id: 'invalid-trace',
        prompt: 'Trace',
        templateDir: './fixture',
        assertions: [{ type: 'file_exists', path: 'value.txt' }],
        traceEval: {
          source: {
            sessionId: 'session-1',
            transcriptPath: './corpus/source.jsonl',
            sha256: 'a'.repeat(64),
            eventStart: 0,
            eventEnd: 0,
          },
          ...traceFields,
        } as never,
      },
    ]);

    await expect(createLocalManifestSuite({ suiteDir: dir }).loadTasks({})).rejects.toThrow(
      /must be an object/,
    );
  });

  it('hashes a directory junction through the symbolic-link branch', async () => {
    const dir = await makeSuiteDir();
    const target = path.join(dir, 'linked-target');
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, 'linked.txt'), 'linked', 'utf8');
    await fs.symlink(target, path.join(dir, 'fixture', 'link'), 'junction');
    await writeManifest(dir, [
      {
        id: 'junction',
        prompt: 'Hash',
        templateDir: './fixture',
        assertions: [{ type: 'file_exists', path: 'value.txt' }],
      },
    ]);

    const tasks = await createLocalManifestSuite({ suiteDir: dir }).loadTasks({});

    expect(tasks).toHaveLength(1);
  });

  it('reports a missing file_exists assertion', async () => {
    const dir = await makeSuiteDir();
    const result = await gradeLocalManifest({
      workdir: dir,
      task: graderTask(dir, {
        assertions: [{ type: 'file_exists', path: 'missing.txt' }],
      }),
      timeoutMs: 10_000,
    });

    expect(result).toEqual({
      passed: false,
      detail: 'expected file to exist: missing.txt',
    });
  });

  it('uses defaults for absent assertions and command args', async () => {
    const dir = await makeSuiteDir();
    const result = await gradeLocalManifest({
      workdir: dir,
      task: graderTask(dir, {
        grader: {
          type: 'command',
          command: process.execPath,
          shell: false,
        },
      }),
      timeoutMs: 50,
    });

    expect(result.detail).toContain('command timed out');
  });
});
