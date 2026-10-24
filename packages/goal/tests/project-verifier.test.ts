import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFile = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFile }));

const { verifyGoalProject } = await import('../src/project-verifier.js');

describe('verifyGoalProject', () => {
  let dir: string;

  beforeEach(async () => {
    execFile.mockReset();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'goal-verifier-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('skips when dependencies are unavailable', async () => {
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ scripts: { typecheck: 'tsc' } }),
    );
    await expect(verifyGoalProject({ cwd: dir })).resolves.toMatchObject({
      ok: true,
      skipped: true,
      output: expect.stringContaining('node_modules'),
    });
    expect(execFile).not.toHaveBeenCalled();
  });

  it('runs only available configured scripts and passes on exit zero', async () => {
    await fs.mkdir(path.join(dir, 'node_modules'));
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ scripts: { typecheck: 'tsc --noEmit' } }),
    );
    execFile.mockImplementation((_command, _args, _options, callback) => {
      callback(null, '', '');
    });

    await expect(verifyGoalProject({ cwd: dir })).resolves.toEqual({ ok: true });
    expect(execFile).toHaveBeenCalledOnce();
    const args = execFile.mock.calls[0]?.[1] as string[];
    expect(args.join(' ')).toContain('typecheck');
    expect(args.join(' ')).not.toContain('lint');
  });

  it('runs the scripts of a package.json saved with a UTF-8 BOM', async () => {
    // A BOM used to read as "no configured scripts" → skipped, which the Goal
    // hosts count as a pass: a failing typecheck was waved through.
    await fs.mkdir(path.join(dir, 'node_modules'));
    await fs.writeFile(
      path.join(dir, 'package.json'),
      `\uFEFF${JSON.stringify({ scripts: { typecheck: 'tsc --noEmit' } })}`,
    );
    execFile.mockImplementation((_command, _args, _options, callback) => {
      callback(new Error('exit 2'), '', 'type error');
    });

    await expect(verifyGoalProject({ cwd: dir })).resolves.toMatchObject({ ok: false });
    expect(execFile).toHaveBeenCalledOnce();
  });

  it('fails (not skips) when package.json is not valid JSON', async () => {
    // An invalid manifest used to read as "no configured scripts" → skipped,
    // which the Goal hosts count as a pass; npm cannot run any script from it.
    await fs.mkdir(path.join(dir, 'node_modules'));
    await fs.writeFile(path.join(dir, 'package.json'), '{ "scripts": { "typecheck": "tsc", }, }');

    await expect(verifyGoalProject({ cwd: dir })).resolves.toMatchObject({
      ok: false,
      output: expect.stringContaining('package.json could not be read'),
    });
    expect(execFile).not.toHaveBeenCalled();
  });

  it('fails closed with subprocess output', async () => {
    await fs.mkdir(path.join(dir, 'node_modules'));
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ scripts: { lint: 'biome check .' } }),
    );
    execFile.mockImplementation((_command, _args, _options, callback) => {
      callback(new Error('exit 1'), '', 'lint failed');
    });

    await expect(verifyGoalProject({ cwd: dir })).resolves.toEqual({
      ok: false,
      output: '[lint] lint failed',
    });
  });
});
