import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { KanbanBoard, KanbanTask } from '../src/types.js';
import {
  BoundedProcessOutput,
  DEFAULT_ALLOWED_COMMANDS,
  DEFAULT_BLOCKED_COMMANDS,
  parseGitNameStatus,
  parseGitNumstat,
  VerificationContext,
  validateCommand,
} from '../src/verification/verification-context.js';

const execFileAsync = promisify(execFile);
const roots: string[] = [];

function fixture(): { board: KanbanBoard; task: KanbanTask } {
  const now = '2026-07-23T00:00:00.000Z';
  const task: KanbanTask = {
    id: 'task-1',
    title: 'Verify release',
    columnId: 'review',
    order: 0,
    priority: 'high',
    status: 'review',
    createdAt: now,
    updatedAt: now,
  };
  const board: KanbanBoard = {
    id: 'board-1',
    title: 'Release',
    columns: [{ id: 'review', title: 'Review', order: 0, wipLimit: 0 }],
    tasks: [task],
    createdAt: now,
    updatedAt: now,
    version: 1,
  };
  return { board, task };
}

async function context(
  root?: string,
  commandAllowlist?: ConstructorParameters<typeof VerificationContext>[0]['commandAllowlist'],
): Promise<VerificationContext> {
  const projectRoot = root ?? (await mkdtemp(join(tmpdir(), 'verification-context-')));
  if (!root) roots.push(projectRoot);
  const { board, task } = fixture();
  return new VerificationContext({ projectRoot, board, task, commandAllowlist });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('VerificationContext command security', () => {
  it('bounds retained output from chatty child processes', () => {
    const output = new BoundedProcessOutput(8);
    output.append(Buffer.from('abcde'));
    output.append(Buffer.from('fghij'));
    output.append(Buffer.from('ignored'));

    expect(output.retainedBytes).toBe(8);
    expect(output.toString()).toContain('abcdefgh\n--- output truncated after 8 bytes ---');
  });

  it('keeps package managers and runtimes out of the generic allowlist', () => {
    const allow = new Set(DEFAULT_ALLOWED_COMMANDS);
    const block = new Set(DEFAULT_BLOCKED_COMMANDS);

    expect(validateCommand('pnpm vitest run', { allow, block, allowAll: false })).toContain(
      'blocked',
    );
    expect(validateCommand('node script.mjs', { allow, block, allowAll: true })).toContain(
      'blocked',
    );
    expect(validateCommand('node.exe script.mjs', { allow, block, allowAll: true })).toContain(
      'blocked',
    );
  });

  it('rejects environment-variable expansion even when shell operators are allowed', () => {
    const allow = new Set(DEFAULT_ALLOWED_COMMANDS);
    const block = new Set(DEFAULT_BLOCKED_COMMANDS);
    const config = { allow, block, allowAll: false, allowShellOperators: true };

    expect(validateCommand('test -e $SECRET', config)).toContain('environment-variable');
    expect(validateCommand('test -e %SECRET%', config)).toContain('environment-variable');
    expect(validateCommand('test -e !SECRET!', config)).toContain('environment-variable');
  });

  it('executes explicitly allowed commands without a shell', { timeout: 5000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'verification-context-custom-command-'));
    roots.push(root);
    const executable = process.platform === 'win32' ? 'where.exe' : 'printf';
    const command = process.platform === 'win32' ? 'where.exe git' : "printf '%s' 'hello world'";
    const result = await (await context(root, { allowedCommands: [executable] })).runCommand(
      command,
    );

    expect(result.rejected).not.toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(process.platform === 'win32' ? 'git' : 'hello world');
  });

  it('executes non-blocked commands when allowAll is enabled', { timeout: 5000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'verification-context-allow-all-'));
    roots.push(root);
    const command = process.platform === 'win32' ? 'where.exe git' : 'printf allow-all';
    const result = await (await context(root, { allowAll: true })).runCommand(command);

    expect(result.rejected).not.toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it('rejects option-like test patterns before runner invocation', async () => {
    const result = await (await context()).runTest('--config=outside.ts');

    expect(result.failed).toBe(1);
    expect(result.failureOutput).toContain('option prefix');
  });

  it('reports a concrete failure when the selected pattern has no matching tests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verification-context-empty-'));
    roots.push(root);
    await writeFile(join(root, 'package.json'), '{"scripts":{}}\n');

    const result = await (await context(root)).runTest('tests/example.test.ts');

    expect(result.failed).toBe(1);
    expect(result.failureOutput).toBeTruthy();
  });

  it('executes a locally resolved Vitest mjs entry through Node', { timeout: 5000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'verification-context-vitest-'));
    roots.push(root);
    const runnerDir = join(root, 'node_modules', 'vitest');
    const invocationPath = join(root, 'invocation.json');
    const runnerEntry = join(runnerDir, 'vitest.mjs');
    await mkdir(runnerDir, { recursive: true });
    await writeFile(join(root, 'package.json'), '{"scripts":{"test":"vitest"}}\n');
    await writeFile(
      join(runnerDir, 'package.json'),
      '{"name":"vitest","type":"module","bin":{"vitest":"vitest.mjs"}}\n',
    );
    await writeFile(
      runnerEntry,
      [
        "import { writeFileSync } from 'node:fs';",
        `writeFileSync(${JSON.stringify(invocationPath)}, JSON.stringify({ entry: import.meta.url, argv: process.argv.slice(2) }));`,
        "console.log('runner prelude {not json}');",
        "console.log(JSON.stringify({ testResults: [{ name: 'suite', assertionResults: [{ title: 'handles } inside strings' }] }], numPassedTests: 3, numFailedTests: 0, numSkippedTests: 1 }));",
      ].join('\n'),
    );

    const pattern = 'tests/example.test.ts';
    const result = await (await context(root)).runTest(pattern);
    const invocation = JSON.parse(await readFile(invocationPath, 'utf8')) as {
      entry: string;
      argv: string[];
    };

    expect(result).toMatchObject({ passed: 3, failed: 0, skipped: 1 });
    expect(invocation.entry).toBe(pathToFileURL(runnerEntry).href);
    expect(invocation.argv).toEqual(['run', pattern, '--reporter=json']);
  });

  it('accepts counter-only JSON after unrelated objects', { timeout: 5000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'verification-context-counter-json-'));
    roots.push(root);
    const runnerDir = join(root, 'node_modules', 'vitest');
    await mkdir(runnerDir, { recursive: true });
    await writeFile(join(root, 'package.json'), '{"scripts":{"test":"vitest"}}\n');
    await writeFile(
      join(runnerDir, 'package.json'),
      '{"name":"vitest","type":"module","bin":{"vitest":"vitest.mjs"}}\n',
    );
    await writeFile(
      join(runnerDir, 'vitest.mjs'),
      [
        'console.log(JSON.stringify({ unrelated: true }));',
        'console.log(JSON.stringify({ numPassedTests: 4, numFailedTests: 1, numSkippedTests: 2 }));',
        'process.exitCode = 1;',
      ].join('\n'),
    );

    const result = await (await context(root)).runTest('tests/example.test.ts');

    expect(result).toMatchObject({ passed: 4, failed: 1, skipped: 2 });
  });
});

describe('VerificationContext git helpers', () => {
  it('counts untracked files separately from staged files', { timeout: 5000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'verification-context-git-status-'));
    roots.push(root);
    await execFileAsync('git', ['init'], { cwd: root });
    await writeFile(join(root, 'untracked.txt'), 'not staged\n');

    const result = await (await context(root)).gitStatus();

    expect(result).toMatchObject({ clean: false, untracked: 1, unstaged: 0, staged: 0 });
  });

  it('isolates changes made after a dirty worktree snapshot', { timeout: 15_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'verification-context-snapshot-'));
    roots.push(root);
    await execFileAsync('git', ['init'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'Verification Test'], { cwd: root });
    await writeFile(join(root, 'tracked.txt'), 'committed\n');
    await execFileAsync('git', ['add', 'tracked.txt'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'fixture'], { cwd: root });
    await writeFile(join(root, 'tracked.txt'), 'pre-existing dirty state\n');
    await writeFile(join(root, 'before.txt'), 'pre-existing untracked state\n');

    const ctx = await context(root);
    const snapshot = await ctx.captureSnapshot();
    expect(await ctx.diffSince(snapshot)).toEqual([]);

    await writeFile(join(root, 'tracked.txt'), 'changed after snapshot\n');
    await writeFile(join(root, 'after.txt'), 'created after snapshot\n');

    const diff = await ctx.diffSince(snapshot);
    expect(diff).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'tracked.txt', operation: 'modify' }),
        expect.objectContaining({
          path: 'after.txt',
          operation: 'create',
          linesAdded: 1,
          linesRemoved: 0,
        }),
      ]),
    );
    expect(diff.map((entry) => entry.path)).not.toContain('before.txt');
  });
});

describe('VerificationContext filesystem containment', () => {
  it('rejects traversal outside the project root', { timeout: 5000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'verification-context-files-'));
    roots.push(root);
    const ctx = await context(root);

    await expect(ctx.readFile('../outside.txt')).rejects.toThrow('escapes the project root');
    await expect(ctx.fileExists('../outside.txt')).resolves.toBe(false);
    await expect(ctx.fileStat('../outside.txt')).resolves.toEqual({
      exists: false,
      size: 0,
      mtime: '',
    });
  });
});

describe('parseGitNumstat', () => {
  it('preserves exact counts and uses name-status file operations', () => {
    const operations = parseGitNameStatus(
      'M\tsrc/changed.ts\nM\tsrc/truncated.ts\nA\tsrc/created.ts\nD\tsrc/deleted.ts\n',
    );
    expect(
      parseGitNumstat(
        '5\t2\tsrc/changed.ts\n0\t9\tsrc/truncated.ts\n3\t0\tsrc/created.ts\n0\t9\tsrc/deleted.ts\n',
        operations,
      ),
    ).toEqual([
      {
        path: 'src/changed.ts',
        operation: 'modify',
        linesAdded: 5,
        linesRemoved: 2,
      },
      {
        path: 'src/truncated.ts',
        operation: 'modify',
        linesAdded: 0,
        linesRemoved: 9,
      },
      {
        path: 'src/created.ts',
        operation: 'create',
        linesAdded: 3,
        linesRemoved: 0,
      },
      {
        path: 'src/deleted.ts',
        operation: 'delete',
        linesAdded: 0,
        linesRemoved: 9,
      },
    ]);
  });
});
