import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the OS-facing calls so we exercise the plugin's logic without a real
// shellcheck binary or filesystem.
const cp = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  execFile: vi.fn(),
  probeFails: { value: false },
}));
vi.mock('node:child_process', async (orig) => ({
  ...(await orig()),
  execFile: cp.execFile,
}));

const fsm = vi.hoisted(() => ({ readdir: vi.fn() }));
vi.mock('node:fs/promises', async (orig) => ({
  ...(await orig()),
  readdir: fsm.readdir,
}));

import shellCheckPlugin from '../src/shell-check';

// The shell-check sandbox resolves every path relative to process.cwd().
// Real tests run in the workspace, so chdir into a temp dir for isolation.
let originalCwd: string;
let tmpRoot: string;
beforeEach(() => {
  vi.clearAllMocks();
  cp.probeFails.value = false;
  cp.execFile.mockImplementation(
    (
      bin: string,
      args: string[],
      options: Record<string, unknown>,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      if (args[0] === '--version') {
        callback(cp.probeFails.value ? new Error('not found') : null, 'ShellCheck 0.9.0', '');
        return {};
      }
      try {
        callback(null, String(cp.execFileSync(bin, args, options) ?? ''), '');
      } catch (error) {
        const e = error as { stdout?: string; stderr?: string };
        callback(error as Error, e.stdout ?? '', e.stderr ?? '');
      }
      return {};
    },
  );
  originalCwd = process.cwd();
  tmpRoot = mkdtempSync(join(tmpdir(), 'shellcheck-'));
  mkdirSync(join(tmpRoot, 'sub'), { recursive: true });
  process.chdir(tmpRoot);
});
afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tmpRoot, { recursive: true, force: true });
});

interface Tool {
  name: string;
  execute: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

function setup(): {
  tools: Record<string, Tool>;
  metrics: { counter: ReturnType<typeof vi.fn>; histogram: ReturnType<typeof vi.fn> };
} {
  const tools: Record<string, Tool> = {};
  const metrics = { counter: vi.fn(), histogram: vi.fn(), gauge: vi.fn() };
  const api = {
    tools: {
      register: (t: Tool) => {
        tools[t.name] = t;
      },
    },
    config: { extensions: {} },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metrics,
    pipelines: { response: { use: vi.fn(), get: vi.fn() } },
  };
  shellCheckPlugin.setup(api as never);
  return { tools, metrics };
}

const issue = (over: Partial<Record<string, unknown>> = {}) => ({
  file: 'a.sh',
  line: 1,
  column: 1,
  level: 'warning',
  code: 'SC2086',
  message: 'quote it',
  ...over,
});
const dirent = (name: string, isDir: boolean) => ({
  name,
  isDirectory: () => isDir,
  isFile: () => !isDir,
});

describe('shellcheck tool execute', () => {
  it('returns a structured summary and groups issues by file', async () => {
    cp.execFileSync.mockReturnValue(
      JSON.stringify([
        issue({ file: 'a.sh', level: 'error', code: 'SC1000' }),
        issue({ file: 'a.sh', level: 'warning' }),
        issue({ file: 'b.sh', level: 'info' }),
        issue({ file: 'b.sh', level: 'style' }),
      ]),
    );
    const { tools, metrics } = setup();
    const res = await tools.shellcheck!.execute({ files: ['a.sh', 'b.sh'], severity: 'info' });

    expect(res.ok).toBe(true);
    expect(res.filesScanned).toBe(2);
    expect(res.summary).toEqual({ total: 4, errors: 1, warnings: 1, info: 1, style: 1 });
    expect(Object.keys(res.byFile as object)).toEqual(['a.sh', 'b.sh']);
    expect(res.recommendation).toMatch(/Fix errors/);
    expect(metrics.counter).toHaveBeenCalledWith('issues_found', 4, { severity: 'info' });
    expect(metrics.histogram).toHaveBeenCalled();
  });

  it('recommends reviewing warnings when there are warnings but no errors', async () => {
    cp.execFileSync.mockReturnValue(JSON.stringify([issue({ level: 'warning' })]));
    const { tools } = setup();
    const res = await tools.shellcheck!.execute({ files: ['a.sh'] });
    expect(res.recommendation).toMatch(/Review and fix warnings/);
  });

  it('reports no issues for a clean run', async () => {
    cp.execFileSync.mockReturnValue('[]');
    const { tools } = setup();
    const res = await tools.shellcheck!.execute({ files: ['a.sh'] });
    expect(res.summary).toMatchObject({ total: 0 });
    expect(res.recommendation).toBe('No issues found.');
  });

  it('throws when shellcheck is not installed', async () => {
    cp.probeFails.value = true;
    const { tools } = setup();
    await expect(tools.shellcheck!.execute({ files: ['a.sh'] })).rejects.toThrow(/not installed/);
  });

  it('continues when the async PATH probe resolves', async () => {
    cp.execFileSync.mockReturnValue('[]');
    const { tools } = setup();
    const res = await tools.shellcheck!.execute({ files: ['a.sh'] });
    expect(res.ok).toBe(true);
    expect(cp.execFile).toHaveBeenCalledWith(
      'shellcheck',
      ['--version'],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it('treats a non-zero exit carrying issue JSON on stderr as findings', async () => {
    cp.execFileSync.mockImplementation(() => {
      throw { stderr: JSON.stringify([issue({ level: 'error', code: 'SC2154' })]) };
    });
    const { tools } = setup();
    const res = await tools.shellcheck!.execute({ files: ['a.sh'] });
    expect(res.ok).toBe(true);
    expect((res.summary as { errors: number }).errors).toBe(1);
  });

  it('throws when shellcheck reports a non-JSON error instead of findings', async () => {
    // e.g. `a.sh: openBinaryFile: does not exist` — used to read as "No issues found."
    cp.execFileSync.mockImplementation(() => {
      throw { stderr: 'shellcheck: fatal' };
    });
    const { tools } = setup();
    await expect(tools.shellcheck!.execute({ files: ['a.sh'] })).rejects.toThrow(
      /unparseable output: shellcheck: fatal/,
    );
  });

  it('throws when shellcheck fails with no output at all', async () => {
    cp.execFileSync.mockImplementation(() => {
      throw Object.assign(new Error('timed out'), { stdout: '', stderr: '' });
    });
    const { tools } = setup();
    await expect(tools.shellcheck!.execute({ files: ['a.sh'] })).rejects.toThrow(
      /failed without output: timed out/,
    );
  });

  it('returns no issues when output is blank', async () => {
    cp.execFileSync.mockReturnValue('   ');
    const { tools } = setup();
    const res = await tools.shellcheck!.execute({ files: ['a.sh'] });
    expect(res.summary).toMatchObject({ total: 0 });
  });

  it('throws when output is not valid JSON', async () => {
    cp.execFileSync.mockReturnValue('not json at all');
    const { tools } = setup();
    await expect(tools.shellcheck!.execute({ files: ['a.sh'] })).rejects.toThrow(
      /unparseable output/,
    );
  });

  it('defaults severity to warning when omitted', async () => {
    cp.execFileSync.mockReturnValue('[]');
    const { tools, metrics } = setup();
    await tools.shellcheck!.execute({ files: ['a.sh'] });
    expect(metrics.counter).toHaveBeenCalledWith('issues_found', 0, { severity: 'warning' });
  });
});

describe('shellcheck tool — directory scan mode (merged from shellcheck_scan)', () => {
  it('returns early when no shell files are found in directory', async () => {
    fsm.readdir.mockResolvedValue([dirent('readme.md', false)]);
    const { tools } = setup();
    const res = await tools.shellcheck!.execute({ directory: '.' });
    expect(res).toMatchObject({
      ok: true,
      filesScanned: 0,
      summary: { total: 0 },
      mode: 'directory',
    });
  });

  it('scans found files recursively, skipping node_modules and .git', async () => {
    fsm.readdir.mockImplementation(async (dir: string) => {
      if (dir === tmpRoot) {
        return [
          dirent('sub', true),
          dirent('node_modules', true),
          dirent('.git', true),
          dirent('top.sh', false),
          dirent('Dockerfile', false),
          dirent('prompt.zsh', false),
          dirent('notes.txt', false),
        ];
      }
      if (dir === join(tmpRoot, 'sub')) return [dirent('nested.sh', false)];
      return [];
    });
    cp.execFileSync.mockReturnValue(
      JSON.stringify([
        issue({ file: 'top.sh', level: 'error' }),
        issue({ file: 'top.sh', level: 'warning' }),
        issue({ file: 'nested.sh', level: 'warning' }),
      ]),
    );
    const { tools } = setup();
    const res = await tools.shellcheck!.execute({ directory: tmpRoot });
    expect(res.ok).toBe(true);
    expect(res.mode).toBe('directory');
    // top.sh, nested.sh (node_modules/.git skipped; notes.txt, and the Dockerfile
    // and zsh file shellcheck cannot parse, are not handed to it)
    expect(res.filesScanned).toBe(2);
    expect(res.filesWithIssues).toBe(2);
    expect(res.summary as { errors: number; warnings: number }).toMatchObject({
      total: 3,
      errors: 1,
      warnings: 2,
    });
  });

  it('filters by filename pattern in directory mode', async () => {
    fsm.readdir.mockResolvedValue([dirent('build.sh', false), dirent('deploy.sh', false)]);
    cp.execFileSync.mockReturnValue('[]');
    const { tools } = setup();
    const res = await tools.shellcheck!.execute({ directory: tmpRoot, pattern: 'deploy' });
    expect(res.filesScanned).toBe(1);
  });

  it('throws when the scan root cannot be read', async () => {
    fsm.readdir.mockImplementation(async () => {
      throw new Error('ENOENT');
    });
    const { tools } = setup();
    await expect(tools.shellcheck!.execute({ directory: 'missing' })).rejects.toThrow(
      /directory does not exist or cannot be read: missing/,
    );
  });

  it('skips unreadable subdirectories', async () => {
    fsm.readdir.mockImplementation(async (dir: string) => {
      if (dir === tmpRoot) return [dirent('locked', true)];
      throw new Error('EACCES');
    });
    const { tools } = setup();
    const res = await tools.shellcheck!.execute({ directory: tmpRoot });
    expect(res).toMatchObject({ ok: true, filesScanned: 0 });
  });

  it('throws when shellcheck fails during a directory scan', async () => {
    fsm.readdir.mockResolvedValue([dirent('a.sh', false)]);
    cp.probeFails.value = true;
    const { tools } = setup();
    await expect(tools.shellcheck!.execute({ directory: tmpRoot })).rejects.toThrow(
      /not installed/,
    );
  });

  it('defaults directory to "." when omitted', async () => {
    fsm.readdir.mockResolvedValue([]);
    const { tools } = setup();
    const res = await tools.shellcheck!.execute({});
    expect(res).toMatchObject({ ok: true, filesScanned: 0 });
    expect(fsm.readdir).toHaveBeenCalledWith('.', expect.anything());
  });

  it('files mode takes precedence over directory mode', async () => {
    fsm.readdir.mockResolvedValue([dirent('other.sh', false)]);
    cp.execFileSync.mockReturnValue('[]');
    const { tools } = setup();
    const res = await tools.shellcheck!.execute({ files: ['a.sh'], directory: tmpRoot });
    expect(res.mode).toBe('files');
    expect(fsm.readdir).not.toHaveBeenCalled();
  });

  it('rejects directory paths outside the project root', async () => {
    const { tools } = setup();
    const outside = process.platform === 'win32' ? 'C:\\Windows\\System32' : '/etc';
    await expect(tools.shellcheck!.execute({ directory: outside })).rejects.toThrow(
      /outside the project root/,
    );
    expect(cp.execFileSync).not.toHaveBeenCalled();
  });

  it('rejects file paths outside the project root', async () => {
    const { tools } = setup();
    const outside = process.platform === 'win32' ? 'C:\\Windows\\System32\\evil.sh' : '/etc/passwd';
    await expect(tools.shellcheck!.execute({ files: [outside] })).rejects.toThrow(
      /outside the project root/,
    );
    expect(cp.execFileSync).not.toHaveBeenCalled();
  });

  it('rejects paths that traverse out of the project root', async () => {
    const { tools } = setup();
    // `..` from cwd = just inside; double `..` lands at os.tmpdir() parent
    // which is outside the chdir'd tmpRoot sandbox.
    const escapedPath = join(tmpRoot, '..', '..', 'escape.sh');
    await expect(tools.shellcheck!.execute({ files: [escapedPath] })).rejects.toThrow(
      /outside the project root/,
    );
    expect(cp.execFileSync).not.toHaveBeenCalled();
  });

  it('honors configured extension severity and ignoredCodes', async () => {
    cp.execFileSync.mockReturnValue(
      JSON.stringify([
        issue({ file: 'a.sh', level: 'error', code: 'SC2086' }),
        issue({ file: 'a.sh', level: 'error', code: 'SC2034' }),
      ]),
    );
    const tools: Record<string, Tool> = {};
    const api = {
      tools: {
        register: (t: Tool) => {
          tools[t.name] = t;
        },
      },
      config: {
        extensions: {
          'shell-check': {
            severity: 'error',
            ignoredCodes: ['SC2086'],
          },
        },
      },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      metrics: { counter: vi.fn(), histogram: vi.fn(), gauge: vi.fn() },
      pipelines: { response: { use: vi.fn(), get: vi.fn() } },
    };
    shellCheckPlugin.setup(api as never);
    const res = await tools.shellcheck!.execute({ files: ['a.sh'] });
    expect(cp.execFileSync).toHaveBeenCalledWith(
      'shellcheck',
      expect.arrayContaining(['-S', 'error']),
      expect.anything(),
    );
    expect((res.issues as Array<{ code: string }>).map((i) => i.code)).toEqual(['SC2034']);
  });

  it('rejects symlinks/junctions escaping outside the project root and passes -- before filenames (F36)', async () => {
    const fs = await import('node:fs');
    const outsideDir = mkdtempSync(join(tmpdir(), 'shellcheck-outside-'));
    try {
      fs.writeFileSync(join(outsideDir, 'secret.sh'), '#!/bin/sh\necho secret\n', 'utf8');
      fs.symlinkSync(
        outsideDir,
        join(tmpRoot, 'outside-link'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      const { tools } = setup();
      await expect(tools.shellcheck!.execute({ directory: 'outside-link' })).rejects.toThrow(
        /outside the project root/,
      );
      await expect(
        tools.shellcheck!.execute({ files: ['outside-link/secret.sh'] }),
      ).rejects.toThrow(/outside the project root/);

      cp.execFileSync.mockReturnValue('[]');
      await tools.shellcheck!.execute({ files: ['sub/ok.sh'] });
      expect(cp.execFileSync).toHaveBeenCalledWith(
        'shellcheck',
        ['-f', 'json', '-S', 'warning', '--', 'sub/ok.sh'],
        expect.anything(),
      );
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});
