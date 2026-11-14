import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

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

  /** Point PATH at stub executables so toolchain resolution is hermetic. */
  async function stubToolchains(...names: string[]): Promise<void> {
    const bin = path.join(dir, '.bin');
    await fs.mkdir(bin, { recursive: true });
    for (const name of names) {
      await fs.writeFile(path.join(bin, name), '');
      await fs.writeFile(path.join(bin, `${name}.exe`), '');
    }
    const saved = process.env['PATH'];
    process.env['PATH'] = bin;
    onTestFinished(() => {
      process.env['PATH'] = saved;
    });
  }

  // Through the win32 cmd.exe shim a missing toolchain never raised ENOENT: it
  // exited 1 "is not recognized" and the Goal counted a failed verification.
  it('reports a missing toolchain as skipped, preflighting the Windows shell shim', async () => {
    await stubToolchains();
    execFile.mockImplementation((_command, _args, _options, callback) => {
      callback(Object.assign(new Error('missing toolchain'), { code: 'ENOENT' }), '', '');
    });
    await fs.writeFile(path.join(dir, 'pubspec.yaml'), 'name: demo');
    await expect(verifyGoalProject({ cwd: dir })).resolves.toMatchObject({
      ok: true,
      skipped: true,
    });
    if (process.platform === 'win32') expect(execFile).not.toHaveBeenCalled();
    else expect(execFile).toHaveBeenCalledOnce();
  });

  it('verifies Rust (Cargo.toml) and Go (go.mod) projects when package.json is absent', async () => {
    await stubToolchains('cargo', 'go', 'ruff');
    await fs.writeFile(path.join(dir, 'Cargo.toml'), '[package]\nname = "demo"');
    execFile.mockImplementation((_command, _args, _options, callback) => {
      callback(null, '', '');
    });

    await expect(verifyGoalProject({ cwd: dir })).resolves.toEqual({ ok: true });
    expect(execFile).toHaveBeenCalledOnce();
    const cargoArgs = execFile.mock.calls[0]?.[1] as string[];
    expect(cargoArgs.join(' ')).toContain('check');

    await fs.rm(path.join(dir, 'Cargo.toml'));
    execFile.mockReset();
    await fs.writeFile(path.join(dir, 'go.mod'), 'module example.com/demo');
    execFile.mockImplementation((_command, _args, _options, callback) => {
      callback(new Error('exit 1'), '', 'vet error');
    });

    await expect(verifyGoalProject({ cwd: dir })).resolves.toEqual({
      ok: false,
      output: '[go vet] vet error',
    });

    await fs.rm(path.join(dir, 'go.mod'));
    execFile.mockReset();
    await fs.writeFile(path.join(dir, 'pyproject.toml'), '[project]\nname = "demo"');
    execFile.mockImplementation((_command, _args, _options, callback) => {
      callback(null, '', '');
    });

    await expect(verifyGoalProject({ cwd: dir })).resolves.toEqual({ ok: true });
    expect(execFile).toHaveBeenCalledOnce();
    const ruffArgs = execFile.mock.calls[0]?.[1] as string[];
    expect(ruffArgs.join(' ')).toContain('check');
  });

  it('reads and runs scripts from projectRoot when cwd is a subdirectory without package.json', async () => {
    const subDir = path.join(dir, 'src');
    await fs.mkdir(subDir, { recursive: true });
    await fs.mkdir(path.join(dir, 'node_modules'));
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ scripts: { typecheck: 'tsc --noEmit' } }),
    );
    execFile.mockImplementation((_command, _args, _options, callback) => {
      callback(new Error('exit 1'), '', 'root typecheck error');
    });

    await expect(verifyGoalProject({ cwd: subDir, projectRoot: dir })).resolves.toEqual({
      ok: false,
      output: '[typecheck] root typecheck error',
    });
    expect(execFile).toHaveBeenCalledOnce();
  });

  it('ignores Object.prototype script keys in steps (F253)', async () => {
    await fs.mkdir(path.join(dir, 'node_modules'));
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ scripts: { typecheck: 'tsc --noEmit' } }),
    );
    await expect(
      verifyGoalProject({ cwd: dir, steps: ['toString', 'constructor', 'valueOf'] }),
    ).resolves.toEqual({
      ok: true,
      skipped: true,
      output: 'verify skipped: no configured scripts',
    });
    expect(execFile).not.toHaveBeenCalled();
  });

  it('keeps explicitly empty scripts disabled', async () => {
    execFile.mockImplementation((_command, _args, _options, callback) => {
      callback(null, '', '');
    });
    await fs.mkdir(path.join(dir, 'node_modules'));
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ scripts: { typecheck: '', lint: '' } }),
    );
    await expect(verifyGoalProject({ cwd: dir })).resolves.toEqual({
      ok: true,
      skipped: true,
      output: 'verify skipped: no configured scripts',
    });
    expect(execFile).not.toHaveBeenCalled();
  });
});
