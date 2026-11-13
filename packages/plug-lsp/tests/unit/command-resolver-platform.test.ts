import { EventEmitter } from 'node:events';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const childProcess = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: childProcess.spawn,
}));

import { resolveCommandOnPath, resolveServerCommand } from '../../src/utils/command-resolver.js';

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { ...originalPlatform, value: platform });
}

/** A `sh -lc 'command -v …'` probe that prints `stdout` and exits with `code`. */
function probeExiting(code: number, stdout: string) {
  return () => {
    const child = new EventEmitter() as EventEmitter & { kill: () => void; stdout: EventEmitter };
    child.kill = vi.fn();
    child.stdout = new EventEmitter();
    queueMicrotask(() => {
      if (stdout) child.stdout.emit('data', stdout);
      child.emit('close', code);
    });
    return child;
  };
}

describe('resolveCommandOnPath on a non-Windows platform', () => {
  beforeEach(() => {
    setPlatform('linux');
    childProcess.spawn.mockReset();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', originalPlatform);
  });

  it('asks the login shell for `command -v` and returns the path it prints', async () => {
    childProcess.spawn.mockImplementation(probeExiting(0, '/usr/local/bin/gopls\n'));

    await expect(resolveCommandOnPath('gopls', 50)).resolves.toBe('/usr/local/bin/gopls');
    expect(childProcess.spawn).toHaveBeenCalledTimes(1);
    expect(childProcess.spawn).toHaveBeenCalledWith(
      'sh',
      ['-lc', "command -v 'gopls'"],
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }),
    );
  });

  it('returns null when the shell reports the command missing', async () => {
    childProcess.spawn.mockImplementation(probeExiting(1, ''));

    await expect(resolveCommandOnPath('definitely-missing', 50)).resolves.toBeNull();
  });

  it('applies the caller filter to the probe output', async () => {
    childProcess.spawn.mockImplementation(probeExiting(0, '/repo/node_modules/.bin/clangd\n'));

    await expect(
      resolveCommandOnPath('clangd', 50, (hit) => !hit.startsWith('/repo/')),
    ).resolves.toBeNull();
  });

  it('auto-discovery refuses a PATH hit that lives inside the opened project', async () => {
    const project = path.resolve('plug-lsp-project-root');
    const inside = path.join(project, 'node_modules', '.bin', 'typescript-language-server');
    childProcess.spawn.mockImplementation(probeExiting(0, `${inside}\n`));

    await expect(resolveServerCommand('typescript-language-server', project)).resolves.toBeNull();
    expect(childProcess.spawn).toHaveBeenCalledWith(
      'sh',
      ['-lc', "command -v 'typescript-language-server'"],
      expect.any(Object),
    );
  });
});

describe('resolveCommandOnPath on Windows', () => {
  beforeEach(() => {
    setPlatform('win32');
    childProcess.spawn.mockReset();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', originalPlatform);
  });

  it('scans PATH directories instead of starting a probe process', async () => {
    await expect(
      resolveCommandOnPath('definitely-missing-wrongstack-command', 50),
    ).resolves.toBeNull();
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });
});
