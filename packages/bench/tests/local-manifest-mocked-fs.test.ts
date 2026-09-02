import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const controls = vi.hoisted(() => ({
  readFile: undefined as ((...args: unknown[]) => unknown) | undefined,
  readdir: undefined as ((...args: unknown[]) => unknown) | undefined,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: (...args: unknown[]) =>
      controls.readFile ? controls.readFile(...args) : actual.readFile(...(args as [never, never])),
    readdir: (...args: unknown[]) =>
      controls.readdir ? controls.readdir(...args) : actual.readdir(...(args as [never, never])),
  };
});

import { createLocalManifestSuite } from '../src/suites/local-manifest.js';

const tempDirs: string[] = [];

beforeEach(() => {
  controls.readFile = undefined;
  controls.readdir = undefined;
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bench-local-mocked-fs-'));
  tempDirs.push(dir);
  return dir;
}

async function manifest(dir: string, task: Record<string, unknown>): Promise<void> {
  await fs.writeFile(path.join(dir, 'bench.local.json'), JSON.stringify({ tasks: [task] }));
}

describe('local manifest non-Error filesystem failures', () => {
  it('stringifies a non-Error manifest read rejection', async () => {
    controls.readFile = () => Promise.reject('plain manifest failure');

    await expect(createLocalManifestSuite({ suiteDir: '/suite' }).loadTasks({})).rejects.toThrow(
      'plain manifest failure',
    );
  });

  it('stringifies a non-Error transcript read rejection', async () => {
    const dir = await makeDir();
    const fixture = path.join(dir, 'fixture');
    await fs.mkdir(fixture);
    await manifest(dir, {
      id: 'trace',
      prompt: 'Trace',
      templateDir: './fixture',
      assertions: [{ type: 'file_exists', path: 'value.txt' }],
      traceEval: {
        source: {
          sessionId: 'session',
          transcriptPath: './source.jsonl',
          sha256: 'a'.repeat(64),
          eventStart: 0,
          eventEnd: 0,
        },
        retrieval: [{ contains: 'x' }],
        recall: { inputContains: ['x'] },
      },
    });
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    controls.readFile = (...args) =>
      String(args[0]).endsWith('source.jsonl')
        ? Promise.reject('plain transcript failure')
        : actual.readFile(args[0] as never, args[1] as never);

    await expect(createLocalManifestSuite({ suiteDir: dir }).loadTasks({})).rejects.toThrow(
      'plain transcript failure',
    );
  });

  it('stringifies a non-Error template directory rejection', async () => {
    const dir = await makeDir();
    const fixture = path.join(dir, 'fixture');
    await fs.mkdir(fixture);
    await manifest(dir, {
      id: 'template',
      prompt: 'Template',
      templateDir: './fixture',
      assertions: [{ type: 'file_exists', path: 'value.txt' }],
    });
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    controls.readdir = (...args) =>
      path.resolve(String(args[0])) === fixture
        ? Promise.reject('plain template failure')
        : actual.readdir(args[0] as never, args[1] as never);

    await expect(createLocalManifestSuite({ suiteDir: dir }).loadTasks({})).rejects.toThrow(
      'plain template failure',
    );
  });

  it('ignores a directory entry that is not a file, directory, or symbolic link', async () => {
    const dir = await makeDir();
    const fixture = path.join(dir, 'fixture');
    await fs.mkdir(fixture);
    await manifest(dir, {
      id: 'special',
      prompt: 'Special',
      templateDir: './fixture',
      assertions: [{ type: 'file_exists', path: 'value.txt' }],
    });
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    controls.readdir = (...args) =>
      path.resolve(String(args[0])) === fixture
        ? Promise.resolve([
            {
              name: 'special',
              isDirectory: () => false,
              isFile: () => false,
              isSymbolicLink: () => false,
            },
          ])
        : actual.readdir(args[0] as never, args[1] as never);

    await expect(createLocalManifestSuite({ suiteDir: dir }).loadTasks({})).resolves.toHaveLength(
      1,
    );
  });
});
