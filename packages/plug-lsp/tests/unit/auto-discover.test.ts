import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { autoDiscoverServers } from '../../src/auto-discover.js';
import { resolveServerCommand } from '../../src/utils/command-resolver.js';

async function writeFakeBinary(root: string, name: string): Promise<string> {
  const binDir = path.join(root, 'node_modules', '.bin');
  await fs.mkdir(binDir, { recursive: true });
  const command =
    process.platform === 'win32' ? path.join(binDir, `${name}.cmd`) : path.join(binDir, name);
  await fs.writeFile(command, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n');
  return command;
}

/**
 * Run `fn` with PATH set to `value`.
 *
 * Several preset commands (`gopls`, `clangd`, `pyright-langserver`, …) are real
 * tools that may be installed on the machine running the suite, which would
 * otherwise decide these assertions. Emptying PATH makes the planted file the
 * only thing that *could* be adopted, so a pass means the gate held.
 */
async function withPath<T>(value: string, fn: () => Promise<T>): Promise<T> {
  const saved = process.env['PATH'];
  process.env['PATH'] = value;
  try {
    return await fn();
  } finally {
    process.env['PATH'] = saved;
  }
}

describe('autoDiscoverServers', () => {
  /**
   * WS-SEC-01 regression. Auto-discovery runs unattended on session start and
   * the server it picks is spawned with no confirmation prompt, so adopting a
   * binary out of the opened repository is arbitrary code execution on repo
   * open: commit `node_modules/.bin/typescript-language-server`, wait for the
   * agent to edit one file.
   *
   * This test previously asserted the OPPOSITE — that the project-local binary
   * *was* adopted — which is how the behaviour survived review.
   */
  it('does not adopt a project-local binary', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plug-lsp-bin-'));
    await writeFakeBinary(root, 'typescript-language-server');

    const servers = await withPath('', () => autoDiscoverServers({}, root));

    expect(servers.typescript).toBeUndefined();
  });

  /**
   * `npm run` / `pnpm run` / `npx` prepend `<project>/node_modules/.bin` to
   * PATH, so a PATH-only rule still adopts a repo-supplied binary when wstack
   * is launched through a package script inside the hostile repo. Provenance
   * is decided by where the file lives, not by which lookup found it.
   */
  it('does not adopt a project-local binary injected onto PATH', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plug-lsp-path-'));
    const planted = await writeFakeBinary(root, 'gopls');

    const resolved = await withPath(path.dirname(planted), () =>
      resolveServerCommand('gopls', root),
    );

    expect(resolved).toBeNull();
  });

  it('tells the user about a project-local binary it declined to adopt', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plug-lsp-bin-'));
    await writeFakeBinary(root, 'gopls');
    const messages: string[] = [];

    await withPath('', () =>
      autoDiscoverServers({}, root, (message) => {
        messages.push(message);
      }),
    );

    // The legitimate half of the surface — a devDependency language server —
    // must stay discoverable rather than silently not starting.
    const notice = messages.find((m) => m.includes('gopls'));
    expect(notice).toBeDefined();
    expect(notice).toContain('/lsp setup');
  });

  it('does not notify when no project-local preset exists', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plug-lsp-empty-bin-'));
    const messages: string[] = [];

    await withPath('', () => autoDiscoverServers({}, root, (message) => messages.push(message)));

    expect(messages).toEqual([]);
  });

  it('keeps user configured servers instead of overwriting presets', async () => {
    const servers = await autoDiscoverServers(
      {
        typescript: {
          command: 'custom-ts',
          languages: ['typescript'],
        },
      },
      process.cwd(),
    );
    expect(servers.typescript?.command).toBe('custom-ts');
  });
});

describe('resolveServerCommand project-local gate', () => {
  it('ignores node_modules/.bin unless the caller opts in', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plug-lsp-gate-'));
    const planted = await writeFakeBinary(root, 'wrongstack-fake-langserver');

    expect(await resolveServerCommand('wrongstack-fake-langserver', root)).toBeNull();
    expect(
      await resolveServerCommand('wrongstack-fake-langserver', root, { allowProjectLocal: false }),
    ).toBeNull();
    // User-present paths (`/lsp setup`, `/lsp install`, `/lsp`) opt in explicitly.
    expect(
      await resolveServerCommand('wrongstack-fake-langserver', root, { allowProjectLocal: true }),
    ).toBe(planted);
  });
});
