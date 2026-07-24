import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveServerCommand: vi.fn(),
  commandExistsOnPath: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock('../../src/utils/command-resolver.js', () => ({
  resolveServerCommand: mocks.resolveServerCommand,
  commandExistsOnPath: mocks.commandExistsOnPath,
}));

vi.mock('node:child_process', () => ({
  spawn: mocks.spawn,
}));

import {
  installLang,
  LANGUAGE_SERVERS,
  SUPPORTED_LANGUAGES,
} from '../../src/slash-commands/install.js';

const tempDirectories: string[] = [];

afterEach(async () => {
  vi.resetAllMocks();
  for (const directory of tempDirectories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

async function tempDir(lockFile?: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'plug-lsp-install-'));
  tempDirectories.push(directory);
  if (lockFile) await fs.writeFile(path.join(directory, lockFile), '');
  return directory;
}

function nextChild(outcome: number | null | 'error' | 'string-error'): void {
  mocks.spawn.mockImplementationOnce(() => {
    const child = new EventEmitter();
    queueMicrotask(() => {
      if (outcome === 'error') child.emit('error', new Error('spawn failed'));
      else if (outcome === 'string-error') child.emit('error', 'spawn failed');
      else child.emit('close', outcome);
    });
    return child;
  });
}

describe('language-server installer completion coverage', () => {
  it('exports the complete language catalog and short-circuits installed binaries', async () => {
    expect(SUPPORTED_LANGUAGES).toEqual(expect.arrayContaining(['typescript', 'go', 'rust']));
    mocks.resolveServerCommand.mockResolvedValue('/bin/server');
    await expect(
      installLang('custom', { binary: 'server', languages: ['custom'] }, process.cwd()),
    ).resolves.toEqual({
      language: 'custom',
      binary: 'server',
      alreadyInstalled: true,
      dryRun: false,
    });
  });

  it('reports missing toolchains, dry-runs them, and executes success/failure exits', async () => {
    mocks.resolveServerCommand.mockResolvedValue(null);
    mocks.commandExistsOnPath.mockResolvedValueOnce(false);
    await expect(
      installLang('go', LANGUAGE_SERVERS.go!, process.cwd(), true),
    ).resolves.toMatchObject({
      alreadyInstalled: false,
      dryRun: true,
      error: expect.stringContaining('not on your PATH'),
    });

    mocks.commandExistsOnPath.mockResolvedValueOnce(true);
    await expect(
      installLang('go', LANGUAGE_SERVERS.go!, process.cwd(), true),
    ).resolves.toMatchObject({
      dryRun: true,
      installCommand: expect.stringContaining('go install'),
    });

    mocks.commandExistsOnPath.mockResolvedValueOnce(true);
    nextChild(0);
    await expect(installLang('go', LANGUAGE_SERVERS.go!, process.cwd())).resolves.toMatchObject({
      dryRun: false,
      packageManager: 'system',
    });

    mocks.commandExistsOnPath.mockResolvedValueOnce(true);
    nextChild(7);
    await expect(installLang('go', LANGUAGE_SERVERS.go!, process.cwd())).rejects.toThrow('code 7');
  });

  it('builds every package-manager command and handles npm spawn failures', async () => {
    mocks.resolveServerCommand.mockResolvedValue(null);
    const cases = [
      ['pnpm-lock.yaml', 'pnpm'],
      ['yarn.lock', 'yarn'],
      ['bun.lockb', 'bun'],
      ['bun.lock', 'bun'],
      [undefined, 'npm'],
    ] as const;
    for (const [lock, expected] of cases) {
      const directory = await tempDir(lock);
      await expect(
        installLang('typescript', LANGUAGE_SERVERS.typescript!, directory, true),
      ).resolves.toMatchObject({
        dryRun: true,
        installCommand: expect.stringMatching(new RegExp(`^${expected} `)),
      });
    }

    const directory = await tempDir();
    nextChild(0);
    await expect(
      installLang('typescript', LANGUAGE_SERVERS.typescript!, directory),
    ).resolves.toMatchObject({ dryRun: false, alreadyInstalled: false });

    nextChild('error');
    await expect(
      installLang('typescript', LANGUAGE_SERVERS.typescript!, directory),
    ).resolves.toMatchObject({ error: 'spawn failed' });

    nextChild('string-error');
    await expect(
      installLang('typescript', LANGUAGE_SERVERS.typescript!, directory),
    ).resolves.toMatchObject({ error: 'spawn failed' });

    nextChild(null);
    await expect(
      installLang('typescript', LANGUAGE_SERVERS.typescript!, directory),
    ).resolves.toMatchObject({ error: expect.stringContaining('code null') });
  });

  it('reports servers without an installation method', async () => {
    mocks.resolveServerCommand.mockResolvedValue(null);
    await expect(
      installLang(
        'custom',
        {
          binary: 'custom-server',
          npmPackages: [],
          languages: ['custom'],
        },
        process.cwd(),
      ),
    ).resolves.toMatchObject({
      alreadyInstalled: false,
      dryRun: false,
      error: 'No installation method available for this server.',
    });
  });
});
