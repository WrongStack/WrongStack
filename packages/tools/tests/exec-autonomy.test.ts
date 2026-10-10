import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configureExecPolicy, execTool, resetExecPolicy } from '../src/exec.js';
import { validateArgs } from '../src/exec-arg-validation.js';
import { mkSandbox } from './fixtures.js';

afterEach(resetExecPolicy);
describe('exec under host-authorized autonomy', () => {
  it.each(['yolo', 'yolo-plus'] as const)(
    'accepts scoped Git development options under %s',
    async (autonomy) => {
      const sandbox = await mkSandbox();
      const nested = join(sandbox.dir, 'nested');
      await mkdir(join(nested, 'child'), { recursive: true });
      execFileSync('git', ['init', '-q', nested], { windowsHide: true });
      const inputArgs = [
        '-C',
        'nested',
        '-C',
        'child',
        '-c',
        'color.ui=false',
        'status',
        '--short',
      ];
      const opts = { signal: new AbortController().signal, autonomy };
      try {
        await expect(
          execTool.execute({ command: 'git', args: inputArgs }, sandbox.ctx, {
            signal: opts.signal,
          }),
        ).rejects.toThrow('Blocked option');
        const result = await execTool.execute(
          { command: 'git', args: inputArgs },
          sandbox.ctx,
          opts,
        );
        expect(result.exitCode).toBe(0);
        expect(result.args.slice(0, 4)).toEqual(['-C', nested, '-C', join(nested, 'child')]);
        expect(inputArgs[1]).toBe('nested');
        expect(result.danger.level).toBe('safe');
        const config = await execTool.execute(
          {
            command: 'git',
            args: ['-c', 'core.longpaths=true', 'config', '--get', 'core.longpaths'],
          },
          sandbox.ctx,
          opts,
        );
        expect(config.stdout.trim()).toBe('true');
        await expect(
          execTool.execute(
            { command: 'git', args: ['-c', 'core.pager=unexpected-command', 'log'] },
            sandbox.ctx,
            opts,
          ),
        ).rejects.toThrow('Blocked option');
        await expect(
          execTool.execute({ command: 'git', args: ['-C', '..', 'status'] }, sandbox.ctx, opts),
        ).rejects.toThrow(/outside project root/);
      } finally {
        await sandbox.cleanup();
      }
    },
  );
  it('validates the actual Git directory target against filesystem scope', async () => {
    const sandbox = await mkSandbox();
    const outside = await mkdtemp(join(tmpdir(), 'wstack-git-allowed-'));
    const opts = { signal: new AbortController().signal, autonomy: 'yolo-plus' as const };
    try {
      execFileSync('git', ['init', '-q', outside], { windowsHide: true });
      const link = join(sandbox.dir, 'linked');
      await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
      await expect(
        execTool.execute({ command: 'git', args: ['-C', 'linked', 'status'] }, sandbox.ctx, opts),
      ).rejects.toThrow(/outside project root/);
      sandbox.ctx.allowOutsideProjectRoot = true;
      const result = await execTool.execute(
        { command: 'git', args: ['-C', outside, 'status', '--short'] },
        sandbox.ctx,
        opts,
      );
      expect(result.exitCode).toBe(0);
      expect(result.args[1]).toBe(outside);
    } finally {
      await sandbox.cleanup();
      await rm(outside, { recursive: true, force: true });
    }
  });
  it.each(['yolo', 'yolo-plus'] as const)(
    'honors timeout zero under %s while retaining parent cancellation',
    async (autonomy) => {
      const sandbox = await mkSandbox();
      try {
        const completed = await execTool.execute(
          {
            command: process.execPath,
            args: ['-e', "setTimeout(() => console.log('completed'), 40)"],
            timeout: 0,
          },
          sandbox.ctx,
          { signal: new AbortController().signal, autonomy },
        );
        expect(completed.exitCode).toBe(0);
        expect(completed.stdout).toContain('completed');
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 50);
        try {
          const cancelled = await execTool.execute(
            { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], timeout: 0 },
            sandbox.ctx,
            { signal: controller.signal, autonomy },
          );
          expect(cancelled.exitCode).toBe(124);
        } finally {
          clearTimeout(timer);
        }
      } finally {
        await sandbox.cleanup();
      }
    },
  );
  it.each(['yolo', 'yolo-plus'] as const)(
    'runs an explicit executable path under %s and preserves every argument',
    async (autonomy) => {
      const sandbox = await mkSandbox();
      const args = [
        '-e',
        'console.log(JSON.stringify(process.argv.slice(1)))',
        '--',
        ...Array.from({ length: 35 }, (_, index) => `arg ${index}`),
      ];
      try {
        await expect(
          execTool.execute({ command: process.execPath, args }, sandbox.ctx, {
            signal: new AbortController().signal,
          }),
        ).rejects.toThrow('not in allowlist');
        const result = await execTool.execute({ command: process.execPath, args }, sandbox.ctx, {
          signal: new AbortController().signal,
          autonomy,
        });
        expect(result.exitCode).toBe(0);
        expect(result.args).toEqual(args);
        expect(JSON.parse(result.stdout)).toEqual(args.slice(3));
        configureExecPolicy({ deny: [process.execPath] });
        await expect(
          execTool.execute({ command: process.execPath, args }, sandbox.ctx, {
            signal: new AbortController().signal,
            autonomy,
          }),
        ).rejects.toThrow('explicitly denied');
        configureExecPolicy({ deny: [process.versions.bun ? 'bun' : 'node'] });
        await expect(
          execTool.execute({ command: process.execPath, args }, sandbox.ctx, {
            signal: new AbortController().signal,
            autonomy,
          }),
        ).rejects.toThrow('explicitly denied');
      } finally {
        await sandbox.cleanup();
      }
    },
  );
  it('keeps hard argument guards and leaves publish approval to the permission policy in YOLO', () => {
    expect(validateArgs('npm', ['publish'])).toContain('Blocked subcommand');
    expect(validateArgs('pnpm', ['--filter', 'app', '--prod', 'deploy', 'dist'])).toBeNull();
    expect(validateArgs('npm', ['publish'], { allowPublish: true })).toBeNull();
    expect(validateArgs('yarn', ['npm', 'publish'], { allowPublish: true })).toBeNull();
    expect(
      validateArgs('git', ['--upload-pack', 'unexpected-command'], { allowPublish: true }),
    ).toContain('Blocked option');
  });
});
