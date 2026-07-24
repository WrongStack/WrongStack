import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  commandExistsOnPath,
  commandResolverCoverage,
  findLocalBinary,
  resolveServerCommand,
} from '../../src/utils/command-resolver.js';

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

describe('command resolver completion coverage', () => {
  it('resolves absolute, nested local, PATH, and missing commands', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plug-lsp-resolver-'));
    directories.push(root);
    const nested = path.join(root, 'a', 'b');
    const bin = path.join(root, 'node_modules', '.bin');
    await fs.mkdir(nested, { recursive: true });
    await fs.mkdir(bin, { recursive: true });
    const localName = process.platform === 'win32' ? 'local.cmd' : 'local';
    const local = path.join(bin, localName);
    await fs.writeFile(local, '');

    expect(await findLocalBinary(nested, 'local')).toBe(local);
    expect(await findLocalBinary(root, local)).toBe(path.normalize(local));
    expect(await findLocalBinary(root, path.join(root, 'missing'))).toBeNull();
    expect(await findLocalBinary(root, 'missing')).toBeNull();
    expect(await resolveServerCommand('definitely-missing-wrongstack-command', root)).toBeNull();
    expect(await resolveServerCommand(process.execPath, root)).toBe(process.execPath);
    expect(await commandExistsOnPath('definitely-missing-wrongstack-command', 2_000)).toBe(false);
  });

  it('covers platform candidate and shell escaping helpers', async () => {
    expect(commandResolverCoverage.commandCandidates('server.exe')).toEqual(
      process.platform === 'win32' ? ['server.exe'] : ['server.exe'],
    );
    expect(commandResolverCoverage.commandCandidates('server')).toContain('server');
    expect(commandResolverCoverage.commandCandidates('server', 'linux')).toEqual(['server']);
    expect(commandResolverCoverage.commandCandidates('server', 'win32')).toEqual([
      'server.cmd',
      'server.exe',
      'server.bat',
      'server',
      'server.ps1',
    ]);
    expect(commandResolverCoverage.commandCandidates('server.exe', 'win32')).toEqual([
      'server.exe',
    ]);
    expect(commandResolverCoverage.shellQuote("it's")).toBe("'it'\\''s'");
    expect(await commandResolverCoverage.fileExists(process.execPath)).toBe(true);
    expect(await commandResolverCoverage.fileExists(path.join(os.tmpdir(), 'missing'))).toBe(false);
  });

  it('handles successful, failed, errored, and timed out PATH probes', async () => {
    vi.useFakeTimers();
    const makeSpawn = (event?: ['close', number | null] | ['error']) =>
      vi.fn((_probe: string, _args: string[]) => {
        const child = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn> };
        child.kill = vi.fn();
        if (event) {
          queueMicrotask(() => {
            if (event[0] === 'close') child.emit('close', event[1]);
            else child.emit('error');
          });
        }
        return child;
      });

    const success = makeSpawn(['close', 0]);
    await expect(
      commandResolverCoverage.commandProbe("it's", 50, 'linux', success as never),
    ).resolves.toBe(true);
    expect(success).toHaveBeenCalledWith(
      'sh',
      ['-lc', "command -v 'it'\\''s'"],
      expect.any(Object),
    );

    await expect(
      commandResolverCoverage.commandProbe(
        'missing',
        50,
        'win32',
        makeSpawn(['close', 1]) as never,
      ),
    ).resolves.toBe(false);
    await expect(
      commandResolverCoverage.commandProbe('bad', 50, 'win32', makeSpawn(['error']) as never),
    ).resolves.toBe(false);

    const timeoutSpawn = makeSpawn();
    const timed = commandResolverCoverage.commandProbe('slow', 50, 'win32', timeoutSpawn as never);
    await vi.advanceTimersByTimeAsync(50);
    await expect(timed).resolves.toBe(false);
    expect(timeoutSpawn.mock.results[0]?.value.kill).toHaveBeenCalled();
    vi.useRealTimers();
  });
});
